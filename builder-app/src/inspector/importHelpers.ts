import { parse } from '@babel/parser'
import type { AstNode, BareModuleUsage } from './types'

export function extractImports(source: string): string[] {
  const lines = source.split('\n')
  const result: string[] = []
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    for (const node of (ast.program as unknown as { body: AstNode[] }).body) {
      if (node.type === 'ImportDeclaration' && node.loc) {
        const s = node.loc.start.line - 1
        const e = node.loc.end.line - 1
        result.push(lines.slice(s, e + 1).join('\n'))
      }
    }
  } catch {
    for (const ln of lines) {
      if (/^import\s/.test(ln.trim())) result.push(ln)
    }
  }
  return result
}

export function countReactComponentsInSource(source: string): number {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body
    const names = new Set<string>()
    for (const node of body) {
      if (node.type === 'FunctionDeclaration') {
        const name = (node as AstNode & { id?: { name?: string } }).id?.name
        if (name && /^[A-Z]/.test(name)) names.add(name)
      }
      if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') {
        const decl = (node as AstNode & { declaration?: AstNode }).declaration
        if (decl?.type === 'FunctionDeclaration') {
          const name = (decl as AstNode & { id?: { name?: string } }).id?.name
          if (name && /^[A-Z]/.test(name)) names.add(name)
        }
        if (decl?.type === 'VariableDeclaration') {
          for (const d of ((decl as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
            const id = (d as AstNode & { id?: { name?: string } }).id
            const init = (d as AstNode & { init?: AstNode }).init
            if (id?.name && /^[A-Z]/.test(id.name) &&
                init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
              names.add(id.name)
            }
          }
        }
      }
      if (node.type === 'VariableDeclaration') {
        for (const d of ((node as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
          const id = (d as AstNode & { id?: { name?: string } }).id
          const init = (d as AstNode & { init?: AstNode }).init
          if (id?.name && /^[A-Z]/.test(id.name) &&
              init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
            names.add(id.name)
          }
        }
      }
    }
    return names.size
  } catch {
    return 0
  }
}

export function collectModuleUsages(source: string, usage: Map<string, BareModuleUsage>): string[] {
  const relativeImports: string[] = []
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body

    for (const node of body) {
      if (node.type !== 'ImportDeclaration') continue
      const sourceNode = node.source as AstNode & { value?: string }
      const specifier = typeof sourceNode?.value === 'string' ? sourceNode.value : ''
      if (!specifier) continue

      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        relativeImports.push(specifier)
        continue
      }

      const existing = usage.get(specifier) ?? { hasDefault: false, hasNamespace: false, named: new Set<string>() }
      const specs = (node.specifiers as AstNode[] | undefined) ?? []
      for (const s of specs) {
        if (s.type === 'ImportDefaultSpecifier') existing.hasDefault = true
        if (s.type === 'ImportNamespaceSpecifier') existing.hasNamespace = true
        if (s.type === 'ImportSpecifier') {
          const imported = (s.imported as AstNode & { name?: string } | undefined)?.name
          if (imported) existing.named.add(imported)
        }
      }
      usage.set(specifier, existing)
    }
  } catch {
    return relativeImports
  }

  return relativeImports
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

export function dirname(path: string): string {
  const normalized = normalizePath(path)
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(0, idx) : normalized
}

export function resolveRelativePath(fromDir: string, specifier: string): string {
  const stack = fromDir.split('/')
  for (const seg of specifier.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (stack.length > 1) stack.pop()
      continue
    }
    stack.push(seg)
  }
  return stack.join('/')
}

export function candidateImportFiles(fromFile: string, specifier: string): string[] {
  const resolved = resolveRelativePath(dirname(fromFile), specifier)
  if (/\.(tsx?|jsx?|mjs|cjs|css|scss|sass|less)$/.test(resolved)) return [resolved]

  return [
    `${resolved}.ts`,
    `${resolved}.tsx`,
    `${resolved}.js`,
    `${resolved}.jsx`,
    `${resolved}/index.ts`,
    `${resolved}/index.tsx`,
    `${resolved}/index.js`,
    `${resolved}/index.jsx`,
    `${resolved}.css`,
    `${resolved}.scss`,
  ]
}

export function filePathToModelUri(filePath: string): string {
  return `file:///${normalizePath(filePath)}`
}

export function buildBareModuleDeclarations(usage: Map<string, BareModuleUsage>): string {
  const lines: string[] = [
    "declare module '*.css' { const value: any; export default value }",
    "declare module '*.scss' { const value: any; export default value }",
    "declare module '*.sass' { const value: any; export default value }",
    "declare module '*.less' { const value: any; export default value }",
  ]

  if (usage.has('react')) {
    lines.push(
      "declare module 'react' {",
      '  export type SetStateAction<S> = S | ((prevState: S) => S);',
      '  export type Dispatch<A> = (value: A) => void;',
      '  export function useState<S>(initialState: S | (() => S)): [S, Dispatch<SetStateAction<S>>];',
      '  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;',
      '  export function useRef<T>(initialValue: T): { current: T };',
      '  export interface FormEvent<T = Element> { preventDefault(): void; target: T; }',
      '  export as namespace React;',
      '  export namespace React {',
      '    export type FormEvent<T = Element> = import(\'react\').FormEvent<T>;',
      '  }',
      '  const React: { useState: typeof useState; useEffect: typeof useEffect; useRef: typeof useRef };',
      '  export default React;',
      '}'
    )
  }

  if (usage.has('react/jsx-runtime')) {
    lines.push(
      "declare module 'react/jsx-runtime' {",
      '  export const Fragment: any;',
      '  export function jsx(type: any, props: any, key?: any): any;',
      '  export function jsxs(type: any, props: any, key?: any): any;',
      '}'
    )
  }

  if (usage.has('react-dom') || usage.has('react-dom/client')) {
    lines.push(
      "declare module 'react-dom/client' {",
      '  export function createRoot(container: Element | DocumentFragment): { render(children: any): void };',
      '}'
    )
  }

  for (const [moduleName, u] of usage) {
    if (moduleName === 'react' || moduleName === 'react/jsx-runtime' || moduleName === 'react-dom/client') {
      continue
    }
    lines.push(`declare module '${moduleName}' {`)
    if (u.hasDefault) lines.push('  const _default: any; export default _default;')
    for (const n of Array.from(u.named).sort()) {
      lines.push(`  export const ${n}: any;`)
    }
    if (u.hasNamespace && !u.hasDefault && u.named.size === 0) {
      lines.push('  export const __namespace: any;')
    }
    if (!u.hasDefault && u.named.size === 0 && !u.hasNamespace) {
      lines.push('  export {}')
    }
    lines.push('}')
  }

  return `${lines.join('\n')}\n`
}
