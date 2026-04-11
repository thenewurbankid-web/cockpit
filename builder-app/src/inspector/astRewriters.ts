import { parse } from '@babel/parser'
import type { AstNode, AstLocFull } from './types'
import { findSmallestContainingNode } from './astHelpers'

/**
 * Replace JSX text children of an element with a JSX expression container.
 * Converts <Btn>Sign In</Btn>  →  <Btn>{loading?'...':'Sign In'}</Btn>
 * Used when the user switches the "children" binding from value → expression mode.
 */
/**
 * Delete the JSX element at `targetLine` from source.
 * Removes the entire element (opening tag, children, closing tag) plus any
 * surrounding blank line left behind.
 */
export function deleteJsxNode(source: string, targetLine: number): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const root = ast.program as unknown as AstNode
    const jsxNode = findSmallestContainingNode(root, targetLine, (n) => n.type === 'JSXElement' || n.type === 'JSXFragment')
    if (!jsxNode) return source
    const loc = jsxNode.loc as AstLocFull | undefined
    if (!loc) return source
    const lines = source.split('\n')
    const startIdx = loc.start.line - 1   // 0-based
    const endIdx = loc.end.line - 1       // 0-based inclusive
    // Check whether the element occupies full lines (nothing else on those lines)
    const beforeOnStartLine = lines[startIdx].slice(0, loc.start.column).trim()
    const afterOnEndLine = lines[endIdx].slice(loc.end.column).trim()
    if (beforeOnStartLine === '' && afterOnEndLine === '') {
      // Remove whole lines, then clean up any empty line left behind
      lines.splice(startIdx, endIdx - startIdx + 1)
      if (startIdx < lines.length && lines[startIdx].trim() === '') {
        lines.splice(startIdx, 1)
      }
    } else {
      // Element is inline — remove just the element text
      const before = lines[startIdx].slice(0, loc.start.column)
      const after = lines[endIdx].slice(loc.end.column)
      lines.splice(startIdx, endIdx - startIdx + 1, before + after)
    }
    return lines.join('\n')
  } catch {
    return source
  }
}

export function rewriteJsxChildrenAsExpression(source: string, targetLine: number, expr: string): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const root = ast.program as unknown as AstNode
    const jsxNode = findSmallestContainingNode(root, targetLine, (n) => n.type === 'JSXElement')
    if (!jsxNode) return source

    const opening = jsxNode.openingElement as AstNode | undefined
    const closing = jsxNode.closingElement as AstNode | undefined
    if (!opening || !closing) return source

    const openLoc = opening.loc as AstLocFull | undefined
    const closeLoc = closing.loc as AstLocFull | undefined
    if (!openLoc || !closeLoc) return source

    // Replace everything between end of opening tag and start of closing tag with {expr}
    const lines = source.split('\n')
    const startLine = openLoc.end.line - 1   // 0-based
    const startCol  = openLoc.end.column
    const endLine   = closeLoc.start.line - 1 // 0-based
    const endCol    = closeLoc.start.column

    if (startLine === endLine) {
      const ln = lines[startLine]
      lines[startLine] = ln.slice(0, startCol) + `{${expr}}` + ln.slice(endCol)
    } else {
      // Multi-line children: splice out intermediate lines and rebuild
      const before = lines[startLine].slice(0, startCol)
      const after  = lines[endLine].slice(endCol)
      lines.splice(startLine, endLine - startLine + 1, before + `{${expr}}` + after)
    }
    return lines.join('\n')
  } catch {
    return source
  }
}

/** Rewrite a single JSX attribute value in the full source string. */
export function rewriteAttrValue(source: string, targetLine: number, attrName: string, newValue: string, asExpression: boolean): string {
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
      const newAttrStr = asExpression ? `${attrName}={${newValue}}` : `${attrName}="${newValue}"`
      const attrSrcStart = attrLoc.start.column
      const attrSrcEnd = attrLoc.end.column
      const newAttrLine =
        lines[attrLoc.start.line - 1].slice(0, attrSrcStart) + newAttrStr + lines[attrLoc.start.line - 1].slice(attrSrcEnd)
      lines[attrLoc.start.line - 1] = newAttrLine
      return lines.join('\n')
    }
    return source
  } catch {
    return source
  }
}

/** Remove a JSX attribute from a JSX element by name. */
export function removeAttr(source: string, targetLine: number, attrName: string): string {
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
        const before = ln.slice(0, attrLoc.start.column).replace(/\s+$/, '')
        const after = ln.slice(attrLoc.end.column)
        const newLn = before + after
        lines[attrLoc.start.line - 1] = newLn
        const result = lines.filter((l, i) => {
          if (i !== attrLoc.start.line - 1) return true
          return newLn.trim().length > 0
        })
        return result.join('\n')
      }
      lines.splice(attrLoc.start.line - 1, attrLoc.end.line - attrLoc.start.line + 1)
      return lines.join('\n')
    }
    return source
  } catch {
    return source
  }
}

/** Remove a prop from the component's props interface/type and its destructured param. */
export function removePropFromOwnerSignature(source: string, ownerName: string, propName: string): string {
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

/**
 * Insert a hook variable at the top of the component body.
 * Supports `useState` and `useRef`.
 * If the hook is not imported yet, adds the import.
 */
export function addStateVariable(
  source: string,
  ownerName: string,
  varName: string,
  initialValue: string,
  hook: 'useState' | 'useRef' = 'useState',
): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body
    const lines = source.split('\n')

    // 1. Ensure the hook is imported from 'react'.
    let hasHookImport = false
    for (const node of body) {
      if (node.type === 'ImportDeclaration') {
        const src = (node as AstNode & { source?: AstNode & { value?: string } }).source?.value
        if (src === 'react') {
          const specs = (node as AstNode & { specifiers?: AstNode[] }).specifiers ?? []
          for (const spec of specs) {
            const imported = (spec as AstNode & { imported?: AstNode & { name?: string } }).imported
            if (imported?.name === hook) hasHookImport = true
          }
          if (!hasHookImport) {
            const loc = node.loc as AstLocFull | undefined
            if (loc) {
              const importLine = lines[loc.start.line - 1]
              const braceIdx = importLine.lastIndexOf('}')
              if (braceIdx >= 0) {
                lines[loc.start.line - 1] =
                  importLine.slice(0, braceIdx) + ', ' + hook + importLine.slice(braceIdx)
              }
            }
            hasHookImport = true
          }
        }
      }
    }
    if (!hasHookImport) {
      lines.unshift(`import { ${hook} } from 'react'`)
    }

    // 2. Find the component function body and insert the hook call.
    const reparse = parse(lines.join('\n'), { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body2 = (reparse.program as unknown as { body: AstNode[] }).body
    let fnBody: AstNode | null = null
    const tryDecl = (decl: AstNode | undefined) => {
      if (!decl) return
      if (decl.type === 'FunctionDeclaration') {
        if ((decl as AstNode & { id?: { name?: string } }).id?.name === ownerName) {
          fnBody = (decl as AstNode & { body?: AstNode }).body ?? null
        }
      }
      if (decl.type === 'VariableDeclaration') {
        for (const d of ((decl as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
          if ((d as AstNode & { id?: { name?: string } }).id?.name === ownerName) {
            const init = (d as AstNode & { init?: AstNode }).init
            fnBody = (init as AstNode & { body?: AstNode })?.body ?? null
          }
        }
      }
    }
    for (const node of body2) {
      if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') {
        tryDecl((node as AstNode & { declaration?: AstNode }).declaration)
      }
      tryDecl(node)
      if (fnBody) break
    }
    if (!fnBody) return lines.join('\n')
    const resolvedBody: AstNode = fnBody

    const fnStmts = (resolvedBody as AstNode & { body?: AstNode[] }).body ?? []
    const fnBodyLoc = resolvedBody.loc as AstLocFull | undefined
    if (!fnBodyLoc) return lines.join('\n')

    let insertLine = fnBodyLoc.start.line
    for (const stmt of fnStmts) {
      const stmtLoc = stmt.loc as AstLocFull | undefined
      if (!stmtLoc) continue
      const stmtText = lines.slice(stmtLoc.start.line - 1, stmtLoc.end.line).join(' ')
      if (/\b(useState|useRef)\b/.test(stmtText)) {
        insertLine = stmtLoc.end.line
      }
    }

    const indent = '  '
    let newLine: string
    if (hook === 'useRef') {
      newLine = `${indent}const ${varName} = useRef(${initialValue || 'null'})`
    } else {
      const setterName = 'set' + varName.charAt(0).toUpperCase() + varName.slice(1)
      newLine = `${indent}const [${varName}, ${setterName}] = useState(${initialValue || "''"})`
    }
    lines.splice(insertLine, 0, newLine)
    return lines.join('\n')
  } catch {
    return source
  }
}

/**
 * Remove a useState variable declaration from a component's body.
 */
export function removeStateVariable(source: string, ownerName: string, varName: string): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body
    const lines = source.split('\n')

    let fnBody: AstNode | null = null
    const tryDecl = (decl: AstNode | undefined) => {
      if (!decl) return
      if (decl.type === 'FunctionDeclaration') {
        if ((decl as AstNode & { id?: { name?: string } }).id?.name === ownerName) {
          fnBody = (decl as AstNode & { body?: AstNode }).body ?? null
        }
      }
      if (decl.type === 'VariableDeclaration') {
        for (const d of ((decl as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
          if ((d as AstNode & { id?: { name?: string } }).id?.name === ownerName) {
            const init = (d as AstNode & { init?: AstNode }).init
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
    if (!fnBody) return source

    const fnStmts = (fnBody as AstNode & { body?: AstNode[] }).body ?? []

    for (const stmt of fnStmts) {
      if (stmt.type !== 'VariableDeclaration') continue
      const decls = (stmt as AstNode & { declarations?: AstNode[] }).declarations ?? []
      for (const d of decls) {
        const id = (d as AstNode & { id?: AstNode }).id
        if (!id) continue

        if (id.type === 'ArrayPattern') {
          const elements = (id as AstNode & { elements?: (AstNode | null)[] }).elements ?? []
          const firstEl = elements[0]
          if (!firstEl || firstEl.type !== 'Identifier') continue
          const name = (firstEl as AstNode & { name?: string }).name
          if (name !== varName) continue
          const init = (d as AstNode & { init?: AstNode }).init
          if (!init) continue
          const callee = (init as AstNode & { callee?: AstNode & { name?: string } }).callee
          if (callee?.name !== 'useState') continue
        } else if (id.type === 'Identifier') {
          const name = (id as AstNode & { name?: string }).name
          if (name !== varName) continue
        } else {
          continue
        }

        const stmtLoc = stmt.loc as AstLocFull | undefined
        if (!stmtLoc) continue
        lines.splice(stmtLoc.start.line - 1, stmtLoc.end.line - stmtLoc.start.line + 1)
        return lines.join('\n')
      }
    }

    return source
  } catch {
    return source
  }
}

/** Remove all JSX attribute usages of propName in the owning component body. */
export function removePropUsagesInBody(source: string, ownerName: string, propName: string): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body

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
          const loc = n.loc as AstLocFull | undefined
          if (loc) pendingEdits.push({ kind: 'removeAttr', loc })
        } else if (isDirectPropRef) {
          const identLoc = exprIdent!.loc as AstLocFull | undefined
          if (identLoc) pendingEdits.push({ kind: 'clearIdent', loc: identLoc })
        }
        return
      }
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

    pendingEdits.sort((a, b) => b.loc.start.line - a.loc.start.line || b.loc.start.column - a.loc.start.column)
    const lines = source.split('\n')
    for (const edit of pendingEdits) {
      const { loc } = edit
      if (loc.start.line === loc.end.line) {
        const ln = lines[loc.start.line - 1]
        if (edit.kind === 'clearIdent') {
          lines[loc.start.line - 1] = ln.slice(0, loc.start.column) + 'undefined' + ln.slice(loc.end.column)
        } else {
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

/** Insert a new JSX attribute before the closing `>` or `/>` of the opening element. */
export function insertAttr(source: string, targetLine: number, attrName: string, attrValue: string, asExpression: boolean): string {
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
    const endCol = openLoc.end.column

    const newAttrStr = asExpression ? ` ${attrName}={${attrValue}}` : ` ${attrName}="${attrValue}"`

    const tailLen = selfClosing ? 2 : 1
    const line = lines[endLine]
    lines[endLine] = line.slice(0, endCol - tailLen) + newAttrStr + line.slice(endCol - tailLen)
    return lines.join('\n')
  } catch {
    return source
  }
}

/** Add a new prop to the owning component's props interface/type + parameter destructure. */
export function addPropToOwnerSignature(
  source: string,
  ownerName: string,
  propName: string,
  propType: string,
  defaultValue?: string
): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body

    let propsTypeName = ''
    let paramPatternLoc: AstLocFull | null = null
    let paramPatternNode: AstNode | null = null
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

    function applyDestructureInsertion() {
      if (!paramPatternNode || !paramPatternLoc) return
      const props = (paramPatternNode as AstNode & { properties?: AstNode[] }).properties ?? []
      const entry = defaultValue ? `${propName} = ${defaultValue}` : propName

      const typeAnn = (paramPatternNode as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
      const typeAnnLoc = typeAnn?.loc as AstLocFull | undefined

      let lineIdx: number
      let closingBraceCol: number

      if (typeAnnLoc) {
        lineIdx = typeAnnLoc.start.line - 1
        let col = typeAnnLoc.start.column - 1
        const ln = lines[lineIdx]
        while (col > 0 && ln[col] !== '}') col--
        closingBraceCol = col
      } else {
        lineIdx = paramPatternLoc.end.line - 1
        closingBraceCol = paramPatternLoc.end.column - 1
      }

      const ln = lines[lineIdx]
      if (props.length === 0) {
        const startCol = paramPatternLoc.start.column
        lines[lineIdx] = ln.slice(0, startCol) + `{ ${entry} }` + ln.slice(closingBraceCol + 1)
      } else {
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
          applyDestructureInsertion()
          lines.splice(closingBrace, 0, `${indent}${propName}?: ${propType}`)
          return lines.join('\n')
        }
      }
    }

    // 3. Fallback: append to destructure pattern.
    if (paramPatternLoc) {
      applyDestructureInsertion()
      return lines.join('\n')
    }

    // 4. Bootstrap: component has no params.
    if (fnForBootstrap) {
      const { fn: fnAst, declStartLine } = fnForBootstrap
      const propsInterfaceName = `${ownerName}Props`

      const alreadyExists = body.some(
        (n) =>
          (n.type === 'TSInterfaceDeclaration' || n.type === 'TSTypeAliasDeclaration') &&
          (n as AstNode & { id?: AstNode & { name?: string } }).id?.name === propsInterfaceName
      )

      const fnStart = (fnAst as AstNode & { start?: number }).start
      const fnBodyNode = (fnAst as AstNode & { body?: AstNode & { start?: number } }).body
      const bodyStart = fnBodyNode?.start

      if (!alreadyExists && typeof fnStart === 'number' && typeof bodyStart === 'number') {
        const signature = source.slice(fnStart, bodyStart)
        const entry = defaultValue ? `${propName} = ${defaultValue}` : propName
        const newSignature = signature.replace(/\(\s*\)/, `({ ${entry} }: ${propsInterfaceName})`)
        if (newSignature !== signature) {
          const modified = source.slice(0, fnStart) + newSignature + source.slice(bodyStart)
          const modLines = modified.split('\n')
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

/** Rewrite the type annotation of a prop in the component's props interface/type. */
export function rewritePropType(source: string, _ownerName: string, propName: string, newType: string): string {
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

/** Rewrite the default value of a prop in the component destructure pattern. */
export function rewriteDefaultValue(source: string, ownerName: string, propName: string, newDefault: string): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body
    const lines = source.split('\n')

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
          const right = (valNode as AstNode & { right?: AstNode }).right
          const loc = right?.loc as AstLocFull | undefined
          if (loc && loc.start.line === loc.end.line) {
            const ln = lines[loc.start.line - 1]
            if (!newDefault.trim()) {
              const before = ln.slice(0, loc.start.column)
              const eqIdx = before.lastIndexOf('=')
              if (eqIdx !== -1) {
                lines[loc.start.line - 1] = before.slice(0, eqIdx).trimEnd() + ln.slice(loc.end.column)
              }
            } else {
              lines[loc.start.line - 1] = ln.slice(0, loc.start.column) + newDefault + ln.slice(loc.end.column)
            }
            return lines.join('\n')
          }
        } else {
          if (!newDefault.trim()) return source
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

/**
 * Reorder all props in the interface/type alias AND the component's destructure params
 * to match `orderedNames`. Names not in the list are appended in original order.
 * Handles both single-line and multi-line prop declarations.
 */
export function reorderPropsInSource(source: string, orderedNames: string[]): string {
  if (orderedNames.length === 0) return source
  try {
    type ItemInfo = { name: string; startLine: number; endLine: number; startColumn: number; endColumn: number }

    /** Reorder multi-line items (each item starts on its own line). Mutates srcLines. */
    function reorderMultiLine(srcLines: string[], items: ItemInfo[], order: string[]): void {
      const itemTexts = items.map(item => srcLines.slice(item.startLine - 1, item.endLine))
      const nameToText = new Map(items.map((item, i) => [item.name, itemTexts[i]]))
      const first0 = items[0].startLine - 1
      const last0 = items[items.length - 1].endLine - 1
      const slotIndents = items.map(item => (srcLines[item.startLine - 1].match(/^(\s*)/) ?? ['', ''])[1])
      const newLines: string[] = []
      for (let i = 0; i < order.length; i++) {
        const text = nameToText.get(order[i]) ?? itemTexts[i]
        newLines.push(slotIndents[i] + text[0].trimStart())
        for (let j = 1; j < text.length; j++) newLines.push(text[j])
      }
      srcLines.splice(first0, last0 - first0 + 1, ...newLines)
    }

    /** Reorder single-line items (all on the same line). Mutates srcLines. */
    function reorderSingleLine(srcLines: string[], items: ItemInfo[], order: string[]): void {
      const lineIdx = items[0].startLine - 1
      const ln = srcLines[lineIdx]
      const texts = items.map(item => ln.slice(item.startColumn, item.endColumn))
      const seps = items.slice(0, -1).map((item, i) => ln.slice(item.endColumn, items[i + 1].startColumn))
      const nameToText = new Map(items.map((item, i) => [item.name, texts[i]]))
      const newSection = order.reduce((acc, name, i) => acc + (nameToText.get(name) ?? '') + (i < seps.length ? seps[i] : ''), '')
      srcLines[lineIdx] = ln.slice(0, items[0].startColumn) + newSection + ln.slice(items[items.length - 1].endColumn)
    }

    function buildOrder(items: ItemInfo[]): string[] {
      const remaining = items.filter(item => !orderedNames.includes(item.name)).map(item => item.name)
      return [...orderedNames.filter(n => items.some(item => item.name === n)), ...remaining]
    }

    // ── Step 1: Reorder interface / type alias members (always multi-line) ────
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body
    let lines = source.split('\n')

    for (const node of body) {
      let members: AstNode[] | null = null
      if (node.type === 'TSInterfaceDeclaration') {
        members = (node as AstNode & { body?: AstNode & { body?: AstNode[] } }).body?.body ?? []
      } else if (node.type === 'TSTypeAliasDeclaration') {
        const ta = (node as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
        if (ta?.type === 'TSTypeLiteral') members = (ta as AstNode & { members?: AstNode[] }).members ?? []
      }
      if (!members || members.length < 2) continue
      const items = members.map(m => {
        const loc = m.loc as AstLocFull | undefined
        const key = (m as AstNode & { key?: AstNode & { name?: string } }).key
        if (!loc) return null
        return { name: key?.name ?? '', startLine: loc.start.line, endLine: loc.end.line, startColumn: loc.start.column, endColumn: loc.end.column }
      })
      if (items.some(i => i === null)) continue
      reorderMultiLine(lines, items as ItemInfo[], buildOrder(items as ItemInfo[]))
      break
    }

    // ── Step 2: Reorder destructured params ───────────────────────────────────
    const ast2 = parse(lines.join('\n'), { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body2 = (ast2.program as unknown as { body: AstNode[] }).body
    let lines2 = lines

    const candidates: AstNode[] = []
    for (const node of body2) {
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
      const params = (cand as AstNode & { params?: AstNode[] })?.params ?? []
      const firstParam = params[0]
      if (!firstParam) continue
      const pattern = firstParam.type === 'ObjectPattern' ? firstParam
        : firstParam.type === 'AssignmentPattern' ? (firstParam as AstNode & { left?: AstNode }).left
        : null
      if (pattern?.type !== 'ObjectPattern') continue
      const properties = (pattern as AstNode & { properties?: AstNode[] }).properties ?? []
      const regularProps = properties.filter(p => p.type !== 'RestElement')
      if (regularProps.length < 2) continue
      const propItems = regularProps.map(p => {
        const loc = p.loc as AstLocFull | undefined
        const key = (p as AstNode & { key?: AstNode & { name?: string } }).key
        if (!loc) return null
        return { name: key?.name ?? '', startLine: loc.start.line, endLine: loc.end.line, startColumn: loc.start.column, endColumn: loc.end.column }
      })
      if (propItems.some(p => p === null)) continue
      const validItems = propItems as ItemInfo[]
      const fullOrder = buildOrder(validItems)
      const isSingleLine = validItems[0].startLine === validItems[validItems.length - 1].startLine
      if (isSingleLine) {
        reorderSingleLine(lines2, validItems, fullOrder)
      } else {
        reorderMultiLine(lines2, validItems, fullOrder)
      }
      break
    }

    return lines2.join('\n')
  } catch {
    return source
  }
}
