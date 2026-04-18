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

    if (options?.inspectMode === 'component-usage') {
      // Collect all JSX elements that contain targetLine, sorted smallest to largest.
      // Return the second-smallest (the parent container, e.g. <TextField> wrapping <TextField.Input>).
      const results: AstNode[] = []
      ;(function collectJsx(node: AstNode) {
        if (!nodeContainsLine(node, targetLine1)) return
        if (node.type === 'JSXElement' || node.type === 'JSXFragment') results.push(node)
        for (const child of getChildNodes(node)) collectJsx(child)
      })(root)
      results.sort((a, b) => nodeSpan(a) - nodeSpan(b))
      const exactJsx = results[0]
      if (exactJsx?.loc) {
        return extractFromLoc(lines, exactJsx.loc, jsxNameFromNode(exactJsx))
      }
    }

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

/**
 * Scan a component's JSX for child component usages that receive root-scope
 * variables (props or state) as expression bindings.
 *
 * Returns one entry per child component name with its list of bindings:
 *   { componentName: 'Button', bindings: [{ rootVar: 'loading', childProp: 'disabled' }] }
 *
 * Walks full attribute expressions — detects ternaries, logical operators, etc.
 * Only shows components that actually receive a rootVar as a prop value.
 */
export function extractChildBindings(
  source: string,
  ownerName: string,
  rootVars: Set<string>,
): Array<{ componentName: string; bindings: Array<{ rootVar: string; childProp: string }> }> {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const root = ast.program as unknown as AstNode

    // Collect rootVar identifiers in an expression — does NOT traverse into nested JSXElements
    // to prevent false positives like icon={<Icon color={rootVar}/>} registering as a binding.
    function collectRootVarRefs(exprNode: AstNode): string[] {
      const found: string[] = []
      function walkExpr(n: AstNode) {
        if (n.type === 'JSXElement' || n.type === 'JSXFragment') return // don't go into nested JSX
        if (n.type === 'Identifier' && rootVars.has((n as any).name)) {
          found.push((n as any).name as string)
        }
        for (const c of getChildNodes(n)) walkExpr(c)
      }
      walkExpr(exprNode)
      return [...new Set(found)]
    }

    // Find the owner component body node to scope our search.
    const ownerNode = findNamedComponentNode(root, ownerName)
    const searchRoot = ownerNode ?? root

    // Each JSX element occurrence is its own entry — don't group same-name components
    const results: Array<{ componentName: string; bindings: Array<{ childProp: string; rootVar: string }> }> = []

    function walk(node: AstNode) {
      if (node.type === 'JSXElement') {
        const opening = node.openingElement as AstNode | undefined
        const nameNode = opening?.name as (AstNode & { name?: string; object?: unknown }) | undefined
        // Resolve the component name: JSXIdentifier or JSXMemberExpression
        let compName: string | null = null
        if (nameNode?.type === 'JSXIdentifier' && typeof nameNode.name === 'string') {
          compName = nameNode.name
        } else if (nameNode?.type === 'JSXMemberExpression') {
          // e.g. TextField.Input — use full dotted name so it's distinct from TextField
          const obj = nameNode.object as (AstNode & { name?: string }) | undefined
          const prop = (nameNode as any).property as (AstNode & { name?: string }) | undefined
          const objName = typeof obj?.name === 'string' ? obj.name : null
          const propName = typeof prop?.name === 'string' ? prop.name : null
          compName = objName && propName ? `${objName}.${propName}` : objName
        }

        if (compName && /^[A-Z]/.test(compName)) {
          // React component: collect prop bindings, stop recursion into its children.
          const attrs = (opening?.attributes as AstNode[] | undefined) ?? []
          const elementBindings: Array<{ childProp: string; rootVar: string }> = []
          for (const attr of attrs) {
            if (attr.type !== 'JSXAttribute') continue
            const attrName = (attr.name as AstNode & { name?: string } | undefined)?.name
            if (!attrName) continue
            const valueNode = attr.value as AstNode | null | undefined
            if (!valueNode) continue
            if (valueNode.type !== 'JSXExpressionContainer') continue
            const expr = valueNode.expression as AstNode | undefined
            if (!expr || expr.type === 'JSXEmptyExpression') continue
            for (const varName of collectRootVarRefs(expr)) {
              if (!elementBindings.some(b => b.childProp === attrName && b.rootVar === varName)) {
                elementBindings.push({ childProp: attrName, rootVar: varName })
              }
            }
          }
          if (elementBindings.length > 0) {
            results.push({ componentName: compName, bindings: elementBindings })
          }
          // Always recurse into JSX children to catch compound component patterns
          // like <TextField helpText={email}><TextField.Input value={email}/></TextField>.
        } else if (compName) {
          // Native DOM element (div, span, img, etc.): collect attr + text-child bindings,
          // then continue recursing into its children.
          const attrs = (opening?.attributes as AstNode[] | undefined) ?? []
          const elementBindings: Array<{ childProp: string; rootVar: string }> = []
          for (const attr of attrs) {
            if (attr.type !== 'JSXAttribute') continue
            const attrName = (attr.name as AstNode & { name?: string } | undefined)?.name
            if (!attrName) continue
            const valueNode = attr.value as AstNode | null | undefined
            if (!valueNode) continue
            if (valueNode.type !== 'JSXExpressionContainer') continue
            const expr = valueNode.expression as AstNode | undefined
            if (!expr || expr.type === 'JSXEmptyExpression') continue
            for (const varName of collectRootVarRefs(expr)) {
              if (!elementBindings.some(b => b.childProp === attrName && b.rootVar === varName)) {
                elementBindings.push({ childProp: attrName, rootVar: varName })
              }
            }
          }
          // Also check direct expression children: <span>{email}</span>
          const jsxChildren = ((node as any).children as AstNode[] | undefined) ?? []
          for (const child of jsxChildren) {
            if (child.type === 'JSXExpressionContainer') {
              const expr = (child as any).expression as AstNode | undefined
              if (expr && expr.type !== 'JSXEmptyExpression') {
                for (const varName of collectRootVarRefs(expr)) {
                  if (!elementBindings.some(b => b.childProp === 'children' && b.rootVar === varName)) {
                    elementBindings.push({ childProp: 'children', rootVar: varName })
                  }
                }
              }
            }
          }
          if (elementBindings.length > 0) {
            results.push({ componentName: compName, bindings: elementBindings })
          }
          // Fall through to recurse into this DOM element's children below.
        }
      }
      for (const child of getChildNodes(node)) walk(child)
    }

    walk(searchRoot)

    return results
  } catch {
    return []
  }
}

