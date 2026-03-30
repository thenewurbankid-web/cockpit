import { parse } from '@babel/parser'
import type { AstNode, AstLoc, BlockRange } from './types'

export function isAstNode(v: unknown): v is AstNode {
  return !!v && typeof v === 'object' && typeof (v as AstNode).type === 'string'
}

export function getChildNodes(node: AstNode): AstNode[] {
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

export function nodeContainsLine(node: AstNode, targetLine: number): boolean {
  const loc = node.loc
  if (!loc) return false
  return loc.start.line <= targetLine && loc.end.line >= targetLine
}

export function nodeSpan(node: AstNode): number {
  if (!node.loc) return Number.MAX_SAFE_INTEGER
  return node.loc.end.line - node.loc.start.line
}

export function findSmallestContainingNode(
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

export function jsxNameFromNode(node: AstNode): string {
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

export function extractFromLoc(lines: string[], loc: AstLoc, name: string): { code: string; range: BlockRange; name: string } {
  const startLine = Math.max(loc.start.line - 1, 0)
  const endLine = Math.max(loc.end.line - 1, startLine)
  return {
    code: lines.slice(startLine, endLine + 1).join('\n'),
    range: { startLine, endLine },
    name,
  }
}

export function findNamedComponentNode(root: AstNode, name: string): AstNode | null {
  let found: AstNode | null = null

  function walk(node: AstNode) {
    if (found) return

    if (node.type === 'FunctionDeclaration') {
      const id = node.id as AstNode | undefined
      const idName = (id as AstNode & { name?: string } | undefined)?.name
      if (idName === name) {
        found = node
        return
      }
    }

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

export function extractFunctionBlock(lines: string[], target: number): { code: string; range: BlockRange; name: string } {
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

export function extractBlock(
  source: string,
  targetLine: number,
  options?: { inspectMode?: 'node' | 'component' | 'file' | 'expression'; componentName?: string }
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

  try {
    const ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    })
    const root = ast.program as unknown as AstNode
    const targetLine1 = target + 1

    if (options?.inspectMode === 'expression') {
      const callNode = findSmallestContainingNode(
        root,
        targetLine1,
        (node) => {
          if (node.type !== 'CallExpression') return false
          const args = (node as unknown as { arguments?: AstNode[] }).arguments ?? []
          return args.some(
            (a) =>
              (a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression') &&
              nodeContainsLine(a, targetLine1)
          )
        }
      )
      if (callNode?.loc) {
        return extractFromLoc(lines, callNode.loc, 'JSExpression')
      }
    }

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
