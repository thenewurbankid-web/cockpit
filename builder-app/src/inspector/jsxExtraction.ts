import { parse } from '@babel/parser'
import type { AstNode, AstLocFull, JsxAttr, JsxTextChild } from './types'
import { findSmallestContainingNode } from './astHelpers'

export function extractJsxAttrs(source: string, targetLine: number): JsxAttr[] {
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

export function extractJsxTextChildren(source: string, targetLine: number): JsxTextChild[] {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const root = ast.program as unknown as AstNode
    const jsxNode = findSmallestContainingNode(root, targetLine, (n) => n.type === 'JSXElement')
    if (!jsxNode) return []
    const srcLines = source.split('\n')
    const children = (jsxNode as AstNode & { children?: AstNode[] }).children ?? []
    const result: JsxTextChild[] = []
    let idx = 0
    for (const child of children) {
      if (child.type === 'JSXText') {
        const raw = String((child as AstNode & { value?: string }).value ?? '')
        if (!raw.trim()) continue
        const loc = child.loc as AstLocFull | undefined
        if (!loc) continue
        result.push({
          kind: 'text', index: idx++, value: raw,
          startLine: loc.start.line - 1, startCol: loc.start.column,
          endLine: loc.end.line - 1, endCol: loc.end.column,
        })
      } else if (child.type === 'JSXExpressionContainer') {
        const expr = (child as AstNode & { expression?: AstNode }).expression
        if (!expr || expr.type === 'JSXEmptyExpression') continue
        if (
          expr.type !== 'Identifier' &&
          expr.type !== 'StringLiteral' &&
          expr.type !== 'NumericLiteral' &&
          expr.type !== 'TemplateLiteral'
        ) continue
        const loc = expr.loc as AstLocFull | undefined
        if (!loc) continue
        let value = ''
        if (loc.start.line === loc.end.line) {
          value = srcLines[loc.start.line - 1]?.slice(loc.start.column, loc.end.column) ?? ''
        } else {
          const parts: string[] = []
          for (let l = loc.start.line; l <= loc.end.line; l++) {
            const ln = srcLines[l - 1] ?? ''
            if (l === loc.start.line) parts.push(ln.slice(loc.start.column))
            else if (l === loc.end.line) parts.push(ln.slice(0, loc.end.column))
            else parts.push(ln)
          }
          value = parts.join('\n')
        }
        result.push({
          kind: 'expr', index: idx++, value,
          startLine: loc.start.line - 1, startCol: loc.start.column,
          endLine: loc.end.line - 1, endCol: loc.end.column,
        })
      }
    }
    return result
  } catch {
    return []
  }
}

export function rewriteJsxTextChild(source: string, child: JsxTextChild, newValue: string): string {
  const lines = source.split('\n')
  if (child.startLine === child.endLine) {
    const ln = lines[child.startLine]
    lines[child.startLine] = ln.slice(0, child.startCol) + newValue + ln.slice(child.endCol)
  } else {
    const before = lines[child.startLine].slice(0, child.startCol)
    const after = lines[child.endLine].slice(child.endCol)
    lines.splice(child.startLine, child.endLine - child.startLine + 1, before + newValue + after)
  }
  return lines.join('\n')
}

// Find all JSX usage sites of a component tag by scanning window.__LOCATOR_DATA__.
export function findLocatorUsages(componentTag: string): Array<{ file: string; line: number }> {
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
