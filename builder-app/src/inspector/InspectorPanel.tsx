import { useEffect, useRef, useState } from 'react'
import Editor, { type Monaco } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import type { IDisposable } from 'monaco-editor'
import { parse } from '@babel/parser'

interface ServerDiagnostic {
  code: number
  message: string
  severity: number
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

// ── selected-node context (passed in from DOMTreePanel after selection) ───────

export interface SelectedNodeContext {
  tag: string
  locatorId: string | null
  locatorFile: string | null
  locatorLine: number | null
  ownerComponentName: string | null
  domAttributes: Array<{ name: string; value: string }>
}

// An attribute row parsed from JSX source AST.
interface JsxAttr {
  name: string
  /** Stringified representation of the value as it appears in source. */
  rawValue: string
  /** True when value is already a JSX expression binding, e.g. {foo}. */
  isExpression: boolean
  /** True for boolean shorthand attributes, e.g. `disabled`. */
  isBoolean: boolean
  /** True for spread attributes — shown read-only. */
  isSpread: boolean
  /** 0-indexed line in the FULL file where this attribute starts. */
  startLine: number
}

// A prop available in the owning component signature.
export interface ComponentProp {
  name: string
  typeStr: string
  /** Default value from destructure, e.g. `type = 'text'` → `'text'`. */
  defaultValue?: string
  /** Where this prop originated — for visual badge in dropdown. */
  source: 'owner' | 'element'
}

/** One named variable in a component scope (prop or state/local). */
interface ScopeItem {
  name: string
  typeStr: string
  /** True when this item is actually used by the currently selected node's JSX. */
  usedInNode: boolean
}

/** One level of the component hierarchy with its available scope. */
interface ScopeLayer {
  componentName: string
  /** Whether this is the component that directly renders the selected node. */
  isCurrent: boolean
  props: ScopeItem[]
  state: ScopeItem[]
}

interface InspectorPanelProps {
  file: string
  line: number
  inspectMode?: 'node' | 'component' | 'file'
  componentName?: string
  /** Populated by DOMTreePanel after a DOM node is selected — drives the Bindings tab. */
  selectedNode?: SelectedNodeContext | null
  /** Name of the root/page component that is allowed to be edited (e.g. "LoginPage").
   *  Any node belonging to a different component is shown read-only. */
  rootComponentName?: string
  onClose: () => void
  /** Called whenever the user resizes the panel so the caller can adjust layout. */
  onWidthChange?: (width: number) => void
}

type Tab = 'source' | 'bindings'

// ── block extraction ──────────────────────────────────────────────────────────

interface BlockRange {
  startLine: number // 0-indexed within the full file
  endLine: number   // 0-indexed, inclusive
}

interface AstLoc {
  start: { line: number }
  end: { line: number }
}

interface AstNode {
  type: string
  loc?: AstLoc | null
  [key: string]: unknown
}

function isAstNode(v: unknown): v is AstNode {
  return !!v && typeof v === 'object' && typeof (v as AstNode).type === 'string'
}

function getChildNodes(node: AstNode): AstNode[] {
  const children: AstNode[] = []
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) children.push(item)
      }
    } else if (isAstNode(value)) {
      children.push(value)
    }
  }
  return children
}

function nodeContainsLine(node: AstNode, targetLine: number): boolean {
  const loc = node.loc
  if (!loc) return false
  return loc.start.line <= targetLine && loc.end.line >= targetLine
}

function nodeSpan(node: AstNode): number {
  if (!node.loc) return Number.MAX_SAFE_INTEGER
  return node.loc.end.line - node.loc.start.line
}

function findSmallestContainingNode(
  root: AstNode,
  targetLine: number,
  predicate: (node: AstNode) => boolean
): AstNode | null {
  let best: AstNode | null = null

  function walk(node: AstNode) {
    if (!nodeContainsLine(node, targetLine)) return
    if (predicate(node)) {
      if (!best || nodeSpan(node) <= nodeSpan(best)) best = node
    }
    for (const child of getChildNodes(node)) walk(child)
  }

  walk(root)
  return best
}

function jsxNameFromNode(node: AstNode): string {
  if (node.type === 'JSXFragment') return '<>'
  if (node.type !== 'JSXElement') return 'jsx'

  const openingElement = node.openingElement as AstNode | undefined
  const nameNode = openingElement?.name as AstNode | undefined
  if (!nameNode) return 'jsx'

  function readName(n: AstNode): string {
    if (n.type === 'JSXIdentifier') return String((n as AstNode & { name?: string }).name ?? 'jsx')
    if (n.type === 'JSXMemberExpression') {
      const object = (n.object as AstNode | undefined) ? readName(n.object as AstNode) : 'obj'
      const property = (n.property as AstNode | undefined) ? readName(n.property as AstNode) : 'prop'
      return `${object}.${property}`
    }
    if (n.type === 'JSXNamespacedName') {
      const ns = (n.namespace as AstNode | undefined) ? readName(n.namespace as AstNode) : 'ns'
      const name = (n.name as AstNode | undefined) ? readName(n.name as AstNode) : 'name'
      return `${ns}:${name}`
    }
    return 'jsx'
  }

  return `<${readName(nameNode)}>`
}

function extractFromLoc(lines: string[], loc: AstLoc, name: string): { code: string; range: BlockRange; name: string } {
  const startLine = Math.max(loc.start.line - 1, 0)
  const endLine = Math.max(loc.end.line - 1, startLine)
  return {
    code: lines.slice(startLine, endLine + 1).join('\n'),
    range: { startLine, endLine },
    name,
  }
}

function findNamedComponentNode(root: AstNode, name: string): AstNode | null {
  let found: AstNode | null = null

  function walk(node: AstNode) {
    if (found) return

    // function LoginPage() {}
    if (node.type === 'FunctionDeclaration') {
      const id = node.id as AstNode | undefined
      const idName = (id as AstNode & { name?: string } | undefined)?.name
      if (idName === name) {
        found = node
        return
      }
    }

    // const LoginPage = () => {}
    if (node.type === 'VariableDeclarator') {
      const id = node.id as AstNode | undefined
      const idName = (id as AstNode & { name?: string } | undefined)?.name
      const init = node.init as AstNode | undefined
      if (
        idName === name &&
        init &&
        (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')
      ) {
        found = init
        return
      }
    }

    for (const child of getChildNodes(node)) walk(child)
  }

  walk(root)
  return found
}

function extractFunctionBlock(lines: string[], target: number): { code: string; range: BlockRange; name: string } {
  let blockStart = 0
  for (let i = target; i >= 0; i--) {
    const t = lines[i].trim()
    if (
      /^(export\s+)?(default\s+)?function[\s*]/.test(t) ||
      /^async\s+function[\s*]/.test(t) ||
      /^(export\s+)?(const|let)\s+\w+\s*[=:]/.test(t)
    ) {
      blockStart = i
      break
    }
  }

  let depth = 0
  let opened = false
  let blockEnd = blockStart
  for (let i = blockStart; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++
        opened = true
      } else if (ch === '}') {
        depth--
      }
    }
    blockEnd = i
    if (opened && depth <= 0) break
  }

  const firstLine = lines[blockStart].trim()
  const nameMatch = firstLine.match(/function\s+(\w+)/) || firstLine.match(/(?:const|let)\s+(\w+)/)
  const name = nameMatch?.[1] ?? 'block'

  return {
    code: lines.slice(blockStart, blockEnd + 1).join('\n'),
    range: { startLine: blockStart, endLine: blockEnd },
    name,
  }
}

function findJsxStart(lines: string[], target: number): { line: number; tag: string } | null {
  for (let i = target; i >= 0; i--) {
    const raw = lines[i]
    const line = raw.replace(/\{\/\*.*?\*\/\}/g, '').trim()
    // Opening tag (not closing/comment) like <Button ... or <div>
    const m = line.match(/<([A-Za-z][\w.-]*)\b(?![^>]*<\/\1>)/)
    if (m && !line.startsWith('</') && !line.startsWith('<!--')) {
      return { line: i, tag: m[1] }
    }
  }
  return null
}

function extractJsxBlock(lines: string[], target: number): { code: string; range: BlockRange; name: string } | null {
  const start = findJsxStart(lines, target)
  if (!start) return null

  const tag = start.tag
  const openRe = new RegExp(`<${tag}\\b`, 'g')
  const closeRe = new RegExp(`</${tag}\\b`, 'g')

  let depth = 0
  let started = false
  let end = start.line

  for (let i = start.line; i < lines.length; i++) {
    const ln = lines[i]

    // Account for self-closing forms (<Tag ... />) on this line.
    const selfClosingCount = (ln.match(new RegExp(`<${tag}\\b[^>]*\\/>`, 'g')) ?? []).length
    const opens = (ln.match(openRe) ?? []).length
    const closes = (ln.match(closeRe) ?? []).length

    if (opens > 0) started = true
    depth += opens - closes - selfClosingCount
    end = i

    if (started && depth <= 0) break
  }

  if (!started) return null

  return {
    code: lines.slice(start.line, end + 1).join('\n'),
    range: { startLine: start.line, endLine: end },
    name: `<${tag}>`,
  }
}

function extractBlock(
  source: string,
  targetLine: number,
  options?: { inspectMode?: 'node' | 'component' | 'file'; componentName?: string }
): { code: string; range: BlockRange; name: string } {
  const lines = source.split('\n')
  const target = Math.min(Math.max(targetLine - 1, 0), lines.length - 1)

  if (options?.inspectMode === 'file') {
    return {
      code: source,
      range: { startLine: 0, endLine: Math.max(lines.length - 1, 0) },
      name: options.componentName ?? 'file',
    }
  }

  // Prefer AST-based extraction for accuracy.
  try {
    const ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    })
    const root = ast.program as unknown as AstNode
    const targetLine1 = target + 1

    // If selection came from a component node in the tree, resolve the
    // component definition directly (prevents starting from nearest <div>).    
    if (options?.inspectMode === 'component' && options.componentName) {
      const named = findNamedComponentNode(root, options.componentName)
      if (named?.loc) {
        return extractFromLoc(lines, named.loc, options.componentName)
      }
    }

    const jsxNode = findSmallestContainingNode(
      root,
      targetLine1,
      (node) => node.type === 'JSXElement' || node.type === 'JSXFragment'
    )
    if (jsxNode?.loc) {
      return extractFromLoc(lines, jsxNode.loc, jsxNameFromNode(jsxNode))
    }

    const functionNode = findSmallestContainingNode(
      root,
      targetLine1,
      (node) =>
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'ClassMethod' ||
        node.type === 'ObjectMethod'
    )
    if (functionNode?.loc) {
      const fallbackName = lines[functionNode.loc.start.line - 1]?.trim() ?? 'function'
      return extractFromLoc(lines, functionNode.loc, fallbackName)
    }
  } catch {
    // Parsing can fail on incomplete intermediate edits; fall back to regex logic.
  }

  const jsx = extractJsxBlock(lines, target)
  if (jsx) return jsx
  return extractFunctionBlock(lines, target)
}

// ── import extraction ───────────────────────────────────────────────────────

function extractImports(source: string): string[] {
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

interface BareModuleUsage {
  hasDefault: boolean
  hasNamespace: boolean
  named: Set<string>
}

function collectModuleUsages(source: string, usage: Map<string, BareModuleUsage>): string[] {
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

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function dirname(path: string): string {
  const normalized = normalizePath(path)
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(0, idx) : normalized
}

function resolveRelativePath(fromDir: string, specifier: string): string {
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

function candidateImportFiles(fromFile: string, specifier: string): string[] {
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

function filePathToModelUri(filePath: string): string {
  return `file:///${normalizePath(filePath)}`
}

function buildBareModuleDeclarations(usage: Map<string, BareModuleUsage>): string {
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

// ── JSX attribute extraction helpers ─────────────────────────────────────────

interface AstLocFull {
  start: { line: number; column: number }
  end: { line: number; column: number }
}

function extractJsxAttrs(source: string, targetLine: number): JsxAttr[] {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const root = ast.program as unknown as AstNode
    const target1 = targetLine // already 1-indexed

    const jsxNode = findSmallestContainingNode(
      root,
      target1,
      (n) => n.type === 'JSXElement' || n.type === 'JSXFragment'
    )
    if (!jsxNode || jsxNode.type === 'JSXFragment') return []

    const opening = jsxNode.openingElement as AstNode | undefined
    const attrs = (opening?.attributes as AstNode[] | undefined) ?? []
    const result: JsxAttr[] = []

    for (const attr of attrs) {
      if (attr.type === 'JSXSpreadAttribute') {
        const argNode = attr.argument as AstNode | undefined
        const lines = source.split('\n')
        const spreadLine = (attr.loc as AstLocFull | undefined)?.start.line ?? 1
        const spreadCol = (attr.loc as AstLocFull | undefined)?.start.column ?? 0
        const endCol = (attr.loc as AstLocFull | undefined)?.end.column ?? 0
        const raw = lines[spreadLine - 1]?.slice(spreadCol, endCol) ?? '{...spread}'
        result.push({
          name: argNode ? `...${(argNode as AstNode & { name?: string }).name ?? 'spread'}` : '...spread',
          rawValue: raw,
          isExpression: false,
          isBoolean: false,
          isSpread: true,
          startLine: spreadLine - 1,
        })
        continue
      }

      if (attr.type !== 'JSXAttribute') continue
      const nameNode = attr.name as AstNode | undefined
      const attrName =
        nameNode?.type === 'JSXIdentifier'
          ? String((nameNode as AstNode & { name?: string }).name ?? '')
          : nameNode?.type === 'JSXNamespacedName'
          ? `${(nameNode as AstNode & { namespace?: AstNode; name?: AstNode }).namespace?.name}:${(nameNode as AstNode & { namespace?: AstNode; name?: AstNode }).name?.name}`
          : ''

      const attrLoc = attr.loc as AstLocFull | undefined
      const startLine = (attrLoc?.start.line ?? 1) - 1

      const valueNode = attr.value as AstNode | null | undefined
      if (valueNode == null) {
        // Boolean shorthand: `disabled`
        result.push({ name: attrName, rawValue: 'true', isExpression: false, isBoolean: true, isSpread: false, startLine })
        continue
      }

      if (valueNode.type === 'StringLiteral' || valueNode.type === 'Literal') {
        result.push({
          name: attrName,
          rawValue: String((valueNode as AstNode & { value?: unknown }).value ?? ''),
          isExpression: false,
          isBoolean: false,
          isSpread: false,
          startLine,
        })
        continue
      }

      if (valueNode.type === 'JSXExpressionContainer') {
        const expr = valueNode.expression as AstNode | undefined
        if (!expr || expr.type === 'JSXEmptyExpression') {
          result.push({ name: attrName, rawValue: '{}', isExpression: true, isBoolean: false, isSpread: false, startLine })
          continue
        }
        // Stringify the inner expression from source.
        const exprLoc = expr.loc as AstLocFull | undefined
        let exprStr = ''
        if (exprLoc) {
          const srcLines = source.split('\n')
          if (exprLoc.start.line === exprLoc.end.line) {
            exprStr = srcLines[exprLoc.start.line - 1]?.slice(exprLoc.start.column, exprLoc.end.column) ?? ''
          } else {
            const parts: string[] = []
            for (let l = exprLoc.start.line; l <= exprLoc.end.line; l++) {
              const ln = srcLines[l - 1] ?? ''
              if (l === exprLoc.start.line) parts.push(ln.slice(exprLoc.start.column))
              else if (l === exprLoc.end.line) parts.push(ln.slice(0, exprLoc.end.column))
              else parts.push(ln)
            }
            exprStr = parts.join('\n')
          }
        }
        result.push({ name: attrName, rawValue: exprStr, isExpression: true, isBoolean: false, isSpread: false, startLine })
        continue
      }

      // Fallback — show raw source slice.
      const vLoc = valueNode.loc as AstLocFull | undefined
      if (vLoc) {
        const srcLines = source.split('\n')
        const raw = srcLines[vLoc.start.line - 1]?.slice(vLoc.start.column, vLoc.end.column) ?? '?'
        result.push({ name: attrName, rawValue: raw, isExpression: false, isBoolean: false, isSpread: false, startLine })
      }
    }

    return result
  } catch {
    return []
  }
}

// Find all JSX usage sites of a component tag by scanning window.__LOCATOR_DATA__.
// Returns an array of {file, line} for each place the component is rendered.
function findLocatorUsages(componentTag: string): Array<{ file: string; line: number }> {
  // Locatorjs can emit concatenated keys like "D:\builder-appD:\login-app\src\Foo.tsx".
  // If there are two Windows drive-letter prefixes, keep only the second (real) path.
  function normalizeConcatenatedPath(raw: string): string {
    const hits = [...raw.matchAll(/[A-Za-z]:[\\/]/g)]
    if (hits.length >= 2 && hits[1].index !== undefined) return raw.slice(hits[1].index)
    return raw
  }

  try {
    const data = (window as unknown as { __LOCATOR_DATA__?: Record<string, unknown> }).__LOCATOR_DATA__
    if (!data) return []
    const results: Array<{ file: string; line: number }> = []
    for (const fileData of Object.values(data)) {
      const fd = fileData as { filePath?: string; projectPath?: string; expressions?: Array<{ name?: string; loc?: { start?: { line?: number } } }> }
      const rawFp = normalizeConcatenatedPath(fd.filePath ?? '')
      const fp = rawFp.replace(/\\/g, '/')
      const filePath = /^[A-Za-z]:[\/]|^\//.test(fp) ? fp : `${(fd.projectPath ?? '').replace(/\\/g, '/')}${fp}`
      for (const expr of fd.expressions ?? []) {
        if (expr.name === componentTag) {
          results.push({ file: filePath, line: expr.loc?.start?.line ?? 1 })
        }
      }
    }
    return results
  } catch {
    return []
  }
}

// Infer the TypeScript type of a local variable (or prop) inside a component.
// Checks, in order: TypeScript type annotation on the variable, useState generic,
// literal initializer type, and props interface membership.
function inferTypeOfLocal(source: string, componentName: string, varName: string): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body

    // Find the component function node.
    let fnNode: AstNode | null = null
    let fnBody: AstNode | null = null
    const tryDecl = (decl: AstNode | undefined) => {
      if (!decl) return
      if (decl.type === 'FunctionDeclaration') {
        if ((decl as AstNode & { id?: { name?: string } }).id?.name === componentName) { fnNode = decl; fnBody = (decl as AstNode & { body?: AstNode }).body ?? null }
      }
      if (decl.type === 'VariableDeclaration') {
        for (const d of ((decl as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
          if ((d as AstNode & { id?: { name?: string } }).id?.name === componentName) {
            const init = (d as AstNode & { init?: AstNode }).init
            fnNode = init ?? null; fnBody = (init as AstNode & { body?: AstNode })?.body ?? null
          }
        }
      }
    }
    for (const node of body) {
      if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') tryDecl((node as AstNode & { declaration?: AstNode }).declaration)
      tryDecl(node)
      if (fnBody) break
    }

    // Check props parameter destructure + referenced interface.
    const params = (fnNode as unknown as { params?: AstNode[] })?.params ?? []
    const firstParam = params[0]
    if (firstParam) {
      const paramNode = firstParam.type === 'AssignmentPattern' ? (firstParam as AstNode & { left?: AstNode }).left ?? firstParam : firstParam
      // Check if it's in the destructure directly.
      if (paramNode.type === 'ObjectPattern') {
        for (const p of ((paramNode as AstNode & { properties?: AstNode[] }).properties ?? [])) {
          const key = (p as AstNode & { key?: AstNode & { name?: string } }).key
          if (key?.name !== varName) continue
          // Found in destructure — get type from props interface.
          const typeAnn = (paramNode as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
          const typeRef = (typeAnn as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
          const propsTypeName = typeRef?.type === 'TSTypeReference'
            ? String((typeRef as AstNode & { typeName?: AstNode & { name?: string } }).typeName?.name ?? '') : ''
          if (propsTypeName) {
            const scratch: ComponentProp[] = []
            enrichWithTypeDeclaration(body, propsTypeName, scratch)
            const match = scratch.find(pr => pr.name === varName)
            if (match?.typeStr) return match.typeStr
          }
        }
        // Also check props interface even if not in destructure.
        const typeAnn = (paramNode as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
        const typeRef = (typeAnn as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
        const propsTypeName = typeRef?.type === 'TSTypeReference'
          ? String((typeRef as AstNode & { typeName?: AstNode & { name?: string } }).typeName?.name ?? '') : ''
        if (propsTypeName) {
          const scratch: ComponentProp[] = []
          enrichWithTypeDeclaration(body, propsTypeName, scratch)
          const match = scratch.find(pr => pr.name === varName)
          if (match?.typeStr) return match.typeStr
        }
      }
    }

    if (!fnBody) return ''

    // Walk body variable declarations.
    for (const stmt of ((fnBody as AstNode & { body?: AstNode[] }).body ?? [])) {
      if (stmt.type !== 'VariableDeclaration') continue
      for (const d of ((stmt as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
        // ArrayPattern: `const [email, setEmail] = useState('')`
        const id = (d as AstNode & { id?: AstNode }).id
        const init = (d as AstNode & { init?: AstNode }).init
        if (!id) continue

        const checkInit = (name: string, isSetterIndex?: number): string => {
          if (!init) return ''
          // useState<T>() — use generic type argument if present.
          if (init.type === 'CallExpression') {
            const callee = (init as AstNode & { callee?: AstNode }).callee
            const calleeName = (callee as AstNode & { name?: string }).name
              ?? (callee as AstNode & { property?: AstNode & { name?: string } }).property?.name ?? ''
            if (calleeName === 'useState') {
              const typeParams = (init as AstNode & { typeParameters?: AstNode & { params?: AstNode[] } }).typeParameters
              if (typeParams?.params?.[0]) return stringifyTSType(typeParams.params[0])
              // Infer from initial value argument.
              const arg0 = (init as AstNode & { arguments?: AstNode[] }).arguments?.[0]
              if (arg0) {
                if (arg0.type === 'StringLiteral') return isSetterIndex !== undefined ? '(v: string) => void' : 'string'
                if (arg0.type === 'NumericLiteral') return isSetterIndex !== undefined ? '(v: number) => void' : 'number'
                if (arg0.type === 'BooleanLiteral') return isSetterIndex !== undefined ? '(v: boolean) => void' : 'boolean'
                if (arg0.type === 'NullLiteral') return isSetterIndex !== undefined ? '(v: null) => void' : 'null'
              }
              return isSetterIndex !== undefined ? '(v: unknown) => void' : 'unknown'
            }
          }
          // Direct type annotation on the declarator.
          const typeAnn = (d as AstNode & { id?: AstNode & { typeAnnotation?: AstNode } }).id?.typeAnnotation
          if (typeAnn) return stringifyTSType((typeAnn as AstNode & { typeAnnotation?: AstNode }).typeAnnotation)
          // Literal initializer.
          if (init.type === 'StringLiteral') return 'string'
          if (init.type === 'NumericLiteral') return 'number'
          if (init.type === 'BooleanLiteral') return 'boolean'
          return ''
        }

        if (id.type === 'Identifier' && (id as AstNode & { name?: string }).name === varName) {
          return checkInit(varName)
        }
        if (id.type === 'ArrayPattern') {
          const els = (id as AstNode & { elements?: (AstNode | null)[] }).elements ?? []
          for (let i = 0; i < els.length; i++) {
            const el = els[i]
            if (el?.type === 'Identifier' && (el as AstNode & { name?: string }).name === varName) {
              return checkInit(varName, i > 0 ? i : undefined)
            }
          }
        }
        if (id.type === 'ObjectPattern') {
          for (const p of ((id as AstNode & { properties?: AstNode[] }).properties ?? [])) {
            const key = (p as AstNode & { key?: AstNode & { name?: string } }).key
            if (key?.name === varName) return checkInit(varName)
          }
        }
      }
    }
    return ''
  } catch {
    return ''
  }
}

// Extract the names of all local variables declared inside a component function.
// This is used to populate the datalist for value fields in component-mode rows,
// so the user can pick from parent-component variables (e.g. email, password).
function extractComponentLocals(source: string, componentName: string): string[] {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body

    // Find the component function node — collect both the fn node (for params) and its body.
    let fnNode: AstNode | null = null
    let fnBody: AstNode | null = null
    const tryDecl = (decl: AstNode | undefined) => {
      if (!decl) return
      if (decl.type === 'FunctionDeclaration') {
        if ((decl as AstNode & { id?: { name?: string } }).id?.name === componentName) {
          fnNode = decl
          fnBody = (decl as AstNode & { body?: AstNode }).body ?? null
        }
      }
      if (decl.type === 'VariableDeclaration') {
        for (const d of ((decl as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
          if ((d as AstNode & { id?: { name?: string } }).id?.name === componentName) {
            const init = (d as AstNode & { init?: AstNode }).init
            fnNode = init ?? null
            fnBody = (init as AstNode & { body?: AstNode })?.body ?? null
          }
        }
      }
    }
    for (const node of body) {
      if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') {
        tryDecl((node as AstNode & { declaration?: AstNode }).declaration)
      }
      tryDecl(node)
      if (fnBody) break
    }
    if (!fnBody) return []

    // Helper: collect all identifier names from a destructure pattern (ObjectPattern / ArrayPattern).
    const collectPattern = (pat: AstNode, into: string[]) => {
      if (pat.type === 'Identifier') {
        const n = (pat as AstNode & { name?: string }).name
        if (n) into.push(n)
      } else if (pat.type === 'ObjectPattern') {
        for (const p of ((pat as AstNode & { properties?: AstNode[] }).properties ?? [])) {
          if (p.type === 'RestElement') {
            collectPattern((p as AstNode & { argument?: AstNode }).argument ?? p, into)
          } else {
            const key = (p as AstNode & { key?: AstNode & { name?: string } }).key
            if (key?.name) into.push(key.name)
          }
        }
      } else if (pat.type === 'ArrayPattern') {
        for (const el of ((pat as AstNode & { elements?: (AstNode | null)[] }).elements ?? [])) {
          if (el) collectPattern(el, into)
        }
      } else if (pat.type === 'AssignmentPattern') {
        collectPattern((pat as AstNode & { left?: AstNode }).left ?? pat, into)
      }
    }

    const results: string[] = []

    // 1. Collect names from the function parameter destructure (e.g. `{ email, setEmail }`).
    const params = (fnNode as unknown as { params?: AstNode[] })?.params ?? []
    if (params[0]) collectPattern(params[0], results)

    // 1b. Also collect names from the TypeScript props type/interface referenced by params[0].
    //     This handles the case where the destructure is empty `({  }: LoginPageProps)` but the
    //     interface declares props like `inputStyle` — those are still in scope.
    const firstParam = params[0]
    if (firstParam) {
      // Unwrap AssignmentPattern to get the actual param node.
      const paramNode = firstParam.type === 'AssignmentPattern'
        ? (firstParam as AstNode & { left?: AstNode }).left ?? firstParam
        : firstParam
      const typeAnnotation = (paramNode as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
      const typeRef = (typeAnnotation as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
      const propsTypeName = typeRef?.type === 'TSTypeReference'
        ? String((typeRef as AstNode & { typeName?: AstNode & { name?: string } }).typeName?.name ?? '')
        : ''
      if (propsTypeName) {
        // Reuse enrichWithTypeDeclaration by passing a scratch array and collecting names from it.
        const scratch: ComponentProp[] = []
        enrichWithTypeDeclaration(body, propsTypeName, scratch)
        for (const p of scratch) if (!results.includes(p.name)) results.push(p.name)
      }
    }

    // 2. Collect names from local variable declarations in the function body.
    for (const stmt of ((fnBody as AstNode & { body?: AstNode[] }).body ?? [])) {
      if (stmt.type !== 'VariableDeclaration') continue
      for (const d of ((stmt as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
        const id = (d as AstNode & { id?: AstNode }).id
        if (id) collectPattern(id, results)
      }
    }

    return results.filter(Boolean)
  } catch {
    return []
  }
}

// Find the name of the React component that contains the given line number.
// Used as fallback when ownerComponentName is not available from locatorjs data.
function inferOwnerComponentName(source: string, targetLine: number): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body
    let best: { name: string; startLine: number } | null = null
    for (const node of body) {
      const candidates: Array<{ fn: AstNode; name: string }> = []
      const tryAdd = (fn: AstNode, name: string) => {
        if (/^[A-Z]/.test(name)) candidates.push({ fn, name })
      }
      if (node.type === 'FunctionDeclaration') {
        const id = (node as AstNode & { id?: AstNode & { name?: string } }).id
        if (id?.name) tryAdd(node, id.name)
      }
      if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') {
        const decl = (node as AstNode & { declaration?: AstNode }).declaration
        if (decl?.type === 'FunctionDeclaration') {
          const id = (decl as AstNode & { id?: AstNode & { name?: string } }).id
          if (id?.name) tryAdd(decl, id.name)
        }
        if (decl?.type === 'VariableDeclaration') {
          for (const d of ((decl as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
            const id = (d as AstNode & { id?: AstNode & { name?: string } }).id
            const fn = (d as AstNode & { init?: AstNode }).init
            if (id?.name && fn) tryAdd(fn, id.name)
          }
        }
      }
      if (node.type === 'VariableDeclaration') {
        for (const d of ((node as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
          const id = (d as AstNode & { id?: AstNode & { name?: string } }).id
          const fn = (d as AstNode & { init?: AstNode }).init
          if (id?.name && fn) tryAdd(fn, id.name)
        }
      }
      for (const { fn, name } of candidates) {
        const loc = fn.loc as AstLocFull | undefined
        if (!loc) continue
        if (loc.start.line <= targetLine && targetLine <= loc.end.line) {
          if (!best || loc.start.line > best.startLine) {
            best = { name, startLine: loc.start.line }
          }
        }
      }
    }
    return best?.name ?? ''
  } catch {
    return ''
  }
}

/**
 * Returns true if the component at `ownerName` has a named props type/interface
 * referenced in its parameter destructure (e.g. `{ foo }: ButtonProps`).
 * Returns false when the param is untyped, plain `props`, or missing entirely.
 */
function componentHasPropTypeDef(source: string, ownerName: string): boolean {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body
    for (const node of body) {
      const candidates: AstNode[] = []
      if (node.type === 'FunctionDeclaration') candidates.push(node)
      const exported = (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration')
        ? (node as AstNode & { declaration?: AstNode }).declaration : undefined
      if (exported?.type === 'FunctionDeclaration') candidates.push(exported)
      if (exported?.type === 'VariableDeclaration' || node.type === 'VariableDeclaration') {
        const decl = exported ?? node
        for (const d of ((decl as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
          const id = (d as AstNode & { id?: AstNode & { name?: string } }).id
          if (id?.name === ownerName) {
            const fn = (d as AstNode & { init?: AstNode }).init
            if (fn) candidates.push(fn)
          }
        }
      }
      for (const cand of candidates) {
        const fnId = (cand as AstNode & { id?: AstNode & { name?: string } }).id
        if (cand.type === 'FunctionDeclaration' && fnId?.name !== ownerName) continue
        const params = (cand as AstNode & { params?: AstNode[] })?.params ?? []
        const firstParam = params[0]
        if (!firstParam) return false
        const pattern =
          firstParam.type === 'ObjectPattern' ? firstParam
          : firstParam.type === 'AssignmentPattern' ? (firstParam as AstNode & { left?: AstNode }).left
          : null
        if (pattern?.type === 'ObjectPattern') {
          const ta = (pattern as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
          const ref = (ta as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
          return !!ref && ref.type === 'TSTypeReference'
        }
        // plain `props` param with type annotation
        if (firstParam.type === 'Identifier') {
          const ta = (firstParam as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
          const ref = (ta as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
          return !!ref && ref.type === 'TSTypeReference'
        }
        return false
      }
    }
  } catch { /* ignore */ }
  return false
}

// Extract props declared in the owning component's function signature/type/interface.
function extractOwnerProps(source: string, ownerName: string): ComponentProp[] {
  const result: ComponentProp[] = []
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body

    // Find the component function or const.
    let componentNode: AstNode | null = null
    for (const node of body) {
      if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') {
        const decl = (node as AstNode & { declaration?: AstNode }).declaration
        if (decl) {
          if (decl.type === 'FunctionDeclaration') {
            const id = (decl as AstNode & { id?: AstNode & { name?: string } }).id
            if (id?.name === ownerName) { componentNode = decl; break }
          }
          if (decl.type === 'VariableDeclaration') {
            for (const d of ((decl as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
              const id = (d as AstNode & { id?: AstNode & { name?: string } }).id
              if (id?.name === ownerName) { componentNode = d; break }
            }
          }
        }
      }
      if (node.type === 'FunctionDeclaration') {
        const id = (node as AstNode & { id?: AstNode & { name?: string } }).id
        if (id?.name === ownerName) { componentNode = node; break }
      }
      if (node.type === 'VariableDeclaration') {
        for (const d of ((node as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
          const id = (d as AstNode & { id?: AstNode & { name?: string } }).id
          if (id?.name === ownerName) { componentNode = d; break }
        }
      }
      if (componentNode) break
    }

    if (!componentNode) return result

    // Get the function params (either FunctionDeclaration.params or ArrowFunctionExpression.params).
    const fnNode =
      componentNode.type === 'VariableDeclarator'
        ? (componentNode as AstNode & { init?: AstNode }).init
        : componentNode

    const params = (fnNode as AstNode & { params?: AstNode[] })?.params ?? []
    const firstParam = params[0]
    if (!firstParam) return result

    // Case 1: Destructured props `({ value, onChange }: InputProps)` or `{ value, onChange }`
    const pattern =
      firstParam.type === 'AssignmentPattern'
        ? (firstParam as AstNode & { left?: AstNode }).left
        : firstParam.type === 'ObjectPattern'
        ? firstParam
        : firstParam.type === 'TSParameterProperty'
        ? (firstParam as AstNode & { parameter?: AstNode }).parameter
        : null

    if (pattern?.type === 'ObjectPattern') {
      for (const prop of ((pattern as AstNode & { properties?: AstNode[] }).properties ?? [])) {
        if (prop.type === 'RestElement') continue
        const key = (prop as AstNode & { key?: AstNode & { name?: string } }).key
        if (!key?.name) continue
        // Check for default value: `{ type = 'text' }` → AssignmentPattern
        const valNode = (prop as AstNode & { value?: AstNode }).value
        let defaultValue: string | undefined
        if (valNode?.type === 'AssignmentPattern') {
          const right = (valNode as AstNode & { right?: AstNode }).right
          if (right) {
            if (right.type === 'StringLiteral') defaultValue = String((right as AstNode & { value?: unknown }).value ?? '')
            else if (right.type === 'NumericLiteral') defaultValue = String((right as AstNode & { value?: unknown }).value ?? '')
            else if (right.type === 'BooleanLiteral') defaultValue = String((right as AstNode & { value?: unknown }).value ?? '')
            else if (right.type === 'NullLiteral') defaultValue = 'null'
            else if (right.type === 'Identifier') defaultValue = String((right as AstNode & { name?: string }).name ?? '')
          }
        }
        result.push({ name: key.name, typeStr: '', source: 'owner', defaultValue })
      }

      // Also try to find a named Props interface and enrich type strings.
      const typeAnnotation = (pattern as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
      const typeRef = (typeAnnotation as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
      const propsTypeName =
        typeRef?.type === 'TSTypeReference'
          ? String((typeRef as AstNode & { typeName?: AstNode & { name?: string } }).typeName?.name ?? '')
          : ''

      if (propsTypeName) {
        enrichWithTypeDeclaration(body, propsTypeName, result)
      }
    }

    // Case 2: plain `props` param — try to get from referenced interface
    if (firstParam.type === 'Identifier') {
      const typeAnnotation = (firstParam as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
      const typeRef = (typeAnnotation as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
      const propsTypeName =
        typeRef?.type === 'TSTypeReference'
          ? String((typeRef as AstNode & { typeName?: AstNode & { name?: string } }).typeName?.name ?? '')
          : ''
      if (propsTypeName) enrichWithTypeDeclaration(body, propsTypeName, result)
    }
  } catch {
    // Silently return whatever we collected.
  }
  return result
}

function enrichWithTypeDeclaration(body: AstNode[], typeName: string, out: ComponentProp[]): void {
  for (const node of body) {
    // interface FooProps { ... }
    if (node.type === 'TSInterfaceDeclaration') {
      const id = (node as AstNode & { id?: AstNode & { name?: string } }).id
      if (id?.name !== typeName) continue
      for (const member of ((node as AstNode & { body?: AstNode & { body?: AstNode[] } }).body?.body ?? [])) {
        if (member.type !== 'TSPropertySignature') continue
        const key = (member as AstNode & { key?: AstNode & { name?: string } }).key
        if (!key?.name) continue
        const typeAnnotation = (member as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
        const typeStr = stringifyTSType((typeAnnotation as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation)
        const existing = out.find((p) => p.name === key.name)
        if (existing) existing.typeStr = typeStr
        else out.push({ name: key.name, typeStr, source: 'owner' })
      }
    }
    // type FooProps = { ... }
    if (node.type === 'TSTypeAliasDeclaration') {
      const id = (node as AstNode & { id?: AstNode & { name?: string } }).id
      if (id?.name !== typeName) continue
      const typeAnnotation = (node as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
      if (typeAnnotation?.type === 'TSTypeLiteral') {
        for (const member of ((typeAnnotation as AstNode & { members?: AstNode[] }).members ?? [])) {
          if (member.type !== 'TSPropertySignature') continue
          const key = (member as AstNode & { key?: AstNode & { name?: string } }).key
          if (!key?.name) continue
          const ta = (member as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
          const typeStr = stringifyTSType((ta as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation)
          const existing = out.find((p) => p.name === key.name)
          if (existing) existing.typeStr = typeStr
          else out.push({ name: key.name, typeStr, source: 'owner' })
        }
      }
    }
  }
}

function stringifyTSType(node: AstNode | null | undefined): string {
  if (!node) return ''
  if (node.type === 'TSStringKeyword') return 'string'
  if (node.type === 'TSNumberKeyword') return 'number'
  if (node.type === 'TSBooleanKeyword') return 'boolean'
  if (node.type === 'TSVoidKeyword') return 'void'
  if (node.type === 'TSAnyKeyword') return 'any'
  if (node.type === 'TSUnknownKeyword') return 'unknown'
  if (node.type === 'TSNeverKeyword') return 'never'
  if (node.type === 'TSNullKeyword') return 'null'
  if (node.type === 'TSUndefinedKeyword') return 'undefined'
  if (node.type === 'TSTypeReference') {
    const name = (node as AstNode & { typeName?: AstNode & { name?: string } }).typeName?.name ?? ''
    return name
  }
  if (node.type === 'TSFunctionType') return 'function'
  if (node.type === 'TSUnionType') {
    const types = (node as AstNode & { types?: AstNode[] }).types ?? []
    return types.map(stringifyTSType).join(' | ')
  }
  return node.type.replace(/^TS/, '').replace(/Keyword$/, '').toLowerCase()
}

// Well-known CSS property names used to detect React.CSSProperties objects.
const CSS_PROPERTY_NAMES = new Set([
  'color','background','backgroundColor','backgroundImage','border','borderColor',
  'borderRadius','borderWidth','borderStyle','borderTop','borderBottom','borderLeft','borderRight',
  'boxShadow','outline','opacity','visibility','display','flexDirection','flexWrap','flex',
  'flexGrow','flexShrink','flexBasis','alignItems','alignContent','alignSelf','justifyContent',
  'justifyItems','justifySelf','gap','rowGap','columnGap','grid','gridTemplate',
  'gridTemplateColumns','gridTemplateRows','gridColumn','gridRow','float','clear','position',
  'top','right','bottom','left','zIndex','width','height','minWidth','minHeight','maxWidth',
  'maxHeight','margin','marginTop','marginRight','marginBottom','marginLeft','padding',
  'paddingTop','paddingRight','paddingBottom','paddingLeft','overflow','overflowX','overflowY',
  'cursor','pointerEvents','userSelect','resize','objectFit','objectPosition',
  'fontFamily','fontSize','fontWeight','fontStyle','fontVariant','lineHeight','letterSpacing',
  'textAlign','textDecoration','textTransform','textOverflow','whiteSpace','wordBreak',
  'verticalAlign','transition','transform','animation','clip','content','appearance',
  'boxSizing','filter','backdropFilter','fill','stroke',
])

/**
 * Infer a TypeScript type string from a Babel value expression node.
 * Used to auto-populate props interface from destructure default values.
 */
function inferTypeFromExpression(node: AstNode | null | undefined): string {
  if (!node) return 'unknown'
  if (node.type === 'StringLiteral') return 'string'
  if (node.type === 'NumericLiteral') return 'number'
  if (node.type === 'BooleanLiteral') return 'boolean'
  if (node.type === 'NullLiteral') return 'null'
  if (node.type === 'Identifier') {
    const name = (node as AstNode & { name?: string }).name ?? ''
    if (name === 'undefined') return 'undefined'
    if (name === 'null') return 'null'
    return 'unknown'
  }
  if (node.type === 'ArrayExpression') {
    const elems = (node as AstNode & { elements?: (AstNode | null)[] }).elements ?? []
    const first = elems.find(Boolean)
    if (first) return `${inferTypeFromExpression(first)}[]`
    return 'unknown[]'
  }
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    const params = (node as AstNode & { params?: AstNode[] }).params ?? []
    const paramStr = params.map(() => 'unknown').join(', ')
    return `(${paramStr}) => void`
  }
  if (node.type === 'ObjectExpression') {
    const props = (node as AstNode & { properties?: AstNode[] }).properties ?? []
    // If all keys are CSS property names → React.CSSProperties
    const keys = props
      .filter(p => p.type === 'ObjectProperty')
      .map(p => {
        const k = (p as AstNode & { key?: AstNode & { name?: string; value?: string } }).key
        return k?.name ?? k?.value ?? ''
      })
    if (keys.length > 0 && keys.every(k => CSS_PROPERTY_NAMES.has(k))) return 'React.CSSProperties'
    // Otherwise build an inline object type.
    const members = props
      .filter(p => p.type === 'ObjectProperty')
      .map(p => {
        const k = (p as AstNode & { key?: AstNode & { name?: string; value?: string } }).key
        const v = (p as AstNode & { value?: AstNode }).value
        const keyStr = k?.name ?? k?.value ?? '_'
        return `${keyStr}: ${inferTypeFromExpression(v)}`
      })
    return members.length > 0 ? `{ ${members.join('; ')} }` : 'Record<string, unknown>'
  }
  if (node.type === 'TemplateLiteral') return 'string'
  if (node.type === 'CallExpression') return 'unknown'
  return 'unknown'
}

/**
 * Infer a TypeScript type string from a raw value string (what the user typed in a field).
 * Handles JSX expression braces `{value}`, string literals, numbers, booleans, objects, arrays.
 */
function inferTypeFromValueString(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  // If wrapped in {}, it's a JS expression; otherwise it's a plain JSX string-literal value.
  const isExpression = trimmed.startsWith('{') && trimmed.endsWith('}')
  const unwrapped = isExpression ? trimmed.slice(1, -1).trim() : trimmed
  try {
    const ast = parse(unwrapped, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const stmts = (ast.program as unknown as { body: AstNode[] }).body
    const first = stmts[0]
    if (!first) return isExpression ? '' : 'string'
    const expr = first.type === 'ExpressionStatement'
      ? (first as AstNode & { expression?: AstNode }).expression ?? first
      : first
    const t = inferTypeFromExpression(expr)
    if (t !== 'unknown') return t
    // Plain (non-expression) text that parsed as an identifier is a string attribute value.
    return isExpression ? '' : 'string'
  } catch {
    // Fallback heuristics for values we can't parse.
    if (/^['"`]/.test(unwrapped) || /['"`]$/.test(unwrapped)) return 'string'
    if (/^-?\d+(\.\d+)?$/.test(unwrapped)) return 'number'
    if (unwrapped === 'true' || unwrapped === 'false') return 'boolean'
    if (unwrapped === 'null') return 'null'
    if (unwrapped === 'undefined') return 'undefined'
    // Plain text that failed to parse (e.g. multi-word like "Click me") is a string.
    return isExpression ? '' : 'string'
  }
}

// Rewrite a single JSX attribute value in the full source string.
function rewriteAttrValue(source: string, targetLine: number, attrName: string, newValue: string, asExpression: boolean): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const root = ast.program as unknown as AstNode
    const jsxNode = findSmallestContainingNode(root, targetLine, (n) => n.type === 'JSXElement')
    if (!jsxNode) return source

    const opening = jsxNode.openingElement as AstNode | undefined
    const attrs = (opening?.attributes as AstNode[] | undefined) ?? []
    for (const attr of attrs) {
      if (attr.type !== 'JSXAttribute') continue
      const nameNode = attr.name as AstNode & { name?: string } | undefined
      if (nameNode?.name !== attrName) continue

      const attrLoc = attr.loc as AstLocFull | undefined
      if (!attrLoc) continue

      const lines = source.split('\n')
      const attrLine = lines[attrLoc.start.line - 1]
      // Replacement: rebuild `name="value"` or `name={value}`
      const newAttrStr = asExpression ? `${attrName}={${newValue}}` : `${attrName}="${newValue}"`
      // Replace only the attribute portion in the line.
      const attrSrcStart = attrLoc.start.column
      const attrSrcEnd = attrLoc.end.column
      const newAttrLine =
        attrLine.slice(0, attrSrcStart) + newAttrStr + attrLine.slice(attrSrcEnd)
      lines[attrLoc.start.line - 1] = newAttrLine
      return lines.join('\n')
    }
    return source
  } catch {
    return source
  }
}

// Remove a JSX attribute from a JSX element by name.
function removeAttr(source: string, targetLine: number, attrName: string): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const root = ast.program as unknown as AstNode
    const jsxNode = findSmallestContainingNode(root, targetLine, (n) => n.type === 'JSXElement')
    if (!jsxNode) return source

    const opening = jsxNode.openingElement as AstNode | undefined
    const attrs = (opening?.attributes as AstNode[] | undefined) ?? []
    for (const attr of attrs) {
      if (attr.type !== 'JSXAttribute') continue
      const nameNode = attr.name as AstNode & { name?: string } | undefined
      if (nameNode?.name !== attrName) continue

      const attrLoc = attr.loc as AstLocFull | undefined
      if (!attrLoc) continue

      const lines = source.split('\n')
      if (attrLoc.start.line === attrLoc.end.line) {
        const ln = lines[attrLoc.start.line - 1]
        // Remove the attribute text plus any leading whitespace.
        const before = ln.slice(0, attrLoc.start.column).replace(/\s+$/, '')
        const after = ln.slice(attrLoc.end.column)
        const newLn = before + after
        // If the line is now only whitespace / tag characters, drop it entirely.
        lines[attrLoc.start.line - 1] = newLn
        // Clean up completely empty lines left behind inside the opening tag.
        const result = lines.filter((l, i) => {
          if (i !== attrLoc.start.line - 1) return true
          return newLn.trim().length > 0
        })
        return result.join('\n')
      }
      // Multi-line attribute — delete all lines it spans.
      lines.splice(attrLoc.start.line - 1, attrLoc.end.line - attrLoc.start.line + 1)
      return lines.join('\n')
    }
    return source
  } catch {
    return source
  }
}

// Remove a prop from the component's props interface/type and its destructured param.
function removePropFromOwnerSignature(source: string, ownerName: string, propName: string): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body
    let modified = source

    // 1. Remove from interface / type literal.
    for (const node of body) {
      if (node.type === 'TSInterfaceDeclaration') {
        const members = (node as AstNode & { body?: AstNode & { body?: AstNode[] } }).body?.body ?? []
        for (const member of members) {
          if (member.type !== 'TSPropertySignature') continue
          const key = (member as AstNode & { key?: AstNode & { name?: string } }).key
          if (key?.name !== propName) continue
          const mLoc = member.loc as AstLocFull | undefined
          if (!mLoc) continue
          const mLines = modified.split('\n')
          mLines.splice(mLoc.start.line - 1, mLoc.end.line - mLoc.start.line + 1)
          modified = mLines.join('\n')
          break
        }
      }
      if (node.type === 'TSTypeAliasDeclaration') {
        const ta = (node as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
        const members = (ta as AstNode & { members?: AstNode[] })?.members ?? []
        for (const member of members) {
          if (member.type !== 'TSPropertySignature') continue
          const key = (member as AstNode & { key?: AstNode & { name?: string } }).key
          if (key?.name !== propName) continue
          const mLoc = member.loc as AstLocFull | undefined
          if (!mLoc) continue
          const mLines = modified.split('\n')
          mLines.splice(mLoc.start.line - 1, mLoc.end.line - mLoc.start.line + 1)
          modified = mLines.join('\n')
          break
        }
      }
    }

    // 2. Remove from destructured parameter pattern.
    // Re-parse after step 1 so line numbers are fresh.
    const ast2 = parse(modified, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body2 = (ast2.program as unknown as { body: AstNode[] }).body
    for (const node of body2) {
      let fnNode: AstNode | null = null
      if (node.type === 'FunctionDeclaration') {
        const id = (node as AstNode & { id?: AstNode & { name?: string } }).id
        if (id?.name === ownerName) fnNode = node
      }
      if ((node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration')) {
        const decl = (node as AstNode & { declaration?: AstNode }).declaration
        if (decl?.type === 'FunctionDeclaration') {
          const id = (decl as AstNode & { id?: AstNode & { name?: string } }).id
          if (id?.name === ownerName) fnNode = decl
        }
        if (decl?.type === 'VariableDeclaration') {
          for (const d of ((decl as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
            const id = (d as AstNode & { id?: AstNode & { name?: string } }).id
            if (id?.name === ownerName) fnNode = (d as AstNode & { init?: AstNode }).init ?? null
          }
        }
      }
      if (node.type === 'VariableDeclaration') {
        for (const d of ((node as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
          const id = (d as AstNode & { id?: AstNode & { name?: string } }).id
          if (id?.name === ownerName) fnNode = (d as AstNode & { init?: AstNode }).init ?? null
        }
      }
      if (!fnNode) continue

      const params = (fnNode as AstNode & { params?: AstNode[] })?.params ?? []
      const firstParam = params[0]
      if (!firstParam) continue
      const pattern = firstParam.type === 'ObjectPattern' ? firstParam
        : firstParam.type === 'AssignmentPattern' ? (firstParam as AstNode & { left?: AstNode }).left
        : null
      if (pattern?.type !== 'ObjectPattern') continue

      const properties = (pattern as AstNode & { properties?: AstNode[] }).properties ?? []
      for (const prop of properties) {
        if (prop.type === 'RestElement') continue
        const key = (prop as AstNode & { key?: AstNode & { name?: string } }).key
        if (key?.name !== propName) continue
        const pLoc = prop.loc as AstLocFull | undefined
        if (!pLoc) continue

        const mLines = modified.split('\n')
        if (pLoc.start.line === pLoc.end.line) {
          const ln = mLines[pLoc.start.line - 1]
          const beforeRaw = ln.slice(0, pLoc.start.column)
          const afterRaw = ln.slice(pLoc.end.column)
          // Strip comma from exactly ONE side to avoid eating the separator between
          // the flanking parameters (double-strip produces `{ a  c }` instead of `{ a, c }`).
          let removed: string
          if (/,\s*$/.test(beforeRaw)) {
            removed = beforeRaw.replace(/,\s*$/, '') + afterRaw
          } else {
            removed = beforeRaw + afterRaw.replace(/^\s*,\s?/, '')
          }
          mLines[pLoc.start.line - 1] = removed
        } else {
          mLines.splice(pLoc.start.line - 1, pLoc.end.line - pLoc.start.line + 1)
        }
        modified = mLines.join('\n')
        break
      }
      break
    }

    return modified
  } catch {
    return source
  }
}

// Walks the owning component body and removes all JSX attribute usages of propName
// where the attribute value is exactly {propName} (direct prop pass-through).
function removePropUsagesInBody(source: string, ownerName: string, propName: string): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body

    // Locate the component function node.
    let fnBodyNode: AstNode | null = null
    outer: for (const node of body) {
      const candidates: AstNode[] = []
      if (node.type === 'FunctionDeclaration') candidates.push(node)
      if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') {
        const decl = (node as AstNode & { declaration?: AstNode }).declaration
        if (decl?.type === 'FunctionDeclaration') candidates.push(decl)
        if (decl?.type === 'VariableDeclaration') {
          for (const d of ((decl as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
            const id = (d as AstNode & { id?: AstNode & { name?: string } }).id
            if (id?.name === ownerName) {
              const fn = (d as AstNode & { init?: AstNode }).init
              if (fn) candidates.push(fn)
            }
          }
        }
      }
      if (node.type === 'VariableDeclaration') {
        for (const d of ((node as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
          const id = (d as AstNode & { id?: AstNode & { name?: string } }).id
          if (id?.name === ownerName) {
            const fn = (d as AstNode & { init?: AstNode }).init
            if (fn) candidates.push(fn)
          }
        }
      }
      for (const cand of candidates) {
        const fnId = (cand as AstNode & { id?: AstNode & { name?: string } }).id
        if (cand.type === 'FunctionDeclaration' && fnId?.name !== ownerName) continue
        fnBodyNode = cand
        break outer
      }
    }
    if (!fnBodyNode) return source

    // Walk the function AST and collect nodes to remove:
    // 1. JSXAttribute nodes whose value is exactly {propName} or boolean shorthand.
    // 2. JSXExpressionContainer children that are plain {propName} text expressions.
    // Two edit kinds:
    // - 'removeAttr': delete the whole JSXAttribute node (+ leading whitespace cleanup)
    // - 'clearIdent': delete just the identifier inside {propName}, leaving {}
    // - 'removeContainer': delete the whole JSXExpressionContainer child (e.g. standalone {label})
    type PendingEdit =
      | { kind: 'removeAttr'; loc: AstLocFull }
      | { kind: 'clearIdent'; loc: AstLocFull }
      | { kind: 'removeContainer'; loc: AstLocFull }
    const pendingEdits: PendingEdit[] = []

    function walkNode(n: AstNode, parentType?: string): void {
      if (n.type === 'JSXAttribute') {
        const attrNameNode = (n as AstNode & { name?: AstNode & { name?: string } }).name
        const val = (n as AstNode & { value?: AstNode | null }).value
        const exprIdent = val?.type === 'JSXExpressionContainer'
          ? (val as AstNode & { expression?: AstNode & { name?: string; type?: string } }).expression
          : null
        const isDirectPropRef = exprIdent?.type === 'Identifier' && exprIdent.name === propName

        if (attrNameNode?.name === propName) {
          // Attribute name matches prop name — remove the entire attribute unconditionally.
          // The value may be a direct ref {propName}, a wrapper like {(e) => propName(...)},
          // or a boolean shorthand — all should go when the prop is deleted.
          const loc = n.loc as AstLocFull | undefined
          if (loc) pendingEdits.push({ kind: 'removeAttr', loc })
        } else if (isDirectPropRef) {
          // Different attribute name but value is {propName} — clear just the identifier to {}.
          const identLoc = exprIdent!.loc as AstLocFull | undefined
          if (identLoc) pendingEdits.push({ kind: 'clearIdent', loc: identLoc })
        }
        // Don't descend into attribute children — fully handled above.
        return
      }
      // {propName} used as a JSX child expression — remove the whole container.
      if (n.type === 'JSXExpressionContainer' && parentType !== 'JSXAttribute') {
        const expr = (n as AstNode & { expression?: AstNode & { name?: string } }).expression
        if (expr?.type === 'Identifier' && expr.name === propName) {
          const loc = n.loc as AstLocFull | undefined
          if (loc) pendingEdits.push({ kind: 'removeContainer', loc })
        }
      }
      for (const key of Object.keys(n)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue
        const child = (n as Record<string, unknown>)[key]
        if (Array.isArray(child)) {
          for (const c of child) {
            if (c && typeof c === 'object' && (c as AstNode).type) walkNode(c as AstNode, n.type)
          }
        } else if (child && typeof child === 'object' && (child as AstNode).type) {
          walkNode(child as AstNode, n.type)
        }
      }
    }
    walkNode(fnBodyNode)

    if (pendingEdits.length === 0) return source

    // Apply in reverse source order to preserve line/column indices.
    pendingEdits.sort((a, b) => b.loc.start.line - a.loc.start.line || b.loc.start.column - a.loc.start.column)
    let lines = source.split('\n')
    for (const edit of pendingEdits) {
      const { loc } = edit
      if (loc.start.line === loc.end.line) {
        const ln = lines[loc.start.line - 1]
        if (edit.kind === 'clearIdent') {
          // Replace the identifier with `undefined`, leaving a valid empty binding.
          lines[loc.start.line - 1] = ln.slice(0, loc.start.column) + 'undefined' + ln.slice(loc.end.column)
        } else {
          // removeAttr / removeContainer: strip the whole range + leading whitespace.
          const before = ln.slice(0, loc.start.column).replace(/\s+$/, '')
          const after = ln.slice(loc.end.column)
          const newLn = before + after
          if (newLn.trim().length > 0) {
            lines[loc.start.line - 1] = newLn
          } else {
            lines.splice(loc.start.line - 1, 1)
          }
        }
      } else {
        lines.splice(loc.start.line - 1, loc.end.line - loc.start.line + 1)
      }
    }
    return lines.join('\n')
  } catch {
    return source
  }
}

// Insert a new JSX attribute before the closing `>` or `/>` of the opening element.
function insertAttr(source: string, targetLine: number, attrName: string, attrValue: string, asExpression: boolean): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const root = ast.program as unknown as AstNode
    const jsxNode = findSmallestContainingNode(root, targetLine, (n) => n.type === 'JSXElement')
    if (!jsxNode) return source

    const opening = jsxNode.openingElement as AstNode | undefined
    const openLoc = opening?.loc as AstLocFull | undefined
    if (!openLoc) return source

    const lines = source.split('\n')
    const selfClosing = (opening as AstNode & { selfClosing?: boolean })?.selfClosing ?? false
    const endLine = openLoc.end.line - 1
    let endCol = openLoc.end.column

    const newAttrStr = asExpression ? ` ${attrName}={${attrValue}}` : ` ${attrName}="${attrValue}"`

    // Insert before the final `>` or `/>` character(s).
    const tailLen = selfClosing ? 2 : 1
    const line = lines[endLine]
    lines[endLine] = line.slice(0, endCol - tailLen) + newAttrStr + line.slice(endCol - tailLen)
    return lines.join('\n')
  } catch {
    return source
  }
}

// Add a new prop to the owning component's props interface/type + parameter destructure.
function addPropToOwnerSignature(
  source: string,
  ownerName: string,
  propName: string,
  propType: string,
  defaultValue?: string
): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body

    // 1. Find the props type/interface name from the component.
    let propsTypeName = ''
    let paramPatternLoc: AstLocFull | null = null
    let paramPatternNode: AstNode | null = null
    // Captured when the matched function has no params at all (case 4 bootstrap).
    let fnForBootstrap: { fn: AstNode; declStartLine: number } | null = null

    for (const node of body) {
      const nodeStartLine = (node.loc as AstLocFull | undefined)?.start.line ?? 1
      const candidates: AstNode[] = []
      if (node.type === 'FunctionDeclaration') candidates.push(node)
      if (
        (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') &&
        (node as AstNode & { declaration?: AstNode }).declaration
      ) {
        const decl = (node as AstNode & { declaration?: AstNode }).declaration!
        if (decl.type === 'FunctionDeclaration') candidates.push(decl)
        if (decl.type === 'VariableDeclaration') {
          for (const d of ((decl as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
            const id = (d as AstNode & { id?: AstNode & { name?: string } }).id
            if (id?.name === ownerName) {
              const fn = (d as AstNode & { init?: AstNode }).init
              if (fn) candidates.push(fn)
            }
          }
        }
      }
      if (node.type === 'VariableDeclaration') {
        for (const d of ((node as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
          const id = (d as AstNode & { id?: AstNode & { name?: string } }).id
          if (id?.name === ownerName) {
            const fn = (d as AstNode & { init?: AstNode }).init
            if (fn) candidates.push(fn)
          }
        }
      }

      for (const cand of candidates) {
        const fnId = (cand as AstNode & { id?: AstNode & { name?: string } }).id
        if (cand.type === 'FunctionDeclaration' && fnId?.name !== ownerName) continue
        const params = (cand as AstNode & { params?: AstNode[] })?.params ?? []
        const firstParam = params[0]
        if (!firstParam) {
          // No params at all — capture for bootstrap case 4.
          if (!fnForBootstrap) fnForBootstrap = { fn: cand, declStartLine: nodeStartLine }
          continue
        }
        const pattern =
          firstParam.type === 'ObjectPattern'
            ? firstParam
            : firstParam.type === 'AssignmentPattern'
            ? (firstParam as AstNode & { left?: AstNode }).left
            : null
        if (pattern?.type === 'ObjectPattern') {
          const ta = (pattern as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
          const ref = (ta as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
          propsTypeName =
            ref?.type === 'TSTypeReference'
              ? String((ref as AstNode & { typeName?: AstNode & { name?: string } }).typeName?.name ?? '')
              : ''
          paramPatternLoc = pattern.loc as AstLocFull | null
          paramPatternNode = pattern
        }
      }
      if (paramPatternLoc || propsTypeName) break
    }

    const lines = source.split('\n')

    // Helper: add propName to the destructure pattern in `lines` (in-place, no splice = no index shift).
    // Must be called BEFORE any lines.splice() so the loc-based indices are still valid.
    //
    // IMPORTANT: Babel's ObjectPattern.loc.end INCLUDES the `: TypeAnnotation` suffix,
    // so we must NOT use paramPatternLoc.end.column to locate `}`. Instead, when a
    // typeAnnotation is present we scan backward from its start column to find `}`.
    function applyDestructureInsertion() {
      if (!paramPatternNode || !paramPatternLoc) return
      const props = (paramPatternNode as AstNode & { properties?: AstNode[] }).properties ?? []
      // If a default value is provided, write `propName = defaultValue`; else just `propName`.
      const entry = defaultValue ? `${propName} = ${defaultValue}` : propName

      const typeAnn = (paramPatternNode as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
      const typeAnnLoc = typeAnn?.loc as AstLocFull | undefined

      let lineIdx: number
      let closingBraceCol: number

      if (typeAnnLoc) {
        // Scan backward from the `:` of `: TypeName` to find the closing `}` of the pattern.
        lineIdx = typeAnnLoc.start.line - 1
        let col = typeAnnLoc.start.column - 1
        const ln = lines[lineIdx]
        while (col > 0 && ln[col] !== '}') col--
        closingBraceCol = col  // index of `}`
      } else {
        // No type annotation: Babel's end.column correctly points just after `}`.
        lineIdx = paramPatternLoc.end.line - 1
        closingBraceCol = paramPatternLoc.end.column - 1  // index of `}`
      }

      const ln = lines[lineIdx]
      if (props.length === 0) {
        // Empty `{  }` — replace with `{ entry }` keeping everything after `}` intact.
        const startCol = paramPatternLoc.start.column
        lines[lineIdx] = ln.slice(0, startCol) + `{ ${entry} }` + ln.slice(closingBraceCol + 1)
      } else {
        // Insert `, entry` just before the closing `}`.
        lines[lineIdx] = ln.slice(0, closingBraceCol) + `, ${entry}` + ln.slice(closingBraceCol)
      }
    }
    if (propsTypeName) {
      for (const node of body) {
        if (node.type === 'TSInterfaceDeclaration') {
          const id = (node as AstNode & { id?: AstNode & { name?: string } }).id
          if (id?.name !== propsTypeName) continue
          const bodyNode = (node as AstNode & { body?: AstNode & { body?: AstNode[]; loc?: AstLocFull } }).body
          if (!bodyNode?.loc) continue
          const closingBrace = bodyNode.loc.end.line - 1
          const indent = lines[closingBrace].match(/^(\s*)/)?.[1] ?? '  '
          // Update destructure first (no splice → indices stay valid), then insert into interface.
          applyDestructureInsertion()
          lines.splice(closingBrace, 0, `${indent}${propName}?: ${propType}`)
          return lines.join('\n')
        }
        if (node.type === 'TSTypeAliasDeclaration') {
          const id = (node as AstNode & { id?: AstNode & { name?: string } }).id
          if (id?.name !== propsTypeName) continue
          const ta = (node as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
          if (ta?.type !== 'TSTypeLiteral') continue
          const taLoc = ta.loc as AstLocFull | undefined
          if (!taLoc) continue
          const closingBrace = taLoc.end.line - 1
          const indent = lines[closingBrace].match(/^(\s*)/)?.[1] ?? '  '
          // Update destructure first (no splice → indices stay valid), then insert into type.
          applyDestructureInsertion()
          lines.splice(closingBrace, 0, `${indent}${propName}?: ${propType}`)
          return lines.join('\n')
        }
      }
    }

    // 3. Fallback: append to destructure pattern (no named props type found).
    if (paramPatternLoc) {
      applyDestructureInsertion()
      return lines.join('\n')
    }

    // 4. Bootstrap: component has no params — create a new interface + destructured param.
    if (fnForBootstrap) {
      const { fn: fnAst, declStartLine } = fnForBootstrap
      const propsInterfaceName = `${ownerName}Props`

      // Avoid creating a duplicate interface.
      const alreadyExists = body.some(
        (n) =>
          (n.type === 'TSInterfaceDeclaration' || n.type === 'TSTypeAliasDeclaration') &&
          (n as AstNode & { id?: AstNode & { name?: string } }).id?.name === propsInterfaceName
      )

      // Babel provides character-offset `start` in addition to `loc`.
      const fnStart = (fnAst as AstNode & { start?: number }).start
      const fnBodyNode = (fnAst as AstNode & { body?: AstNode & { start?: number } }).body
      const bodyStart = fnBodyNode?.start

      if (!alreadyExists && typeof fnStart === 'number' && typeof bodyStart === 'number') {
        // Grab the signature text (e.g. `function LoginPage() ` or `() => `).
        const signature = source.slice(fnStart, bodyStart)
        const entry = defaultValue ? `${propName} = ${defaultValue}` : propName
        // Replace empty `()` with destructured props param.
        const newSignature = signature.replace(/\(\s*\)/, `({ ${entry} }: ${propsInterfaceName})`)
        if (newSignature !== signature) {
          const modified = source.slice(0, fnStart) + newSignature + source.slice(bodyStart)
          const modLines = modified.split('\n')
          // Insert the new interface before the declaration line (respects `export` prefix).
          const insertAt = Math.max(0, declStartLine - 1)
          modLines.splice(insertAt, 0,
            `interface ${propsInterfaceName} {`,
            `  ${propName}?: ${propType}`,
            `}`,
            ``
          )
          return modLines.join('\n')
        }
      }
    }

    return source
  } catch {
    return source
  }
}

// Rewrite the type annotation of a prop in the component's props interface/type.
function rewritePropType(source: string, _ownerName: string, propName: string, newType: string): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body
    const lines = source.split('\n')
    for (const node of body) {
      if (node.type === 'TSInterfaceDeclaration') {
        const members = (node as AstNode & { body?: AstNode & { body?: AstNode[] } }).body?.body ?? []
        for (const member of members) {
          if (member.type !== 'TSPropertySignature') continue
          const key = (member as AstNode & { key?: AstNode & { name?: string } }).key
          if (key?.name !== propName) continue
          const ta = (member as AstNode & { typeAnnotation?: AstNode & { typeAnnotation?: AstNode } }).typeAnnotation
          const actualType = ta?.typeAnnotation
          const loc = actualType?.loc as AstLocFull | undefined
          if (!loc || loc.start.line !== loc.end.line) continue
          const ln = lines[loc.start.line - 1]
          lines[loc.start.line - 1] = ln.slice(0, loc.start.column) + newType + ln.slice(loc.end.column)
          return lines.join('\n')
        }
      }
      if (node.type === 'TSTypeAliasDeclaration') {
        const ta = (node as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
        if (ta?.type !== 'TSTypeLiteral') continue
        const members = (ta as AstNode & { members?: AstNode[] }).members ?? []
        for (const member of members) {
          if (member.type !== 'TSPropertySignature') continue
          const key = (member as AstNode & { key?: AstNode & { name?: string } }).key
          if (key?.name !== propName) continue
          const typeAnn = (member as AstNode & { typeAnnotation?: AstNode & { typeAnnotation?: AstNode } }).typeAnnotation
          const actualType = typeAnn?.typeAnnotation
          const loc = actualType?.loc as AstLocFull | undefined
          if (!loc || loc.start.line !== loc.end.line) continue
          const ln = lines[loc.start.line - 1]
          lines[loc.start.line - 1] = ln.slice(0, loc.start.column) + newType + ln.slice(loc.end.column)
          return lines.join('\n')
        }
      }
    }
    return source
  } catch {
    return source
  }
}

// Rewrite the default value of a prop in the component destructure pattern.
// e.g. `{ type = 'text' }` → `{ type = 'button' }`
// If no default exists, inserts one: `{ type }` → `{ type = 'button' }`
function rewriteDefaultValue(source: string, ownerName: string, propName: string, newDefault: string): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body
    const lines = source.split('\n')

    // Locate the component function.
    const candidates: AstNode[] = []
    for (const node of body) {
      if (node.type === 'FunctionDeclaration') candidates.push(node)
      if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') {
        const decl = (node as AstNode & { declaration?: AstNode }).declaration
        if (decl?.type === 'FunctionDeclaration') candidates.push(decl)
        if (decl?.type === 'VariableDeclaration') {
          for (const d of ((decl as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
            const fn = (d as AstNode & { init?: AstNode }).init
            if (fn) candidates.push(fn)
          }
        }
      }
      if (node.type === 'VariableDeclaration') {
        for (const d of ((node as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
          const fn = (d as AstNode & { init?: AstNode }).init
          if (fn) candidates.push(fn)
        }
      }
    }

    for (const cand of candidates) {
      const fnId = (cand as AstNode & { id?: AstNode & { name?: string } }).id
      if (cand.type === 'FunctionDeclaration' && fnId?.name !== ownerName) continue
      const params = (cand as AstNode & { params?: AstNode[] })?.params ?? []
      const firstParam = params[0]
      if (!firstParam) continue
      const pattern = firstParam.type === 'ObjectPattern' ? firstParam
        : firstParam.type === 'AssignmentPattern' ? (firstParam as AstNode & { left?: AstNode }).left
        : null
      if (pattern?.type !== 'ObjectPattern') continue

      for (const prop of ((pattern as AstNode & { properties?: AstNode[] }).properties ?? [])) {
        const key = (prop as AstNode & { key?: AstNode & { name?: string } }).key
        if (key?.name !== propName) continue
        const valNode = (prop as AstNode & { value?: AstNode }).value

        if (valNode?.type === 'AssignmentPattern') {
          // Replace existing default value.
          const right = (valNode as AstNode & { right?: AstNode }).right
          const loc = right?.loc as AstLocFull | undefined
          if (loc && loc.start.line === loc.end.line) {
            const ln = lines[loc.start.line - 1]
            lines[loc.start.line - 1] = ln.slice(0, loc.start.column) + newDefault + ln.slice(loc.end.column)
            return lines.join('\n')
          }
        } else {
          // No existing default — insert after the prop name.
          const loc = prop.loc as AstLocFull | undefined
          if (loc && loc.start.line === loc.end.line) {
            const ln = lines[loc.start.line - 1]
            const endCol = loc.end.column
            lines[loc.start.line - 1] = ln.slice(0, endCol) + ' = ' + newDefault + ln.slice(endCol)
            return lines.join('\n')
          }
        }
        break
      }
    }
    return source
  } catch {
    return source
  }
}

// ── ScopePanel: hierarchy of props/state available to the selected node ───────

interface ScopePanelProps {
  layers: ScopeLayer[]
  inspectingComponent: boolean
  ownerProps: ComponentProp[]
  parentLocals: string[]
  parentSource: string
  parentComponentName: string
  usageAttrs: JsxAttr[]
  currentTag: string
}

function ScopePanel({ layers }: ScopePanelProps) {
  const [expanded, setExpanded] = useState(true)
  if (layers.length === 0) return null

  const totalUsed = layers.reduce((s, l) =>
    s + l.props.filter(i => i.usedInNode).length + l.state.filter(i => i.usedInNode).length, 0)

  return (
    <div style={scopeStyles.panel}>
      <button style={scopeStyles.header} onClick={() => setExpanded(v => !v)}>
        <span style={scopeStyles.chevron}>{expanded ? '▾' : '▸'}</span>
        <span>Scope</span>
        {totalUsed > 0 && (
          <span style={scopeStyles.usedBadge}>{totalUsed} used</span>
        )}
      </button>
      {expanded && (
        <div style={scopeStyles.body}>
          {[...layers].reverse().map((layer, ri) => {
            const depth = layers.length - 1 - ri
            return (
              <div key={layer.componentName} style={{ ...scopeStyles.layer, paddingLeft: 8 + depth * 12 }}>
                <div style={scopeStyles.layerHeader}>
                  <span style={layer.isCurrent ? scopeStyles.layerNameCurrent : scopeStyles.layerNameParent}>
                    {layer.isCurrent ? '▶ ' : '◦ '}{layer.componentName}
                  </span>
                  {layer.isCurrent && <span style={scopeStyles.currentBadge}>current</span>}
                </div>
                {layer.props.length > 0 && (
                  <div style={scopeStyles.group}>
                    <span style={scopeStyles.groupLabel}>props</span>
                    <div style={scopeStyles.items}>
                      {layer.props.map(item => <ScopeItemChip key={item.name} item={item} />)}
                    </div>
                  </div>
                )}
                {layer.state.length > 0 && (
                  <div style={scopeStyles.group}>
                    <span style={scopeStyles.groupLabel}>state</span>
                    <div style={scopeStyles.items}>
                      {layer.state.map(item => <ScopeItemChip key={item.name} item={item} />)}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ScopeItemChip({ item }: { item: ScopeItem }) {
  const [copied, setCopied] = useState(false)
  function handleClick() {
    navigator.clipboard.writeText(item.name).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <div
      style={{ ...scopeStyles.item, ...(item.usedInNode ? scopeStyles.itemUsed : {}), cursor: 'pointer' }}
      onClick={handleClick}
      title={`Copy "${item.name}" to clipboard`}
    >
      <span style={scopeStyles.itemDot}>{item.usedInNode ? '●' : '○'}</span>
      <code style={scopeStyles.itemName}>{copied ? '✓' : item.name}</code>
      {!copied && item.typeStr && <span style={scopeStyles.itemType}>{item.typeStr}</span>}
    </div>
  )
}

const scopeStyles: Record<string, React.CSSProperties> = {
  panel: {
    flexShrink: 0,
    borderBottom: '1px solid #1e1e2e',
    maxHeight: 280,
    display: 'flex',
    flexDirection: 'column',
    background: '#13131f',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.35rem',
    width: '100%',
    background: 'none',
    border: 'none',
    borderBottom: '1px solid #1e1e2e',
    color: '#7f849c',
    cursor: 'pointer',
    padding: '0.4rem 0.9rem',
    fontSize: '0.68rem',
    fontWeight: 700,
    textAlign: 'left' as const,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    flexShrink: 0,
  },
  chevron: { fontSize: '0.6rem', color: '#585b70', marginRight: 1 },
  usedBadge: {
    marginLeft: 'auto',
    fontSize: '0.67rem',
    color: '#a6e3a1',
    fontWeight: 600,
    background: 'rgba(166,227,161,0.1)',
    border: '1px solid rgba(166,227,161,0.25)',
    borderRadius: 10,
    padding: '1px 7px',
  },
  body: { overflowY: 'auto' as const, padding: '0.4rem 0 0.6rem' },
  layer: { marginBottom: 6 },
  layerHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    marginBottom: 4,
    paddingRight: 10,
  },
  layerNameCurrent: {
    fontSize: '0.75rem',
    fontWeight: 700,
    color: '#89b4fa',
    letterSpacing: '0.01em',
  },
  layerNameParent: {
    fontSize: '0.72rem',
    color: '#6c7086',
    letterSpacing: '0.01em',
  },
  currentBadge: {
    marginLeft: 'auto',
    fontSize: '0.6rem',
    color: '#1e1e2e',
    background: '#89b4fa',
    borderRadius: 10,
    padding: '1px 7px',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
  },
  group: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 5,
    marginBottom: 3,
    paddingLeft: 14,
  },
  groupLabel: {
    fontSize: '0.58rem',
    color: '#45475a',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.07em',
    minWidth: 30,
    paddingTop: 3,
    flexShrink: 0,
  },
  items: { display: 'flex', flexWrap: 'wrap' as const, gap: '3px 4px' },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    fontSize: '0.71rem',
    color: '#45475a',
    padding: '2px 7px',
    borderRadius: 99,
    background: 'transparent',
    border: '1px solid #2a2a3d',
  },
  itemUsed: {
    color: '#b4cefa',
    background: 'rgba(137,180,250,0.1)',
    border: '1px solid rgba(137,180,250,0.28)',
  },
  itemDot: { fontSize: '0.5rem' },
  itemName: {
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '0.7rem',
    fontWeight: 500,
  },
  itemType: {
    fontSize: '0.62rem',
    color: '#45475a',
    fontStyle: 'italic' as const,
    marginLeft: 1,
  },
}

// ── component ─────────────────────────────────────────────────────────────────

export function InspectorPanel({
  file,
  line,
  inspectMode,
  componentName,
  selectedNode,
  rootComponentName,
  onClose,
  onWidthChange,
}: InspectorPanelProps) {
  const [panelWidth, setPanelWidth] = useState(480)

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelWidth
    function onMove(ev: PointerEvent) {
      const newW = Math.max(320, Math.min(900, startW - (ev.clientX - startX)))
      setPanelWidth(newW)
      onWidthChange?.(newW)
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const [activeTab, setActiveTab] = useState<Tab>('bindings')

  // True when the inspected node belongs to a child component — all edits are disabled.
  // Read-only only for DOM nodes explicitly owned by a non-root child component.
  // Component nodes (uppercase tag) are always editable — selecting one edits the props
  // passed TO it from the root's JSX, which is fair game regardless of which component it is.
  const isReadOnly = !!rootComponentName && !!selectedNode && (
    !/^[A-Z]/.test(selectedNode.tag) &&
    !!selectedNode.ownerComponentName &&
    selectedNode.ownerComponentName !== rootComponentName
  )
  const [displayCode, setDisplayCode] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [blockName, setBlockName] = useState<string>('')
  const [fileImports, setFileImports] = useState<string[]>([])
  const [importsExpanded, setImportsExpanded] = useState(true)
  // Scope hierarchy — replaces the imports panel.
  const [scopeLayers, setScopeLayers] = useState<ScopeLayer[]>([])

  // ── bindings tab state ──────────────────────────────────────────────────────
  const [jsxAttrs, setJsxAttrs] = useState<JsxAttr[]>([])
  const [ownerProps, setOwnerProps] = useState<ComponentProp[]>([])
  const [attrEdits, setAttrEdits] = useState<Record<string, string>>({})
  const [propTypeEdits, setPropTypeEdits] = useState<Record<string, string>>({})
  const [propValueEdits, setPropValueEdits] = useState<Record<string, string>>({})
  const [propDefaultEdits, setPropDefaultEdits] = useState<Record<string, string>>({})
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  // Attrs passed to this component at usage sites in the parent (e.g. <Input value={email}>)
  const [usageAttrs, setUsageAttrs] = useState<JsxAttr[]>([])
  // Which parent file + line the usage was found at (needed to write back value edits).
  const [usageInfo, setUsageInfo] = useState<{ file: string; line: number } | null>(null)
  // Local variable names from the parent component — used as datalist options for value fields.
  const [parentLocals, setParentLocals] = useState<string[]>([])
  // Parent source + component name, kept so type inference can run without an extra fetch.
  const [parentSource, setParentSource] = useState('')
  const [parentComponentName, setParentComponentName] = useState('')
  // Live input text while an attr field is focused (cleared on focus so datalist shows all options).
  const [focusedAttr, setFocusedAttr] = useState<string | null>(null)
  const [bindingsSaving, setBindingsSaving] = useState(false)
  // New-prop creation state
  const [newPropName, setNewPropName] = useState('')
  const [newPropType, setNewPropType] = useState('string')
  const [newPropValue, setNewPropValue] = useState('')
  const [newPropMode, setNewPropMode] = useState<'variable' | 'entry'>('entry')
  const [newPropAsExpr, setNewPropAsExpr] = useState(false)
  const [newPropTypeInferred, setNewPropTypeInferred] = useState(false)
  const [showAddProp, setShowAddProp] = useState(false)
  /** Per-prop value mode for existing binding rows ('variable' = expression, 'entry' = literal). */
  const [propValueMode, setPropValueMode] = useState<Record<string, 'variable' | 'entry'>>({})
  /** True when the selected tree node is a React component (not a raw DOM element). */
  const [inspectingComponent, setInspectingComponent] = useState(false)
  /** True when the inspected component has a named props interface/type registered. */
  const [hasPropTypeDef, setHasPropTypeDef] = useState(true)
  const [deletingProp, setDeletingProp] = useState<string | null>(null)
  // Shared save status used by both source tab and bindings mutations.
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const fullSourceRef = useRef<string>('')
  const blockRangeRef = useRef<BlockRange | null>(null)
  const prevFileRef = useRef<string>('')
  const lastValidSourceRef = useRef<string>('')
  const modelChangeDisposableRef = useRef<IDisposable | null>(null)
  const extraLibDisposableRef = useRef<IDisposable | null>(null)
  const contextLoadSeqRef = useRef(0)
  const diagnosticsTimerRef = useRef<number | null>(null)

  function buildFullSourceFromEditorValue(editedValue: string): string {
    const range = blockRangeRef.current
    const full = fullSourceRef.current
    if (!range || !full) return editedValue

    const lines = full.split('\n')
    return [
      ...lines.slice(0, range.startLine),
      editedValue,
      ...lines.slice(range.endLine + 1),
    ].join('\n')
  }

  function configureMonacoForInspector(monaco: Monaco) {
    const compilerOptions = {
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
      allowNonTsExtensions: true,
      allowJs: true,
      esModuleInterop: true,
      skipLibCheck: true,
      strict: false,
    }

    monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions)
    monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions)

    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSyntaxValidation: false,
      noSemanticValidation: true,
      noSuggestionDiagnostics: false,
    })
  }

  async function syncServerDiagnostics(filePath: string, content: string) {
    const monaco = monacoRef.current
    const ed = editorRef.current
    if (!monaco || !ed) return
    const model = ed.getModel()
    if (!model) return

    try {
      const res = await fetch('/__diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: filePath, content }),
      })
      const payload = await res.json()
      if (!res.ok) return

      const currentRange = blockRangeRef.current
      const isFileMode = inspectMode === 'file' || !currentRange
      const markers: editor.IMarkerData[] = ((payload.diagnostics as ServerDiagnostic[]) ?? [])
        .filter((d) => {
          if (isFileMode) return true
          return d.endLineNumber >= currentRange.startLine + 1 && d.startLineNumber <= currentRange.endLine + 1
        })
        .map((d) => {
          if (isFileMode) {
            return {
              code: String(d.code),
              message: d.message,
              severity: d.severity,
              startLineNumber: d.startLineNumber,
              startColumn: d.startColumn,
              endLineNumber: d.endLineNumber,
              endColumn: d.endColumn,
            }
          }

          const startLineNumber = Math.max(1, d.startLineNumber - currentRange.startLine)
          const endLineNumber = Math.max(startLineNumber, d.endLineNumber - currentRange.startLine)
          return {
            code: String(d.code),
            message: d.message,
            severity: d.severity,
            startLineNumber,
            startColumn: d.startColumn,
            endLineNumber,
            endColumn: d.endColumn,
          }
        })

      monaco.editor.setModelMarkers(model, 'server-tsc', markers)
    } catch {
      // Keep existing markers when diagnostics endpoint is temporarily unavailable.
    }
  }

  function scheduleDiagnostics(filePath: string, content: string) {
    if (diagnosticsTimerRef.current != null) {
      window.clearTimeout(diagnosticsTimerRef.current)
    }
    diagnosticsTimerRef.current = window.setTimeout(() => {
      void syncServerDiagnostics(filePath, content)
    }, 220)
  }

  async function fetchSourceFile(filePath: string): Promise<string | null> {
    try {
      const res = await fetch(`/__source?file=${encodeURIComponent(filePath)}`)
      if (!res.ok) return null
      return await res.text()
    } catch {
      return null
    }
  }

  async function syncContextModels(entryFile: string, entrySource: string) {
    const monaco = monacoRef.current
    if (!monaco) return

    const seq = ++contextLoadSeqRef.current
    const moduleUsage = new Map<string, BareModuleUsage>()
    const attempted = new Set<string>()

    async function walk(filePath: string, source: string, depth: number) {
      if (depth > 3 || seq !== contextLoadSeqRef.current) return

      const relativeImports = collectModuleUsages(source, moduleUsage)
      for (const specifier of relativeImports) {
        for (const candidate of candidateImportFiles(filePath, specifier)) {
          const normalized = normalizePath(candidate)
          if (attempted.has(normalized)) continue
          attempted.add(normalized)

          const text = await fetchSourceFile(normalized)
          if (text == null) continue

          const uri = monaco.Uri.parse(filePathToModelUri(normalized))
          const existing = monaco.editor.getModel(uri)
          if (existing) existing.setValue(text)
          else monaco.editor.createModel(text, 'typescript', uri)

          await walk(normalized, text, depth + 1)
          break
        }
      }
    }

    await walk(normalizePath(entryFile), entrySource, 0)
    if (seq !== contextLoadSeqRef.current) return

    extraLibDisposableRef.current?.dispose()
    const declarations = buildBareModuleDeclarations(moduleUsage)
    extraLibDisposableRef.current = monaco.languages.typescript.typescriptDefaults.addExtraLib(
      declarations,
      'inmemory://model/inspector-external-modules.d.ts'
    )
  }

  // ── Monaco undo/redo wrapper ─────────────────────────────────────────────────
  // Writes a new full-source snapshot into the Monaco model as a single undoable
  // edit, updates fullSourceRef, re-syncs bindings, then immediately persists to
  // disk.  All bindings mutations funnel through here so Monaco's history covers
  // prop/attr adds, deletes and value changes without any custom stack.
  async function pushToMonacoAndSave(newFullSource: string): Promise<boolean> {
    fullSourceRef.current = newFullSource

    // Update Monaco model — this creates an undo point.
    const ed = editorRef.current
    const model = ed?.getModel()
    if (ed && model) {
      const newBlockContent = (() => {
        const r = blockRangeRef.current
        if (!r) return newFullSource
        return newFullSource.split('\n').slice(r.startLine, r.endLine + 1).join('\n')
      })()
      const fullRange = model.getFullModelRange()
      model.pushEditOperations(
        [],
        [{ range: fullRange, text: newBlockContent }],
        () => null
      )
      setDisplayCode(newBlockContent)
    }

    // Persist to disk.
    try {
      const res = await fetch('/__source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, content: newFullSource }),
      })
      if (!res.ok) { setSaveStatus('error'); return false }
      setSaveStatus('saved')
      refreshBindings(newFullSource, selectedNode)
      return true
    } catch {
      setSaveStatus('error')
      return false
    }
  }

  function triggerUndo() {
    const ed = editorRef.current
    if (!ed) return
    ed.trigger('keyboard', 'undo', null)
    const model = ed.getModel()
    if (model) {
      const newFull = buildFullSourceFromEditorValue(model.getValue())
      fullSourceRef.current = newFull
      const newBlockContent = (() => {
        const r = blockRangeRef.current
        if (!r) return newFull
        return newFull.split('\n').slice(r.startLine, r.endLine + 1).join('\n')
      })()
      setDisplayCode(newBlockContent)
      refreshBindings(newFull, selectedNode)
      void (async () => {
        const res = await fetch('/__source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file, content: newFull }),
        })
        if (res.ok) setSaveStatus('saved')
      })()
    }
  }

  function triggerRedo() {
    const ed = editorRef.current
    if (!ed) return
    ed.trigger('keyboard', 'redo', null)
    const model = ed.getModel()
    if (model) {
      const newFull = buildFullSourceFromEditorValue(model.getValue())
      fullSourceRef.current = newFull
      const newBlockContent = (() => {
        const r = blockRangeRef.current
        if (!r) return newFull
        return newFull.split('\n').slice(r.startLine, r.endLine + 1).join('\n')
      })()
      setDisplayCode(newBlockContent)
      refreshBindings(newFull, selectedNode)
      void (async () => {
        const res = await fetch('/__source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file, content: newFull }),
        })
        if (res.ok) setSaveStatus('saved')
      })()
    }
  }

  // ── bindings: extract attrs + owner props from source after node selection ──
  // Called after source is loaded OR after selectedNode changes.
  function refreshBindings(source: string, node: SelectedNodeContext | null | undefined) {
    if (!node) {
      setJsxAttrs([])
      setOwnerProps([])
      setAttrEdits({})
      setInspectingComponent(false)
      setHasPropTypeDef(true)
      setScopeLayers([])
      return
    }

    // A capitalised tag means the tree selected a React component node, not a raw DOM element.
    const isComponentNode = /^[A-Z]/.test(node.tag)
    setInspectingComponent(isComponentNode)

    if (isComponentNode) {
      // Show the component's own declared props (signature + interface/type).
      // No JSX attr extraction needed — we don't have the usage-site source here.
      setJsxAttrs([])
      const ownerP = extractOwnerProps(source, node.tag)
      setOwnerProps(ownerP)
      setHasPropTypeDef(componentHasPropTypeDef(source, node.tag))
    // Component mode: build an initial scope layer from just the child's own props (no usage data yet).
    const ownerPCapture = ownerP
    const sourceCapture = source
    const tagCapture = node.tag
    setScopeLayers([{
      componentName: tagCapture,
      isCurrent: true,
      props: ownerPCapture.filter(p => p.source === 'owner').map(p => ({ name: p.name, typeStr: p.typeStr, usedInNode: false })),
      state: extractComponentLocals(sourceCapture, tagCapture)
        .filter(n => !ownerPCapture.find(p => p.name === n))
        .map(n => ({ name: n, typeStr: inferTypeOfLocal(sourceCapture, tagCapture, n), usedInNode: false })),
    }])
    setAttrEdits({})
    setPropTypeEdits({})
    setPropValueEdits({})
    setPropDefaultEdits({})
    setExpandedRows(new Set())
    setPropValueMode({})
    setUsageAttrs([])
    setParentLocals([])
    setParentSource('')
    setParentComponentName('')
    setUsageInfo(null)
      // Asynchronously find all usage sites of this component in the project and
      // extract the attrs being passed there — populates the "currently passed" value column.
      // Also extract the parent component's local variables for the value-field datalist.
      const tag = node.tag
      void (async () => {
        const usages = findLocatorUsages(tag)
        if (usages.length === 0) return
        // Try each usage file until we get a non-empty attr set.
        for (const { file: usageFile, line: usageLine } of usages) {
          try {
            const res = await fetch(`/__source?file=${encodeURIComponent(usageFile)}`)
            if (!res.ok) continue
            const usageSource = await res.text()
            const attrs = extractJsxAttrs(usageSource, usageLine)
            if (attrs.length > 0) {
              setUsageAttrs(attrs)
              setUsageInfo({ file: usageFile, line: usageLine })
              // Initialize per-prop value mode from whether the attr is currently an expression.
              const initModes: Record<string, 'variable' | 'entry'> = {}
              for (const a of attrs) {
                if (!a.isSpread) initModes[a.name] = a.isExpression ? 'variable' : 'entry'
              }
              setPropValueMode(initModes)
              // Extract local variables from the wrapping component in the parent file.
              const parentName = inferOwnerComponentName(usageSource, usageLine)
              if (parentName) {
                const pLocals = extractComponentLocals(usageSource, parentName)
                setParentLocals(pLocals)
                setParentSource(usageSource)
                setParentComponentName(parentName)
                // Rebuild scope layers now that we have parent data.
                const passedNames = new Set(attrs.filter(a => !a.isSpread).map(a => a.name))
                const passedValues = new Set(attrs.filter(a => !a.isSpread).map(a => a.rawValue.replace(/^\{|\}$/g, '').trim()))
                const childProps = ownerPCapture.filter(p => p.source === 'owner')
                  .map(p => ({ name: p.name, typeStr: p.typeStr, usedInNode: passedNames.has(p.name) }))
                const childState = extractComponentLocals(sourceCapture, tagCapture)
                  .filter(n => !ownerPCapture.find(p => p.name === n))
                  .map(n => ({ name: n, typeStr: inferTypeOfLocal(sourceCapture, tagCapture, n), usedInNode: false }))
                const parentPropsArr = extractOwnerProps(usageSource, parentName)
                const parentPropItems = parentPropsArr.filter(p => p.source === 'owner')
                  .map(p => ({ name: p.name, typeStr: p.typeStr, usedInNode: passedValues.has(p.name) }))
                const parentStateItems = pLocals
                  .filter(n => !parentPropsArr.find(p => p.name === n))
                  .map(n => ({ name: n, typeStr: inferTypeOfLocal(usageSource, parentName, n), usedInNode: passedValues.has(n) }))
                setScopeLayers([
                  { componentName: parentName, isCurrent: false, props: parentPropItems, state: parentStateItems },
                  { componentName: tagCapture, isCurrent: true, props: childProps, state: childState },
                ])
              }
              break
            }
          } catch { /* skip */ }
        }
      })()
      return
    }

    // DOM node: extract JSX attrs at the locator line + owner props for the dropdown.
    const locLine = node.locatorLine ?? line
    const attrs = extractJsxAttrs(source, locLine)
    setJsxAttrs(attrs)

    const initialEdits: Record<string, string> = {}
    for (const a of attrs) {
      if (!a.isSpread) initialEdits[a.name] = a.rawValue
    }
    setAttrEdits(initialEdits)
    setFocusedAttr(null)

    const ownerName = node.ownerComponentName ?? componentName
      ?? (node.locatorFile ? inferOwnerComponentName(source, locLine) : '')
    const ownerP = ownerName ? extractOwnerProps(source, ownerName) : []

    // Merge: element-bound attrs not already in owner props become extra dropdown options.
    const elementOnly: ComponentProp[] = attrs
      .filter((a) => !a.isSpread && !ownerP.find((p) => p.name === a.name))
      .map((a) => ({ name: a.name, typeStr: '', source: 'element' as const }))

    setOwnerProps([...ownerP, ...elementOnly])

    // Build scope layers for the hierarchy panel.
    // Layer 0 = owner component of this DOM node (innermost).
    // Layer 1 = parent component (if we have parentSource from a previous component-node selection).
    const usedNames = new Set(attrs.filter(a => !a.isSpread).map(a => a.rawValue.replace(/^\{|\}$/g, '').trim()))
    const makeItems = (props: ComponentProp[], localNames: string[]): { props: ScopeItem[]; state: ScopeItem[] } => {
      const propItems: ScopeItem[] = props
        .filter(p => p.source === 'owner')
        .map(p => ({ name: p.name, typeStr: p.typeStr, usedInNode: usedNames.has(p.name) }))
      const stateItems: ScopeItem[] = localNames
        .filter(n => !props.find(p => p.name === n))
        .map(n => ({ name: n, typeStr: inferTypeOfLocal(source, ownerName, n), usedInNode: usedNames.has(n) }))
      return { props: propItems, state: stateItems }
    }
    const ownerLocals = ownerName ? extractComponentLocals(source, ownerName) : []
    const { props: op, state: os } = makeItems(ownerP, ownerLocals)
    const layers: ScopeLayer[] = [{ componentName: ownerName || node.tag, isCurrent: true, props: op, state: os }]
    setScopeLayers(layers)
    setHasPropTypeDef(true) // DOM nodes don't need prop type defs
  }

  function applyBlock(source: string, targetLine: number) {
    const block = extractBlock(source, targetLine, { inspectMode, componentName })
    const isFileMode = inspectMode === 'file'
    blockRangeRef.current = block.range
    setBlockName(block.name)
    setDisplayCode(block.code)
    lastValidSourceRef.current = block.code
    // Highlight the clicked line relative to the block start.
    requestAnimationFrame(() => {
      const ed = editorRef.current
      const monaco = monacoRef.current
      if (!ed || !monaco) return
      const lineInModel = isFileMode
        ? Math.max(targetLine, 1)
        : Math.max(targetLine - block.range.startLine, 1)
      ed.revealLineInCenter(lineInModel)
      const blockLines = Math.max(block.code.split('\n').length, 1)
      ed.setSelection(new monaco.Selection(1, 1, blockLines, 1))
      ed.deltaDecorations([], [{
        range: new monaco.Range(lineInModel, 1, lineInModel, 1),
        options: { isWholeLine: true, className: 'highlighted-line' },
      }])
    })
  }

  useEffect(() => {
    if (!file) return
    setSaveStatus('idle')
    if (file !== prevFileRef.current) {
      // New file — fetch then extract.
      prevFileRef.current = file
      setLoading(true)
      fetch(`/__source?file=${encodeURIComponent(file)}`)
        .then((r) => {
          if (!r.ok) throw new Error(`Server error ${r.status}`)
          return r.text()
        })
        .then((text) => {
          fullSourceRef.current = text
          setFileImports(extractImports(text))
          void syncContextModels(file, text)
          scheduleDiagnostics(file, text)
          applyBlock(text, line)
          refreshBindings(text, selectedNode)
        })
        .catch((err) => setDisplayCode(`// Error loading file\n// ${err.message}`))
        .finally(() => setLoading(false))
    } else if (fullSourceRef.current) {
      // Same file, different element — re-extract without a network round-trip.
      void syncContextModels(file, fullSourceRef.current)
      scheduleDiagnostics(file, fullSourceRef.current)
      applyBlock(fullSourceRef.current, line)
      refreshBindings(fullSourceRef.current, selectedNode)
    } else {
      setFileImports([])
    }
  }, [file, line, inspectMode, componentName]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-run bindings extraction when selectedNode changes (DOM selection in tree)
  // without re-fetching source.
  useEffect(() => {
    if (fullSourceRef.current) refreshBindings(fullSourceRef.current, selectedNode)
    if (!selectedNode) return
    setActiveTab('bindings')
  }, [selectedNode]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      modelChangeDisposableRef.current?.dispose()
      extraLibDisposableRef.current?.dispose()
      if (diagnosticsTimerRef.current != null) {
        window.clearTimeout(diagnosticsTimerRef.current)
      }
    }
  }, [])

  // ── bindings mutations — all route through pushToMonacoAndSave ─────────────
  async function handleDeleteProp(propName: string) {
    setDeletingProp(propName)
    try {
      const freshRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
      if (!freshRes.ok) return
      let modified = await freshRes.text()

      const ownerName = selectedNode?.ownerComponentName ?? componentName ?? ''
      if (inspectingComponent) {
        // Remove from signature + interface, then remove all {propName} usages in JSX body.
        if (ownerName) {
          modified = removePropFromOwnerSignature(modified, ownerName, propName)
          modified = removePropUsagesInBody(modified, ownerName, propName)
        }
      } else {
        // Remove the JSX attribute from the element.
        const attrInfo = jsxAttrs.find(a => a.name === propName)
        modified = removeAttr(modified, selectedNode?.locatorLine ?? line, propName)
        // If the removed attribute was a direct prop reference (value={propName}),
        // also remove the prop from the owner component's signature.
        if (ownerName && attrInfo && attrInfo.isExpression && !attrInfo.isSpread && attrInfo.rawValue === propName) {
          modified = removePropFromOwnerSignature(modified, ownerName, propName)
        }
      }
      await pushToMonacoAndSave(modified)
    } finally {
      setDeletingProp(null)
    }
  }

  async function handlePropTypeSave() {
    if (!fullSourceRef.current || (Object.keys(propTypeEdits).length === 0 && Object.keys(propValueEdits).length === 0 && Object.keys(propDefaultEdits).length === 0)) return
    setBindingsSaving(true)
    try {
      const ownerName = selectedNode?.ownerComponentName ?? componentName ?? ''

      // ── Value edits: write to the PARENT file's JSX usage site ─────────────
      if (Object.keys(propValueEdits).length > 0 && usageInfo) {
        const parentRes = await fetch(`/__source?file=${encodeURIComponent(usageInfo.file)}`)
        if (!parentRes.ok) throw new Error('Fetch parent failed')
        let parentSrc = await parentRes.text()
        for (const [propName, newVal] of Object.entries(propValueEdits)) {
          const original = usageAttrs.find((a) => a.name === propName)
          // Skip if unchanged from what the parent is already passing.
          if (original && newVal === original.rawValue) continue
          // Use propValueMode to determine whether to write as expression or string literal.
          const modeIsVar = (propValueMode[propName] ?? (original?.isExpression ? 'variable' : 'entry')) === 'variable'
          parentSrc = rewriteAttrValue(parentSrc, usageInfo.line, propName, newVal, modeIsVar)
        }
        // Persist parent file directly (it's a different file — don't push through Monaco).
        await fetch('/__source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: usageInfo.file, content: parentSrc }),
        })
        // Refresh usageAttrs from the updated source.
        setUsageAttrs(extractJsxAttrs(parentSrc, usageInfo.line))
      }

      // ── Type + default edits: write to the CHILD component file ────────────
      if (Object.keys(propTypeEdits).length > 0 || Object.keys(propDefaultEdits).length > 0) {
        const freshRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
        if (!freshRes.ok) throw new Error('Fetch failed')
        let modified = await freshRes.text()
        for (const [propName, newType] of Object.entries(propTypeEdits)) {
          const original = ownerProps.find((p) => p.name === propName)
          if (!original || newType === original.typeStr) continue
          modified = rewritePropType(modified, ownerName, propName, newType)
        }
        for (const [propName, newDefault] of Object.entries(propDefaultEdits)) {
          const original = ownerProps.find((p) => p.name === propName)
          if (newDefault === (original?.defaultValue ?? '')) continue
          modified = rewriteDefaultValue(modified, ownerName, propName, newDefault)
        }
        const ok = await pushToMonacoAndSave(modified)
        if (!ok) return
      }

      setPropTypeEdits({})
      setPropValueEdits({})
      setPropDefaultEdits({})
    } catch {
      setSaveStatus('error')
    } finally {
      setBindingsSaving(false)
    }
  }

  async function handleBindingsSave() {
    if (!fullSourceRef.current) return
    setBindingsSaving(true)
    try {
      const freshRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
      if (!freshRes.ok) throw new Error('Fetch failed')
      let modified = await freshRes.text()
      const nodeLocLine = selectedNode?.locatorLine ?? line
      for (const [attrName, val] of Object.entries(attrEdits)) {
        const original = jsxAttrs.find((a) => a.name === attrName)
        if (!original || val === original.rawValue) continue
        const asExpr = val.startsWith('{') ? false : original.isExpression
        modified = rewriteAttrValue(modified, nodeLocLine, attrName, val, asExpr)
      }
      await pushToMonacoAndSave(modified)
    } catch {
      setSaveStatus('error')
    } finally {
      setBindingsSaving(false)
    }
  }

  async function handleRegisterPropTypes() {
    if (!inspectingComponent || !selectedNode) return
    const tag = selectedNode.tag
    const freshRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
    if (!freshRes.ok) return
    const source = await freshRes.text()
    try {
      const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
      const body = (ast.program as unknown as { body: AstNode[] }).body
      const propsTypeName = `${tag}Props`

      // ── 1. Find the component function node ─────────────────────────────────
      let fnNode: AstNode | null = null
      let declLine = 1
      for (const node of body) {
        const nodeStartLine = (node.loc as AstLocFull | undefined)?.start.line ?? 1
        const candidates: AstNode[] = []
        if (node.type === 'FunctionDeclaration') candidates.push(node)
        const exported = (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration')
          ? (node as AstNode & { declaration?: AstNode }).declaration : undefined
        if (exported?.type === 'FunctionDeclaration') candidates.push(exported)
        const varDecl = exported?.type === 'VariableDeclaration' ? exported
          : node.type === 'VariableDeclaration' ? node : null
        if (varDecl) {
          for (const d of ((varDecl as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
            const id = (d as AstNode & { id?: AstNode & { name?: string } }).id
            if (id?.name === tag) {
              const fn = (d as AstNode & { init?: AstNode }).init
              if (fn) { candidates.push(fn); declLine = nodeStartLine }
            }
          }
        }
        for (const cand of candidates) {
          const fnId = (cand as AstNode & { id?: AstNode & { name?: string } }).id
          if (cand.type === 'FunctionDeclaration' && fnId?.name !== tag) continue
          fnNode = cand
          declLine = nodeStartLine
          break
        }
        if (fnNode) break
      }
      if (!fnNode) return

      // ── 2. Extract destructured props + infer types from default values ──────
      //   Handles: { a, b = 'x', c = 42, d = {color:'red'}, e = () => {} }
      const params = (fnNode as AstNode & { params?: AstNode[] })?.params ?? []
      const firstParam = params[0]
      const pattern = firstParam?.type === 'ObjectPattern' ? firstParam
        : firstParam?.type === 'AssignmentPattern'
          ? (firstParam as AstNode & { left?: AstNode }).left
          : null

      // Collect { name, inferredType, hasExplicitType } for each prop.
      interface PropDraft { name: string; type: string; hasExplicit: boolean }
      const propDrafts: PropDraft[] = []

      if (pattern?.type === 'ObjectPattern') {
        // Check if there's already a referenced props type we can pull from.
        const existingTypeRef = (() => {
          const ta = (pattern as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
          const ref = (ta as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
          return ref?.type === 'TSTypeReference'
            ? String((ref as AstNode & { typeName?: AstNode & { name?: string } }).typeName?.name ?? '')
            : ''
        })()
        const existingMembers: ComponentProp[] = []
        if (existingTypeRef) enrichWithTypeDeclaration(body, existingTypeRef, existingMembers)

        for (const prop of ((pattern as AstNode & { properties?: AstNode[] }).properties ?? [])) {
          if (prop.type === 'RestElement') continue
          const key = (prop as AstNode & { key?: AstNode & { name?: string } }).key
          if (!key?.name) continue
          const valNode = (prop as AstNode & { value?: AstNode }).value

          // Check if an explicit type exists in the referenced interface already.
          const fromInterface = existingMembers.find(m => m.name === key.name)
          if (fromInterface?.typeStr && fromInterface.typeStr !== 'unknown') {
            propDrafts.push({ name: key.name, type: fromInterface.typeStr, hasExplicit: true })
            continue
          }

          // Infer from default value (AssignmentPattern.right).
          let inferred = 'unknown'
          let hasExplicit = false
          if (valNode?.type === 'AssignmentPattern') {
            const right = (valNode as AstNode & { right?: AstNode }).right
            inferred = inferTypeFromExpression(right)
          } else if (valNode?.type === 'TSParameterProperty') {
            hasExplicit = true
          }
          // Fall back to explicit TS type annotation on the value node itself.
          const typeAnn = (valNode as AstNode & { typeAnnotation?: AstNode } | undefined)?.typeAnnotation
          if (typeAnn) {
            const t = stringifyTSType((typeAnn as AstNode & { typeAnnotation?: AstNode }).typeAnnotation)
            if (t) { inferred = t; hasExplicit = true }
          }
          propDrafts.push({ name: key.name, type: inferred, hasExplicit })
        }
      }

      // ── 3. Figure out what already exists ────────────────────────────────────
      const existingInterfaceNode = body.find(
        (n) => (n.type === 'TSInterfaceDeclaration' || n.type === 'TSTypeAliasDeclaration') &&
          (n as AstNode & { id?: AstNode & { name?: string } }).id?.name === propsTypeName
      ) ?? null

      const lines = source.split('\n')

      // ── 4. Build the interface member lines ──────────────────────────────────
      const indent = '  '
      const memberLines = propDrafts.map(p => `${indent}${p.name}?: ${p.type}`)

      // ── 5. Compute new signature (add `: PropsTypeName` to the pattern) ──────
      const fnStart = (fnNode as AstNode & { start?: number }).start
      const fnBodyNode = (fnNode as AstNode & { body?: AstNode & { start?: number } }).body
      const bodyStart = fnBodyNode?.start
      if (typeof fnStart !== 'number' || typeof bodyStart !== 'number') return

      const signature = source.slice(fnStart, bodyStart)
      let newSignature: string

      if (!firstParam) {
        newSignature = signature.replace(/\(\s*\)/, `({}: ${propsTypeName})`)
      } else if (pattern?.type === 'ObjectPattern') {
        // Check if type annotation already references our type — then no-op this part.
        const ta = (pattern as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
        const ref = (ta as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
        const alreadyAnnotated = ref?.type === 'TSTypeReference' &&
          (ref as AstNode & { typeName?: AstNode & { name?: string } }).typeName?.name === propsTypeName
        if (alreadyAnnotated) {
          newSignature = signature // nothing to change in the signature
        } else {
          const relEnd = (pattern as AstNode & { end?: number }).end
          if (typeof relEnd !== 'number') return
          const posInSig = relEnd - fnStart
          newSignature = signature.slice(0, posInSig) + `: ${propsTypeName}` + signature.slice(posInSig)
        }
      } else {
        return // unexpected shape
      }

      // ── 6. Apply changes to source ────────────────────────────────────────────
      let modified = source.slice(0, fnStart) + newSignature + source.slice(bodyStart)
      const modLines = modified.split('\n')

      if (!existingInterfaceNode) {
        // Create brand-new interface before the function declaration.
        const insertAt = Math.max(0, declLine - 1)
        modLines.splice(insertAt, 0,
          `interface ${propsTypeName} {`,
          ...memberLines,
          `}`,
          ``
        )
      } else if (memberLines.length > 0) {
        // Interface exists — check if its body is empty and fill it in.
        const intfBody = existingInterfaceNode.type === 'TSInterfaceDeclaration'
          ? (existingInterfaceNode as AstNode & { body?: AstNode & { body?: AstNode[]; loc?: AstLocFull } }).body
          : null
        const existingBodyMembers = intfBody?.body ?? []
        if (existingBodyMembers.length === 0 && intfBody?.loc) {
          // Empty interface — splice members in before the closing brace.
          const closingLine = intfBody.loc.end.line - 1 // 0-indexed
          // Re-compute line index in modLines (unchanged since we didn't splice near there yet).
          modLines.splice(closingLine, 0, ...memberLines)
        }
        // If it already has members, leave them alone — user manages it from here.
      }

      modified = modLines.join('\n')
      const ok = await pushToMonacoAndSave(modified)
      if (ok) setHasPropTypeDef(true)
    } catch { /* ignore */ }
  }

  async function handleCreateProp() {
    const name = newPropName.trim()
    if (!name || !/^[a-zA-Z_$][\w$]*$/.test(name)) return
    const freshRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
    if (!freshRes.ok) return
    let modified = await freshRes.text()
    const nodeLocLine = selectedNode?.locatorLine ?? line
    const ownerName = selectedNode?.ownerComponentName ?? componentName ?? ''
    // variable mode → pass as expression {varName}; entry mode → pass as string "value"
    const isVarMode = newPropMode === 'variable'
    const rawValue = newPropValue.trim()
    const valueToUse = rawValue || name
    // Destructure default: variable mode → raw identifier (= varName); entry mode → quoted string literal (= 'value')
    const destructureDefault = (!inspectingComponent || !usageInfo)
      ? (rawValue ? (isVarMode ? rawValue : JSON.stringify(rawValue)) : '')
      : ''
    if (inspectingComponent) {
      if (ownerName) modified = addPropToOwnerSignature(modified, ownerName, name, newPropType || 'unknown', destructureDefault || undefined)
      const ok = await pushToMonacoAndSave(modified)
      if (!ok) return
      // Also inject the attr at the parent usage site (e.g. <Input newProp={value} /> in LoginPage).
      if (usageInfo && rawValue) {
        try {
          const parentRes = await fetch(`/__source?file=${encodeURIComponent(usageInfo.file)}`)
          if (parentRes.ok) {
            let parentSrc = await parentRes.text()
            parentSrc = insertAttr(parentSrc, usageInfo.line, name, valueToUse, isVarMode)
            await fetch('/__source', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ file: usageInfo.file, content: parentSrc }),
            })
            setUsageAttrs(extractJsxAttrs(parentSrc, usageInfo.line))
          }
        } catch { /* non-fatal */ }
      }
    } else {
      modified = insertAttr(modified, nodeLocLine, name, valueToUse, isVarMode)
      if (ownerName) modified = addPropToOwnerSignature(modified, ownerName, name, newPropType || 'unknown', destructureDefault || undefined)
      const ok = await pushToMonacoAndSave(modified)
      if (!ok) return
    }
    setNewPropName('')
    setNewPropValue('')
    setNewPropType('string')
    setNewPropMode('entry')
    setNewPropAsExpr(false)
    setNewPropTypeInferred(false)
    setShowAddProp(false)
  }

  async function handleSave() {
    const editedValue = editorRef.current?.getValue() ?? displayCode
    const newFullSource = buildFullSourceFromEditorValue(editedValue)
    setSaving(true)
    setSaveStatus('idle')
    try {
      const res = await fetch('/__source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, content: newFullSource }),
      })
      if (!res.ok) throw new Error(`Save failed: ${res.status}`)
      fullSourceRef.current = newFullSource
      setSaveStatus('saved')
    } catch {
      setSaveStatus('error')
    } finally {
      setSaving(false)
    }
  }

  const displayFile = file.replace(/\\/g, '/').split('/login-app/src/').pop() ?? file

  return (
    <div style={{ ...styles.panel, width: panelWidth }}>
      {/* Resize handle */}
      <div
        onPointerDown={startResize}
        style={styles.resizeHandle}
        title="Drag to resize"
      />
      {/* Header */}
      <div style={styles.header}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
          {blockName && <span style={styles.blockName}>{blockName}</span>}
          <span style={styles.fileName} title={file}>{displayFile}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <button
            style={styles.undoRedoBtn}
            title="Undo (Ctrl+Z)"
            onClick={triggerUndo}
          >&#8630;</button>
          <button
            style={styles.undoRedoBtn}
            title="Redo (Ctrl+Y)"
            onClick={triggerRedo}
          >&#8631;</button>
          <button style={styles.closeBtn} onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      {/* Scope hierarchy panel — replaces the old imports section */}
      {(selectedNode && (scopeLayers.length > 0 || (inspectingComponent && (ownerProps.length > 0 || parentLocals.length > 0)))) && (
        <ScopePanel
          layers={scopeLayers}
          inspectingComponent={inspectingComponent}
          ownerProps={ownerProps}
          parentLocals={parentLocals}
          parentSource={parentSource}
          parentComponentName={parentComponentName}
          usageAttrs={usageAttrs}
          currentTag={selectedNode.tag}
        />
      )}

      {/* Tabs */}
      <div style={styles.tabs}>
        {(['bindings', 'source'] as Tab[]).map((tab) => (
          <button
            key={tab}
            style={{ ...styles.tab, ...(activeTab === tab ? styles.activeTab : {}) }}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={styles.content}>
        {/* Editor is always mounted so Monaco undo stack is preserved across tab switches.
            Hidden via display:none when not on the source tab. */}
        <div style={{ display: activeTab === 'source' ? 'contents' : 'none' }}>
          {loading ? (
            <div style={styles.loading}>Loading…</div>
          ) : (
            <Editor
              height="100%"
              language="typescript"
              path={file ? `file:///${file.replace(/\\/g, '/')}` : undefined}
              theme="vs-dark"
              value={displayCode}
              options={{
                fontSize: 12,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                lineNumbers: (n: number) =>
                  String((blockRangeRef.current?.startLine ?? 0) + n),
              }}
              onMount={(ed, monaco) => {
                editorRef.current = ed
                monacoRef.current = monaco
                configureMonacoForInspector(monaco)
                if (file && fullSourceRef.current) {
                  void syncContextModels(file, fullSourceRef.current)
                  scheduleDiagnostics(file, fullSourceRef.current)
                }
                const model = ed.getModel()
                if (model) {
                  lastValidSourceRef.current = model.getValue()
                  modelChangeDisposableRef.current?.dispose()
                  modelChangeDisposableRef.current = model.onDidChangeContent(() => {
                    const latest = model.getValue()
                    lastValidSourceRef.current = latest
                    if (file) {
                      const fullForDiagnostics = buildFullSourceFromEditorValue(latest)
                      scheduleDiagnostics(file, fullForDiagnostics)
                    }
                    // Keep undo/redo button state in sync with Monaco's own stack.
                    setCanUndo(true)
                    setCanRedo(false)
                  })
                }

                const currentRange = blockRangeRef.current
                if (currentRange) {
                  const lineInModel = inspectMode === 'file'
                    ? Math.max(line, 1)
                    : Math.max(line - currentRange.startLine, 1)
                  ed.revealLineInCenter(lineInModel)
                }
              }}
            />
          )}
        </div>

        {activeTab === 'bindings' && (
          <div style={styles.bindingsPanel}>
            {!selectedNode ? (
              <div style={styles.bindingsEmpty}>
                <span style={{ fontSize: '1.5rem', opacity: 0.4 }}>&#9632;</span>
                <span>Select a node in the tree to inspect its props &amp; attributes.</span>
              </div>
            ) : (
              <>
                {/* Node header */}
                <div style={styles.bindingsNodeHeader}>
                  <span style={styles.bindingsNodeTag}>&lt;{selectedNode.tag}&gt;</span>
                  {selectedNode.ownerComponentName && selectedNode.ownerComponentName !== selectedNode.tag && (
                    <span style={styles.bindingsNodeOwner}>in {selectedNode.ownerComponentName}</span>
                  )}
                </div>

                {/* Attribute rows */}
                <div style={styles.bindingsScroll}>
                  {/* ── No prop type banner ───────────────────────────────── */}
                  {inspectingComponent && !hasPropTypeDef && (
                    <div style={styles.noPropTypeBanner}>
                      <div style={styles.noPropTypeBannerText}>
                        <span style={{ fontWeight: 600, color: '#f9e2af' }}>No props interface</span>
                        <span style={{ color: '#a6adc8' }}>
                          {' '}<code style={{ color: '#89b4fa', fontFamily: 'monospace' }}>{selectedNode.tag}</code> has no typed props declaration.
                        </span>
                      </div>
                      <button
                        style={styles.noPropTypeCta}
                        onClick={() => void handleRegisterPropTypes()}
                      >
                        Create <code style={{ fontFamily: 'monospace', fontWeight: 700 }}>{selectedNode.tag}Props</code>
                      </button>
                    </div>
                  )}
                  {/* ── Component mode: show declared props with types ─────── */}
                  {inspectingComponent && (
                    ownerProps.length === 0 ? (
                      <div style={styles.componentEmptyState}>
                        <p style={{ margin: '0 0 0.5rem', color: '#6c7086', fontSize: '0.8rem' }}>
                          No props declared on <code style={{ color: '#89b4fa' }}>{selectedNode.tag}</code>.
                        </p>
                        <p style={{ margin: 0, color: '#6c7086', fontSize: '0.75rem' }}>
                          Use “+ Add prop” below to create the first prop.
                          The component signature and a <code style={{ color: '#cba6f7' }}>{selectedNode.tag}Props</code> interface
                          will be created automatically.
                        </p>
                      </div>
                    ) : (
                      ownerProps.map((prop) => {
                        const isExpanded = expandedRows.has(prop.name)
                        return (
                          <div key={prop.name} style={styles.attrRowWrap}>
                            {/* Main header row */}
                            <div style={styles.attrRow}>
                              <button
                                style={styles.rowChevron}
                                title={isExpanded ? 'Collapse' : 'Expand to edit default value'}
                                onClick={() => setExpandedRows(prev => {
                                  const next = new Set(prev)
                                  isExpanded ? next.delete(prop.name) : next.add(prop.name)
                                  return next
                                })}
                              >
                                {isExpanded ? '▾' : '▸'}
                              </button>
                              <span style={styles.attrName}>{prop.name}</span>
                              {/* Value input with var/val mode toggle */}
                              <div style={styles.attrValueCell}>
                                <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                                  {!isReadOnly && (
                                    <div style={{ ...styles.modeToggle, flexShrink: 0 }}>
                                      <button
                                        style={{ ...styles.modeBtn, ...((propValueMode[prop.name] ?? 'variable') === 'variable' ? styles.modeBtnActive : {}) }}
                                        onClick={() => setPropValueMode(prev => ({ ...prev, [prop.name]: 'variable' }))}
                                      >var</button>
                                      <button
                                        style={{ ...styles.modeBtn, ...((propValueMode[prop.name] ?? 'variable') === 'entry' ? styles.modeBtnActive : {}) }}
                                        onClick={() => setPropValueMode(prev => ({ ...prev, [prop.name]: 'entry' }))}
                                      >val</button>
                                    </div>
                                  )}
                                  {(propValueMode[prop.name] ?? 'variable') === 'variable' ? (
                                    <select
                                      style={{ ...styles.attrInput, flex: 1 }}
                                      disabled={isReadOnly}
                                      value={propValueEdits[prop.name] ?? usageAttrs.find(a => a.name === prop.name)?.rawValue ?? ''}
                                      onChange={(e) => {
                                        if (isReadOnly) return
                                        setPropValueEdits(prev => ({ ...prev, [prop.name]: e.target.value }))
                                      }}
                                    >
                                      <option value="">— pick variable —</option>
                                      {parentLocals.map(v => <option key={v} value={v}>{v}</option>)}
                                    </select>
                                  ) : (
                                    <input
                                      style={{ ...styles.attrInput, flex: 1 }}
                                      readOnly={isReadOnly}
                                      value={propValueEdits[prop.name] ?? usageAttrs.find(a => a.name === prop.name)?.rawValue ?? prop.defaultValue ?? ''}
                                      onChange={(e) => { if (!isReadOnly) setPropValueEdits((prev) => ({ ...prev, [prop.name]: e.target.value })) }}
                                      onBlur={(e) => {
                                        if (isReadOnly) return
                                        const typed = e.target.value
                                        const prev2 = propValueEdits[prop.name] ?? usageAttrs.find(a => a.name === prop.name)?.rawValue ?? prop.defaultValue ?? ''
                                        setPropValueEdits((prevEdits) => ({ ...prevEdits, [prop.name]: typed || prev2 }))
                                      }}
                                      placeholder={prop.defaultValue ?? 'value'}
                                    />
                                  )}
                                </div>
                              </div>
                              {/* Type cell — always editable; ⟳ infers on click (var mode: from variable type, val mode: from literal) */}
                              <div style={{ ...styles.attrValueCell, maxWidth: 90 }}>
                                <div style={{ display: 'flex', gap: 2 }}>
                                  <input
                                    style={{ ...styles.attrInput, flex: 1, minWidth: 0 }}
                                    readOnly={isReadOnly}
                                    value={propTypeEdits[prop.name] ?? prop.typeStr ?? ''}
                                    onChange={(e) => { if (!isReadOnly) setPropTypeEdits((prev) => ({ ...prev, [prop.name]: e.target.value })) }}
                                    onBlur={(e) => {
                                      if (isReadOnly) return
                                      const typed = e.target.value
                                      if (typed) setPropTypeEdits((prev) => ({ ...prev, [prop.name]: typed }))
                                    }}
                                    placeholder="type"
                                  />
                                  {!isReadOnly && (
                                    <button
                                      style={styles.inferBtn}
                                      title="Infer type from current value"
                                      onClick={() => {
                                        const curVal = propValueEdits[prop.name]
                                          ?? usageAttrs.find(a => a.name === prop.name)?.rawValue
                                          ?? prop.defaultValue ?? ''
                                        const isVarMode = (propValueMode[prop.name] ?? 'variable') === 'variable'
                                        const inferred = isVarMode && parentSource && parentComponentName
                                          ? inferTypeOfLocal(parentSource, parentComponentName, curVal)
                                          : inferTypeFromValueString(curVal)
                                        if (inferred) setPropTypeEdits(prev => ({ ...prev, [prop.name]: inferred }))
                                      }}
                                    >⟳</button>
                                  )}
                                </div>
                              </div>
                              <span style={styles.badgeOwner}>prop</span>
                              {!isReadOnly && (
                                <button
                                  style={styles.deleteBtn}
                                  title={`Remove prop ${prop.name}`}
                                  disabled={deletingProp === prop.name}
                                  onClick={() => void handleDeleteProp(prop.name)}
                                >
                                  {deletingProp === prop.name ? '…' : '✕'}
                                </button>
                              )}
                            </div>
                            {/* Expanded panel — default value */}
                            {isExpanded && (
                              <div style={styles.attrRowExpanded}>
                                <span style={styles.attrExpandLabel}>default</span>
                                <input
                                  style={{ ...styles.attrInput, flex: 1 }}
                                  readOnly={isReadOnly}
                                  placeholder="no default"
                                  value={propDefaultEdits[prop.name] ?? prop.defaultValue ?? ''}
                                  onChange={(e) => { if (!isReadOnly) setPropDefaultEdits(prev => ({ ...prev, [prop.name]: e.target.value })) }}
                                />
                              </div>
                            )}
                          </div>
                        )
                      })
                    )
                  )}

                  {/* ── DOM mode: show editable JSX attributes ─────────────── */}
                  {!inspectingComponent && jsxAttrs.length === 0 && (
                    <div style={styles.bindingsEmptyAttrs}>No JSX attributes found on this element.</div>
                  )}

                  {!inspectingComponent && jsxAttrs.map((attr) => (
                    <div key={attr.name} style={styles.attrRowDom}>
                      <span style={styles.attrName}>{attr.name}</span>

                      {attr.isSpread ? (
                        <span style={styles.attrReadonly}>{attr.rawValue}</span>
                      ) : (
                        <div style={styles.attrValueCell}>
                          <input
                            style={styles.attrInput}
                            readOnly={isReadOnly}
                            value={attrEdits[attr.name] ?? attr.rawValue}
                            onChange={(e) => {
                              if (!isReadOnly) setAttrEdits((prev) => ({ ...prev, [attr.name]: e.target.value }))
                            }}
                            placeholder={attr.isBoolean ? 'true / false' : 'value or {expr}'}
                          />
                        </div>
                      )}

                      {/* Origin badge + delete */}
                      {(() => {
                        const match = ownerProps.find((p) => p.name === attr.name)
                        return (
                          <>
                            {match && (
                              <span style={match.source === 'owner' ? styles.badgeOwner : styles.badgeElement}>
                                {match.source === 'owner' ? 'owner' : 'elem'}
                              </span>
                            )}
                            {!attr.isSpread && !isReadOnly && (
                              <button
                                style={styles.deleteBtn}
                                title={`Remove attribute ${attr.name}`}
                                disabled={deletingProp === attr.name}
                                onClick={() => void handleDeleteProp(attr.name)}
                              >
                                {deletingProp === attr.name ? '…' : '✕'}
                              </button>
                            )}
                          </>
                        )
                      })()}
                    </div>
                  ))}

                  {/* Add prop inline form — hidden for read-only (child) nodes */}
                  {!isReadOnly && (showAddProp ? (
                    <div style={styles.addPropForm}>
                      <div style={styles.addPropRow}>
                        <input
                          autoFocus
                          style={{ ...styles.attrInput, flex: 1 }}
                          placeholder="prop name"
                          value={newPropName}
                          onChange={(e) => setNewPropName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Escape') setShowAddProp(false) }}
                        />
                        <span style={{ color: '#6c7086', fontSize: 11 }}>:</span>
                        <div style={{ display: 'flex', gap: 2 }}>
                          <input
                            style={{ ...styles.attrInput, width: 70 }}
                            placeholder="type"
                            value={newPropType}
                            onChange={(e) => { setNewPropType(e.target.value); setNewPropTypeInferred(false) }}
                          />
                          <button
                            style={{ ...styles.inferBtn, opacity: newPropValue.trim() ? 1 : 0.35 }}
                            title="Infer type from value"
                            onClick={() => {
                              const inferred = newPropMode === 'variable' && parentSource && parentComponentName
                                ? inferTypeOfLocal(parentSource, parentComponentName, newPropValue)
                                : inferTypeFromValueString(newPropValue)
                              if (inferred) { setNewPropType(inferred); setNewPropTypeInferred(true) }
                            }}
                          >⟳</button>
                        </div>
                      </div>
                      <div style={styles.addPropRow}>
                        {/* Mode toggle: variable vs literal entry */}
                        <div style={styles.modeToggle}>
                          <button
                            style={{ ...styles.modeBtn, ...(newPropMode === 'variable' ? styles.modeBtnActive : {}) }}
                            onClick={() => { setNewPropMode('variable'); setNewPropValue(''); setNewPropTypeInferred(false) }}
                          >var</button>
                          <button
                            style={{ ...styles.modeBtn, ...(newPropMode === 'entry' ? styles.modeBtnActive : {}) }}
                            onClick={() => { setNewPropMode('entry'); setNewPropValue(''); setNewPropTypeInferred(false) }}
                          >val</button>
                        </div>
                        {newPropMode === 'variable' ? (
                          <select
                            style={{ ...styles.attrInput, flex: 1 }}
                            value={newPropValue}
                            onChange={(e) => { setNewPropValue(e.target.value) }}
                          >
                            <option value="">— pick variable —</option>
                            {parentLocals.map(v => <option key={v} value={v}>{v}</option>)}
                          </select>
                        ) : (
                          <input
                            style={{ ...styles.attrInput, flex: 1 }}
                            placeholder="default value"
                            value={newPropValue}
                            onFocus={(e) => { e.currentTarget.value = ''; setNewPropValue('') }}
                            onChange={(e) => { setNewPropValue(e.target.value) }}
                          />
                        )}
                      </div>
                      <div style={styles.addPropActions}>
                        <button style={styles.cancelBtn} onClick={() => setShowAddProp(false)}>Cancel</button>
                        <button
                          style={styles.confirmBtn}
                          onClick={() => void handleCreateProp()}
                          disabled={!newPropName.trim()}
                        >
                          Create &amp; Bind
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button style={styles.addAttrBtn} onClick={() => setShowAddProp(true)}>
                      + Add prop
                    </button>
                  ))}

                  {isReadOnly && (
                    <div style={{ padding: '0.5rem 1rem', color: '#6c7086', fontSize: '0.75rem', fontStyle: 'italic' }}>
                      DOM nodes inside child components are read-only — select the component node itself to edit its props.
                    </div>
                  )}
                </div>

                {/* Apply-changes bar — component prop type edits */}
                {!isReadOnly && inspectingComponent && (Object.keys(propTypeEdits).length > 0 || Object.keys(propValueEdits).length > 0 || Object.keys(propDefaultEdits).length > 0) && (
                  <div style={styles.saveBar}>
                    {saveStatus === 'saved' && <span style={styles.savedMsg}>&#10003; Saved</span>}
                    {saveStatus === 'error' && <span style={styles.errorMsg}>&#x2717; Save failed</span>}
                    <button style={styles.saveBtn}
                      onClick={() => void handlePropTypeSave()}
                      disabled={bindingsSaving}
                    >
                      {bindingsSaving ? 'Saving…' : 'Apply changes'}
                    </button>
                    <button style={styles.cancelBtn} onClick={() => { setPropTypeEdits({}); setPropValueEdits({}); setPropDefaultEdits({}) }}>Cancel</button>
                  </div>
                )}

                {/* Apply-changes bar — DOM attr mode only; undo/redo is in header */}
                {!isReadOnly && !inspectingComponent && (
                  <div style={styles.saveBar}>
                    {saveStatus === 'saved' && <span style={styles.savedMsg}>&#10003; Saved</span>}
                    {saveStatus === 'error' && <span style={styles.errorMsg}>&#x2717; Save failed</span>}
                    <button
                      style={styles.saveBtn}
                      onClick={() => void handleBindingsSave()}
                      disabled={bindingsSaving}
                    >
                      {bindingsSaving ? 'Saving…' : 'Apply changes'}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Save bar */}
      {activeTab === 'source' && (
        <div style={styles.saveBar}>
          {saveStatus === 'saved' && <span style={styles.savedMsg}>✓ Saved — HMR will reload</span>}
          {saveStatus === 'error' && <span style={styles.errorMsg}>✗ Save failed</span>}
          <button style={styles.saveBtn} onClick={handleSave} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  blockName: {
    fontSize: '0.85rem',
    fontWeight: 700,
    color: '#cdd6f4',
    fontFamily: 'monospace',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  panel: {
    position: 'fixed',
    top: 0,
    right: 0,
    height: '100vh',
    background: '#1e1e2e',
    borderLeft: '1px solid #313244',
    display: 'flex',
    flexDirection: 'column',
    zIndex: 100,
    boxShadow: '-4px 0 20px rgba(0,0,0,0.4)',
  },
  resizeHandle: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 5,
    cursor: 'col-resize',
    zIndex: 10,
    background: 'transparent',
    transition: 'background 0.15s',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.6rem 0.8rem',
    background: '#181825',
    borderBottom: '1px solid #313244',
    flexShrink: 0,
  },
  fileName: {
    fontSize: '0.78rem',
    color: '#cdd6f4',
    fontFamily: 'monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 340,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#6c7086',
    cursor: 'pointer',
    fontSize: '1rem',
    padding: '0 4px',
  },
  undoRedoBtn: {
    background: 'none',
    border: '1px solid #313244',
    borderRadius: 4,
    color: '#6c7086',
    cursor: 'pointer',
    fontSize: '1rem',
    padding: '1px 6px',
    lineHeight: 1,
    transition: 'color 0.1s, border-color 0.1s',
  },
  tabs: {
    display: 'flex',
    borderBottom: '1px solid #313244',
    flexShrink: 0,
  },
  tab: {
    flex: 1,
    padding: '0.45rem',
    background: 'none',
    border: 'none',
    color: '#6c7086',
    cursor: 'pointer',
    fontSize: '0.82rem',
    fontWeight: 500,
    transition: 'color 0.15s',
  },
  activeTab: {
    color: '#cdd6f4',
    borderBottom: '2px solid #89b4fa',
  },
  content: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    color: '#6c7086',
    fontSize: '0.85rem',
  },
  placeholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    gap: 8,
    color: '#cdd6f4',
    fontSize: '0.9rem',
  },
  bindingsPanel: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    overflow: 'hidden',
  },
  bindingsEmpty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    gap: 8,
    color: '#6c7086',
    fontSize: '0.82rem',
    textAlign: 'center' as const,
    padding: '2rem',
  },
  bindingsNodeHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem 0.8rem',
    background: '#181825',
    borderBottom: '1px solid #313244',
    flexShrink: 0,
  },
  bindingsNodeTag: {
    fontFamily: 'monospace',
    color: '#89b4fa',
    fontWeight: 700,
    fontSize: '0.88rem',
  },
  bindingsNodeOwner: {
    fontSize: '0.75rem',
    color: '#6c7086',
  },
  bindingsScroll: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '0.4rem 0',
  },
  noPropTypeBanner: {
    margin: '0.5rem 0.75rem',
    padding: '0.6rem 0.75rem',
    background: 'rgba(249,226,175,0.06)',
    border: '1px solid rgba(249,226,175,0.2)',
    borderRadius: 6,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  noPropTypeBannerText: {
    fontSize: '0.75rem',
    lineHeight: 1.5,
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '2px 4px',
  },
  noPropTypeCta: {
    alignSelf: 'flex-start' as const,
    background: '#313244',
    border: '1px solid rgba(249,226,175,0.3)',
    borderRadius: 5,
    color: '#f9e2af',
    cursor: 'pointer',
    fontSize: '0.72rem',
    padding: '4px 10px',
    fontWeight: 600,
  },
  bindingsEmptyAttrs: {
    color: '#6c7086',
    fontSize: '0.78rem',
    padding: '0.8rem 1rem',
  },
  componentEmptyState: {
    padding: '0.8rem 1rem',
    lineHeight: 1.6,
  },
  attrRowWrap: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    borderBottom: '1px solid #1e1e2e',
  },
  attrRow: {
    display: 'grid' as const,
    gridTemplateColumns: '16px 110px 1fr 80px auto auto',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    minWidth: 0,
    overflow: 'hidden',
  },
  attrRowDom: {
    display: 'grid' as const,
    gridTemplateColumns: '110px 1fr auto auto',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    borderBottom: '1px solid #1e1e2e',
    minWidth: 0,
    overflow: 'hidden',
  },
  rowChevron: {
    background: 'none' as const,
    border: 'none' as const,
    color: '#585b70',
    cursor: 'pointer',
    fontSize: '0.6rem',
    padding: 0,
    lineHeight: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  attrRowExpanded: {
    display: 'flex' as const,
    alignItems: 'center',
    gap: 8,
    padding: '4px 10px 6px 36px',
    background: '#13131f',
  },
  attrExpandLabel: {
    fontSize: '0.6rem' as const,
    color: '#585b70',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    minWidth: 44,
    flexShrink: 0,
  },
  attrName: {
    fontFamily: 'monospace',
    fontSize: '0.78rem',
    color: '#cba6f7',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  attrValueCell: {
    position: 'relative' as const,
  },
  attrInput: {
    width: '100%',
    background: '#313244',
    border: '1px solid #45475a',
    borderRadius: 4,
    color: '#cdd6f4',
    fontFamily: 'monospace',
    fontSize: '0.76rem',
    padding: '2px 6px',
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  attrReadonly: {
    fontFamily: 'monospace',
    fontSize: '0.76rem',
    color: '#6c7086',
    fontStyle: 'italic' as const,
  },
  badgeOwner: {
    fontSize: '0.65rem',
    padding: '1px 5px',
    borderRadius: 3,
    background: '#1e3a5f',
    color: '#89b4fa',
    whiteSpace: 'nowrap' as const,
  },
  badgeElement: {
    fontSize: '0.65rem',
    padding: '1px 5px',
    borderRadius: 3,
    background: '#2a1f3e',
    color: '#cba6f7',
    whiteSpace: 'nowrap' as const,
  },
  addAttrBtn: {
    margin: '0.5rem 0.8rem',
    background: 'none',
    border: '1px dashed #45475a',
    borderRadius: 4,
    color: '#6c7086',
    cursor: 'pointer',
    fontSize: '0.78rem',
    padding: '4px 10px',
    display: 'block',
    width: 'calc(100% - 1.6rem)',
  },
  addPropForm: {
    margin: '0.4rem 0.8rem',
    padding: '0.5rem',
    background: '#181825',
    borderRadius: 6,
    border: '1px solid #313244',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  addPropRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
  },
  addPropActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 6,
  },
  cancelBtn: {
    background: 'none',
    border: '1px solid #45475a',
    borderRadius: 4,
    color: '#6c7086',
    cursor: 'pointer',
    fontSize: '0.76rem',
    padding: '3px 10px',
  },
  confirmBtn: {
    background: '#89b4fa',
    border: 'none',
    borderRadius: 4,
    color: '#1e1e2e',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '0.76rem',
    padding: '3px 10px',
  },
  exprToggle: {
    color: '#6c7086',
    fontSize: '0.72rem',
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },
  modeToggle: {
    display: 'flex' as const,
    borderRadius: 3,
    overflow: 'hidden',
    border: '1px solid #45475a',
    flexShrink: 0,
  },
  modeBtn: {
    background: 'none' as const,
    border: 'none' as const,
    borderRadius: 0,
    color: '#6c7086',
    cursor: 'pointer',
    fontSize: '0.62rem',
    fontWeight: 600,
    padding: '1px 5px',
    fontFamily: 'monospace',
    lineHeight: 1.4,
  },
  modeBtnActive: {
    background: '#313244',
    color: '#89b4fa',
  },
  deleteBtn: {
    background: 'none',
    border: 'none',
    color: '#6c7086',
    cursor: 'pointer',
    fontSize: '0.7rem',
    padding: '1px 4px',
    borderRadius: 3,
    lineHeight: 1,
    transition: 'color 0.1s',
  },
  inferBtn: {
    background: 'none',
    border: '1px solid #313244',
    borderRadius: 3,
    color: '#6c7086',
    cursor: 'pointer',
    fontSize: '0.68rem',
    padding: '1px 4px',
    lineHeight: 1,
    flexShrink: 0,
    transition: 'color 0.1s, border-color 0.1s',
  },
  attrType: {
    fontFamily: 'monospace',
    fontSize: '0.75rem',
    color: '#a6e3a1',
    fontStyle: 'italic' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  saveBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '0.75rem',
    padding: '0.5rem 0.8rem',
    borderTop: '1px solid #313244',
    background: '#181825',
    flexShrink: 0,
  },
  saveBtn: {
    padding: '0.35rem 0.9rem',
    background: '#89b4fa',
    color: '#1e1e2e',
    border: 'none',
    borderRadius: 5,
    fontWeight: 600,
    fontSize: '0.82rem',
    cursor: 'pointer',
  },
  savedMsg: {
    fontSize: '0.78rem',
    color: '#a6e3a1',
  },
  errorMsg: {
    fontSize: '0.78rem',
    color: '#f38ba8',
  },
  importsSection: {
    flexShrink: 0,
    borderBottom: '1px solid #313244',
  },
  importsSectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    width: '100%',
    background: 'none',
    border: 'none',
    color: '#a6adc8',
    cursor: 'pointer',
    padding: '0.45rem 0.8rem',
    fontSize: '0.78rem',
    fontWeight: 600,
    textAlign: 'left' as const,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
  },
  importsChevron: {
    fontSize: '0.7rem',
    color: '#6c7086',
  },
  importsCount: {
    marginLeft: 'auto',
    fontSize: '0.72rem',
    color: '#6c7086',
    fontWeight: 400,
  },
  importsCode: {
    margin: 0,
    padding: '0.4rem 0.8rem 0.6rem',
    fontSize: '0.75rem',
    fontFamily: 'monospace',
    color: '#89dceb',
    background: '#181825',
    overflowX: 'auto' as const,
    whiteSpace: 'pre' as const,
    lineHeight: 1.6,
    maxHeight: 220,
    overflowY: 'auto' as const,
  },
}
