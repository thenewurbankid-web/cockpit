import { parse } from '@babel/parser'
import type { AstNode, AstLocFull, ComponentProp } from './types'

export function enrichWithTypeDeclaration(body: AstNode[], typeName: string, out: ComponentProp[]): void {
  for (const node of body) {
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

export function stringifyTSType(node: AstNode | null | undefined): string {
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
export const CSS_PROPERTY_NAMES = new Set([
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

export function inferTypeFromExpression(node: AstNode | null | undefined): string {
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
    const keys = props
      .filter(p => p.type === 'ObjectProperty')
      .map(p => {
        const k = (p as AstNode & { key?: AstNode & { name?: string; value?: string } }).key
        return k?.name ?? k?.value ?? ''
      })
    if (keys.length > 0 && keys.every(k => CSS_PROPERTY_NAMES.has(k))) return 'React.CSSProperties'
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

export function inferTypeFromValueString(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const isExpression = trimmed.startsWith('{') && trimmed.endsWith('}')
  // Try parsing as a parenthesised expression first (handles object literals like {key: val}).
  if (isExpression) {
    try {
      const ast = parse(`(${trimmed})`, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
      const stmts = (ast.program as unknown as { body: AstNode[] }).body
      const first = stmts[0]
      if (first) {
        const expr = first.type === 'ExpressionStatement'
          ? (first as AstNode & { expression?: AstNode }).expression ?? first
          : first
        const t = inferTypeFromExpression(expr)
        if (t !== 'unknown') return t
      }
    } catch { /* fall through */ }
  }
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
    if (isExpression) {
      try {
        const ast2 = parse(`(${trimmed})`, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
        const stmts2 = (ast2.program as unknown as { body: AstNode[] }).body
        const first2 = stmts2[0]
        if (first2) {
          const expr2 = first2.type === 'ExpressionStatement'
            ? (first2 as AstNode & { expression?: AstNode }).expression ?? first2
            : first2
          const t2 = inferTypeFromExpression(expr2)
          if (t2 !== 'unknown') return t2
        }
      } catch { /* fall through */ }
      return ''
    }
    return 'string'
  } catch {
    if (/^['"`]/.test(unwrapped) || /['"`]$/.test(unwrapped)) return 'string'
    if (/^-?\d+(\.\d+)?$/.test(unwrapped)) return 'number'
    if (unwrapped === 'true' || unwrapped === 'false') return 'boolean'
    if (unwrapped === 'null') return 'null'
    if (unwrapped === 'undefined') return 'undefined'
    return isExpression ? '' : 'string'
  }
}

export function inferTypeOfLocal(source: string, componentName: string, varName: string): string {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body

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

    const params = (fnNode as unknown as { params?: AstNode[] })?.params ?? []
    const firstParam = params[0]
    if (firstParam) {
      const paramNode = firstParam.type === 'AssignmentPattern' ? (firstParam as AstNode & { left?: AstNode }).left ?? firstParam : firstParam
      if (paramNode.type === 'ObjectPattern') {
        for (const p of ((paramNode as AstNode & { properties?: AstNode[] }).properties ?? [])) {
          const key = (p as AstNode & { key?: AstNode & { name?: string } }).key
          if (key?.name !== varName) continue
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

    for (const stmt of ((fnBody as AstNode & { body?: AstNode[] }).body ?? [])) {
      if (stmt.type !== 'VariableDeclaration') continue
      for (const d of ((stmt as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
        const id = (d as AstNode & { id?: AstNode }).id
        const init = (d as AstNode & { init?: AstNode }).init
        if (!id) continue

        const checkInit = (name: string, isSetterIndex?: number): string => {
          if (!init) return ''
          if (init.type === 'CallExpression') {
            const callee = (init as AstNode & { callee?: AstNode }).callee
            const calleeName = (callee as AstNode & { name?: string }).name
              ?? (callee as AstNode & { property?: AstNode & { name?: string } }).property?.name ?? ''
            if (calleeName === 'useState') {
              const typeParams = (init as AstNode & { typeParameters?: AstNode & { params?: AstNode[] } }).typeParameters
              if (typeParams?.params?.[0]) return stringifyTSType(typeParams.params[0])
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
          const typeAnn = (d as AstNode & { id?: AstNode & { typeAnnotation?: AstNode } }).id?.typeAnnotation
          if (typeAnn) return stringifyTSType((typeAnn as AstNode & { typeAnnotation?: AstNode }).typeAnnotation)
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

export function extractComponentLocals(source: string, componentName: string): string[] {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body

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

    const params = (fnNode as unknown as { params?: AstNode[] })?.params ?? []
    if (params[0]) collectPattern(params[0], results)

    const firstParam = params[0]
    if (firstParam) {
      const paramNode = firstParam.type === 'AssignmentPattern'
        ? (firstParam as AstNode & { left?: AstNode }).left ?? firstParam
        : firstParam
      const typeAnnotation = (paramNode as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
      const typeRef = (typeAnnotation as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
      const propsTypeName = typeRef?.type === 'TSTypeReference'
        ? String((typeRef as AstNode & { typeName?: AstNode & { name?: string } }).typeName?.name ?? '')
        : ''
      if (propsTypeName) {
        const scratch: ComponentProp[] = []
        enrichWithTypeDeclaration(body, propsTypeName, scratch)
        for (const p of scratch) if (!results.includes(p.name)) results.push(p.name)
      }
    }

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

export function inferOwnerComponentName(source: string, targetLine: number): string {
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

export function componentHasPropTypeDef(source: string, ownerName: string): boolean {
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

export function extractOwnerProps(source: string, ownerName: string): ComponentProp[] {
  const result: ComponentProp[] = []
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const body = (ast.program as unknown as { body: AstNode[] }).body

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

    let fnNode: AstNode | null | undefined =
      componentNode.type === 'VariableDeclarator'
        ? (componentNode as AstNode & { init?: AstNode }).init
        : componentNode

    // Unwrap React.forwardRef(renderFn) / React.memo(renderFn) —
    // esbuild compiles forwardRef components as a CallExpression whose first
    // argument is the actual render function. Without this the params lookup
    // below finds no params on the CallExpression and returns an empty array.
    if (fnNode?.type === 'CallExpression') {
      const args = (fnNode as AstNode & { arguments?: AstNode[] }).arguments ?? []
      const firstArg = args[0]
      if (
        firstArg &&
        (firstArg.type === 'FunctionExpression' || firstArg.type === 'ArrowFunctionExpression')
      ) {
        fnNode = firstArg
      }
    }

    const params = (fnNode as AstNode & { params?: AstNode[] })?.params ?? []
    const firstParam = params[0]
    if (!firstParam) return result

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
            else {
              const loc = right.loc as AstLocFull | undefined
              if (loc) {
                const srcLines = source.split('\n')
                if (loc.start.line === loc.end.line) {
                  defaultValue = srcLines[loc.start.line - 1]?.slice(loc.start.column, loc.end.column)
                } else {
                  const parts: string[] = []
                  for (let l = loc.start.line; l <= loc.end.line; l++) {
                    const ln = srcLines[l - 1] ?? ''
                    if (l === loc.start.line) parts.push(ln.slice(loc.start.column))
                    else if (l === loc.end.line) parts.push(ln.slice(0, loc.end.column))
                    else parts.push(ln)
                  }
                  defaultValue = parts.join('\n')
                }
              }
            }
          }
        }
        result.push({ name: key.name, typeStr: '', source: 'owner', defaultValue })
      }

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
