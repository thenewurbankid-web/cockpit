/**
 * expressionRewriter.ts
 *
 * Wraps one or more sibling JSX elements in the source with an expression
 * component.  The target elements are identified by 1-based line numbers that
 * correspond to the rows selected in DOMTreePanel.
 *
 * Returns the transformed source string, or null if the transformation cannot
 * be safely applied (e.g. selected nodes are not siblings).
 */
import { parse } from '@babel/parser'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AnyNode = {
  type: string
  start?: number | null
  end?: number | null
  loc?: { start: { line: number; column: number } } | null
  [key: string]: unknown
}

interface FoundNode {
  node: AnyNode
  parent: AnyNode
  indexInParent: number
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

/** Recursively walk an AST, calling visitor for every node. */
function walk(
  node: AnyNode,
  visitor: (node: AnyNode, parent: AnyNode | null) => void,
  parent: AnyNode | null = null,
) {
  visitor(node, parent)
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c && typeof c === 'object' && typeof c.type === 'string') {
          walk(c as AnyNode, visitor, node)
        }
      }
    } else if (child && typeof child === 'object' && typeof (child as AnyNode).type === 'string') {
      walk(child as AnyNode, visitor, node)
    }
  }
}

/**
 * Collect JSX elements/fragments whose opening line is in `lineSet`.
 * Attaches parent info so we can verify siblings.
 */
function collectTargetNodes(ast: AnyNode, lineSet: Set<number>): FoundNode[] {
  const results: FoundNode[] = []

  walk(ast, (node, parent) => {
    if (node.type !== 'JSXElement' && node.type !== 'JSXFragment') return
    const line = node.loc?.start.line
    if (line == null || !lineSet.has(line)) return
    if (parent == null) return

    // Find this node's index inside the parent's children array
    let index = -1
    for (const key of Object.keys(parent)) {
      const val = parent[key]
      if (Array.isArray(val)) {
        const idx = val.indexOf(node)
        if (idx !== -1) {
          index = idx
          break
        }
      }
    }
    if (index === -1) {
      // Node is a direct property (not in an array) — still include it.
      // Common case: arrow function body like `(c) => <Button />`.
    }

    results.push({ node, parent, indexInParent: index })
  })

  return results
}

/** Find the key of the children array that contains `child` inside `parent`. */
function findChildrenKey(parent: AnyNode, child: AnyNode): string | null {
  for (const key of Object.keys(parent)) {
    const val = parent[key]
    if (Array.isArray(val) && val.includes(child)) return key
  }
  return null
}

// ---------------------------------------------------------------------------
// Import management
// ---------------------------------------------------------------------------

/** Does the source already have a named import of `name` from `importPath`? */
function hasNamedImport(source: string, name: string, importPath: string): boolean {
  // Quick regex check before full parse
  return new RegExp(
    `import[^'"]*\\b${name}\\b[^'"]*['"]${importPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
  ).test(source)
}

/** Prepend an import statement for `name` from `importPath` after the last existing import. */
function addImport(source: string, name: string, importPath: string): string {
  const importLine = `import { ${name} } from '${importPath}'`

  // Find the end of the last import block
  const lines = source.split('\n')
  let lastImportIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\s/.test(lines[i])) lastImportIndex = i
  }

  if (lastImportIndex === -1) {
    return importLine + '\n' + source
  }

  lines.splice(lastImportIndex + 1, 0, importLine)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Indentation helpers
// ---------------------------------------------------------------------------

/** Return the leading whitespace of the line at `offset` in `source`. */
function indentAtOffset(source: string, offset: number): string {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  const lineText = source.slice(lineStart, offset)
  const match = lineText.match(/^(\s*)/)
  return match ? match[1] : ''
}

/** Re-indent a multi-line string by `extraIndent`.  The first line is NOT indented. */
function indentBlock(text: string, extraIndent: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? line : extraIndent + line))
    .join('\n')
}

// ---------------------------------------------------------------------------
// JSX attribute builders
// ---------------------------------------------------------------------------

/** Build the opening tag for the expression wrapper, e.g. `<IfExpression condition={isAdmin}>`. */
function buildOpenTag(name: string, props: Record<string, string>, jsxProps?: Record<string, string>): string {
  const textAttrs = Object.entries(props)
    .filter(([, v]) => v.trim() !== '')
    .map(([k, v]) => `${k}={${v.trim()}}`)
  const nodeAttrs = Object.entries(jsxProps ?? {})
    .map(([k, v]) => `${k}={${v}}`)
  const allAttrs = [...textAttrs, ...nodeAttrs].join(' ')
  return allAttrs ? `<${name} ${allAttrs}>` : `<${name}>`
}

/** Build a self-closing tag when there are no children. */
function buildSelfClosingTag(name: string, props: Record<string, string>, jsxProps?: Record<string, string>): string {
  const textAttrs = Object.entries(props)
    .filter(([, v]) => v.trim() !== '')
    .map(([k, v]) => `${k}={${v.trim()}}`)
  const nodeAttrs = Object.entries(jsxProps ?? {})
    .map(([k, v]) => `${k}={${v}}`)
  const allAttrs = [...textAttrs, ...nodeAttrs].join(' ')
  return allAttrs ? `<${name} ${allAttrs} />` : `<${name} />`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wrap the JSX nodes at `targetLines` with `<expressionName props...>...</expressionName>`.
 *
 * @param source        Full source text of the file
 * @param targetLines   1-based line numbers of the JSX nodes to wrap
 * @param expressionName  e.g. "IfExpression"
 * @param props         Map of prop name → expression string, e.g. { condition: 'isAdmin' }
 * @param importPath    Relative import path, e.g. '../expressions/IfExpression'
 * @param nodePropLines Map of prop name → line numbers of nodes that become inline JSX prop values.
 *                      Those nodes are extracted from children and passed as e.g. `then={<Button />}`.
 *
 * @returns Transformed source, or null if wrapping cannot be applied.
 */
export function wrapNodesWithExpression(
  source: string,
  targetLines: number[],
  expressionName: string,
  props: Record<string, string>,
  importPath: string,
  nodePropLines?: Record<string, number[]>,
): string | null {
  if (targetLines.length === 0) return null

  let ast: AnyNode
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true,
    }) as unknown as AnyNode
  } catch {
    return null
  }

  const lineSet = new Set(targetLines)
  const found = collectTargetNodes(ast, lineSet)

  if (found.length === 0) return null

  // All selected nodes must share the same parent and the same children key.
  // For a single node that is not in an array (e.g. arrow-function body),
  // skip the sibling check — we just need start/end positions.
  const firstParent = found[0].parent
  const firstKey = findChildrenKey(firstParent, found[0].node)

  if (found.length > 1) {
    if (!firstKey) return null
    for (const f of found) {
      if (f.parent !== firstParent) return null
      if (findChildrenKey(f.parent, f.node) !== firstKey) return null
    }
  }

  // Sort by source position
  const sorted = [...found].sort((a, b) => (a.node.start ?? 0) - (b.node.start ?? 0))

  const firstStart = sorted[0].node.start
  const lastEnd = sorted[sorted.length - 1].node.end
  if (firstStart == null || lastEnd == null) return null

  // Determine base indent from the first node's line
  const baseIndent = indentAtOffset(source, firstStart)
  const childIndent = baseIndent + '  '

  // ── Per-prop node assignments ──────────────────────────────────────────
  // Build a reverse map: line number → prop name
  const lineToProp = new Map<number, string>()
  for (const [propName, lines] of Object.entries(nodePropLines ?? {})) {
    for (const l of lines) lineToProp.set(l, propName)
  }

  // Separate nodes into prop-slots vs children
  const propNodeMap: Record<string, FoundNode[]> = {}
  const childNodes: FoundNode[] = []

  for (const f of sorted) {
    const line = f.node.loc?.start.line
    const assignedProp = line != null ? lineToProp.get(line) : undefined
    if (assignedProp) {
      if (!propNodeMap[assignedProp]) propNodeMap[assignedProp] = []
      propNodeMap[assignedProp].push(f)
    } else {
      childNodes.push(f)
    }
  }

  // Build inline JSX strings for prop-assigned nodes
  const jsxPropValues: Record<string, string> = {}
  for (const [propName, nodes] of Object.entries(propNodeMap)) {
    if (nodes.length === 1) {
      jsxPropValues[propName] = source.slice(nodes[0].node.start!, nodes[0].node.end!)
    } else {
      const parts = nodes.map(n => source.slice(n.node.start!, n.node.end!)).join('\n' + childIndent)
      jsxPropValues[propName] = `<>\n${childIndent}${parts}\n${baseIndent}</>`
    }
  }

  // ── Build replacement ──────────────────────────────────────────────────
  let replacement: string

  if (childNodes.length === 0) {
    // All nodes went to props → self-closing tag
    replacement = buildSelfClosingTag(expressionName, props, jsxPropValues)
  } else {
    const openTag = buildOpenTag(expressionName, props, jsxPropValues)
    const closeTag = `</${expressionName}>`

    let inner: string
    if (childNodes.length === sorted.length) {
      // No per-prop assignments → original contiguous-slice behaviour
      inner = source.slice(firstStart, lastEnd)
    } else {
      // Some nodes assigned to props — rebuild children from remaining nodes only
      inner = childNodes.map(n => source.slice(n.node.start!, n.node.end!)).join('\n' + childIndent)
    }

    const indentedInner = indentBlock(inner, '  ')
    replacement = `${openTag}\n${childIndent}${indentedInner}\n${baseIndent}${closeTag}`
  }

  // Splice into source
  let result = source.slice(0, firstStart) + replacement + source.slice(lastEnd)

  // Add import if needed
  if (!hasNamedImport(result, expressionName, importPath)) {
    result = addImport(result, expressionName, importPath)
  }

  return result
}

/**
 * Update the prop values of an existing expression component at the given
 * 1-based line without re-wrapping it.  Only touches attribute values that
 * are present in `props` (non-empty strings); leaves unrecognised attributes
 * alone.  Returns the modified source, or null if the element is not found.
 */
export function updateExpressionProps(
  source: string,
  expressionName: string,
  line: number,
  props: Record<string, string>,
): string | null {
  let ast: AnyNode
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true,
    }) as unknown as AnyNode
  } catch {
    return null
  }

  // Build line-offset table for offsetToLine()
  const lineOffsets: number[] = [0]
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineOffsets.push(i + 1)
  }
  function offsetToLine(offset: number): number {
    let lo = 0, hi = lineOffsets.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineOffsets[mid] <= offset) lo = mid; else hi = mid - 1
    }
    return lo + 1
  }

  // Find the opening element
  let opening: any = null
  walk(ast, (node) => {
    if (opening) return
    if (
      node.type === 'JSXOpeningElement' &&
      (node as any).name?.name === expressionName &&
      (node as any).start != null &&
      offsetToLine((node as any).start) === line
    ) {
      opening = node
    }
  })
  if (!opening) return null

  // We'll rebuild the attribute list by splicing replacements into the source.
  // Process replacements in reverse order to preserve offsets.
  const attrsToReplace: { start: number; end: number; value: string }[] = []

  for (const attr of (opening.attributes ?? []) as any[]) {
    if (attr.type !== 'JSXAttribute') continue
    const name: string = attr.name?.name
    const newVal = props[name]
    if (newVal === undefined || newVal.trim() === '') continue  // keep as-is

    const val = attr.value
    if (!val) {
      // Boolean shorthand (<Expr disabled />) → replace the whole attr
      const attrSrc = `${name}={${newVal.trim()}}`
      attrsToReplace.push({ start: attr.start, end: attr.end, value: attrSrc })
    } else if (val.type === 'StringLiteral') {
      // Was a string literal → replace with expression container
      attrsToReplace.push({ start: val.start, end: val.end, value: `{${newVal.trim()}}` })
    } else if (val.type === 'JSXExpressionContainer') {
      const expr = val.expression
      if (expr && expr.type !== 'JSXEmptyExpression') {
        attrsToReplace.push({ start: expr.start, end: expr.end, value: newVal.trim() })
      }
    }
  }

  // Also add any props that don't yet have a corresponding attribute.
  const existingAttrNames = new Set(
    ((opening.attributes ?? []) as any[])
      .filter((a: any) => a.type === 'JSXAttribute')
      .map((a: any) => a.name?.name as string),
  )
  const newAttrs: string[] = []
  for (const [k, v] of Object.entries(props)) {
    if (v.trim() === '') continue
    if (!existingAttrNames.has(k)) {
      newAttrs.push(`${k}={${v.trim()}}`)
    }
  }

  // Apply replacements in reverse order.
  const sorted = attrsToReplace.sort((a, b) => b.start - a.start)
  let result = source
  for (const { start, end, value } of sorted) {
    result = result.slice(0, start) + value + result.slice(end)
  }

  // Insert new attributes before the closing `>` or `/>` of the opening tag.
  if (newAttrs.length > 0) {
    // Find the end of the opening tag in the (already-patched) source by
    // re-parsing won't work (offsets shifted), so we search forward from
    // the tag's start position for the first `>` that closes it.
    // Simpler: locate the opening tag text and append before its closer.
    const tagStart = opening.start as number
    // After replacements, tagStart is still valid (we only replaced content after attrs start).
    // Walk forward to find `/>` or `>`.
    let i = tagStart
    let depth = 0
    let inStr: string | null = null
    let insertPos = -1
    while (i < result.length) {
      const ch = result[i]
      if (inStr) {
        if (ch === inStr && result[i - 1] !== '\\') inStr = null
      } else if (ch === '"' || ch === "'") {
        inStr = ch
      } else if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
      } else if (depth === 0 && ch === '>' && result[i - 1] === '/') {
        insertPos = i - 1  // self-closing: insert before `/ >`
        break
      } else if (depth === 0 && ch === '>' && result[i - 1] !== '=') {
        insertPos = i  // regular closer: insert before `>`
        break
      }
      i++
    }
    if (insertPos !== -1) {
      const padding = ' '
      result = result.slice(0, insertPos) + padding + newAttrs.join(' ') + ' ' + result.slice(insertPos)
    }
  }

  return result
}

/**
 * Given the full source text of a file, find the JSX element for `expressionName`
 * at the given 1-based `line` and return its prop values as editor-ready strings.
 *
 * - JSX expression containers `{expr}` → `expr`
 * - String literals `"value"` → `"value"`
 * - Boolean shorthand (no value) → `true`
 *
 * Returns null if the element cannot be located.
 */
export function extractExpressionPropsFromSource(
  source: string,
  expressionName: string,
  line: number,
): Record<string, string> | null {
  let ast: AnyNode
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    }) as unknown as AnyNode
  } catch {
    return null
  }

  // Build a map of char offset → 1-based line number for fast lookup.
  const lineOffsets: number[] = [0]
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineOffsets.push(i + 1)
  }
  function offsetToLine(offset: number): number {
    let lo = 0, hi = lineOffsets.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineOffsets[mid] <= offset) lo = mid; else hi = mid - 1
    }
    return lo + 1
  }

  let foundOpening: any = null

  function walkNode(node: any): void {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walkNode); return }
    if (foundOpening) return

    if (
      node.type === 'JSXOpeningElement' &&
      node.name?.name === expressionName &&
      node.start != null &&
      offsetToLine(node.start) === line
    ) {
      foundOpening = node
      return
    }
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'tokens' || key === 'comments') continue
      walkNode((node as any)[key])
    }
  }

  walkNode(ast)
  if (!foundOpening) return null

  const result: Record<string, string> = {}
  for (const attr of foundOpening.attributes ?? []) {
    if (attr.type !== 'JSXAttribute') continue
    const name: string = attr.name?.name
    if (!name) continue
    const val = attr.value
    if (!val) {
      // Boolean shorthand: <Expr disabled />
      result[name] = 'true'
    } else if (val.type === 'StringLiteral') {
      result[name] = JSON.stringify(val.value)
    } else if (val.type === 'JSXExpressionContainer') {
      const expr = val.expression
      if (!expr || expr.type === 'JSXEmptyExpression') continue
      result[name] = source.slice(expr.start, expr.end)
    }
  }
  return result
}
