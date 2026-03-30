/**
 * File templates and prop extraction helpers for pages, components, and expressions.
 */
import { parse as babelParse } from '@babel/parser'

// ── Page template ─────────────────────────────────────────────────────────────

export function buildPageTemplate(componentName, label) {
  return [
    `import React from 'react'`,
    ``,
    `interface ${componentName}Props {`,
    `  navigate?: (page: string) => void`,
    `}`,
    ``,
    `export function ${componentName}({ navigate }: ${componentName}Props) {`,
    `  return (`,
    `    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>`,
    `      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.5rem' }}>${label}</h1>`,
    `      <p style={{ color: '#6b7280', margin: 0 }}>New page \u2014 start editing in your editor.</p>`,
    `    </div>`,
    `  )`,
    `}`,
  ].join('\n')
}

// ── Component template ────────────────────────────────────────────────────────

export function buildComponentTemplate(componentName, label) {
  return [
    `import React from 'react'`,
    ``,
    `interface ${componentName}Props {}`,
    ``,
    `export function ${componentName}({}: ${componentName}Props) {`,
    `  return (`,
    `    <div style={{ padding: '1rem', fontFamily: 'system-ui, sans-serif' }}>`,
    `      <span>${label}</span>`,
    `    </div>`,
    `  )`,
    `}`,
  ].join('\n')
}

// ── Expression template ───────────────────────────────────────────────────────

export function buildExpressionTemplate(componentName, props) {
  // Build interface props lines (children always included at end)
  const ifaceProps = [...props.map((p) => `  ${p}: unknown`), `  children: ReactNode`]
  // Build destructure params
  const destructure = [...props, 'children'].join(', ')
  // Build a trivial body — return children, ignore extra props for now
  const body = props.length > 0
    ? `  // TODO: use ${props.join(', ')}\n  return <>{children}</>`
    : `  return <>{children}</>`

  return [
    `import type { ReactNode } from 'react'`,
    ``,
    `interface ${componentName}Props {`,
    ...ifaceProps,
    `}`,
    ``,
    `export function ${componentName}({ ${destructure} }: ${componentName}Props) {`,
    body,
    `}`,
  ].join('\n')
}

// ── Expression prop extraction ────────────────────────────────────────────────

/**
 * Read prop names from a TSInterfaceDeclaration or TSTypeAliasDeclaration named
 * `{componentName}Props`. This is more reliable than reading from the destructuring
 * parameter because Babel's error-recovery can misparse reserved words (like `else`,
 * `then`) in parameter destructuring position, while property names in interface
 * bodies are always parsed as IdentifierName tokens without ambiguity.
 */
function propsFromInterface(ast, componentName) {
  const ifaceName = `${componentName}Props`
  for (const node of ast.program.body) {
    // interface FooProps { a: T; b: T }
    if (
      (node.type === 'TSInterfaceDeclaration') &&
      node.id?.name === ifaceName
    ) {
      return (node.body?.body ?? [])
        .filter((m) => m.type === 'TSPropertySignature')
        .map((m) => m.key?.name ?? null)
        .filter((name) => name !== null)
    }
    // type FooProps = { a: T; b: T }
    if (
      node.type === 'TSTypeAliasDeclaration' &&
      node.id?.name === ifaceName &&
      node.typeAnnotation?.type === 'TSTypeLiteral'
    ) {
      return (node.typeAnnotation.members ?? [])
        .filter((m) => m.type === 'TSPropertySignature')
        .map((m) => m.key?.name ?? null)
        .filter((name) => name !== null)
    }
  }
  return null
}

function propsFromParams(params) {
  if (!params || params.length === 0) return []
  const first = params[0]
  // Strip TS type annotation wrapper
  const pattern = first.type === 'AssignmentPattern' ? first.left : first

  if (pattern.type !== 'ObjectPattern') return []
  return pattern.properties
    .filter((p) => p.type === 'ObjectProperty' || p.type === 'RestElement')
    .map((p) => {
      if (p.type === 'RestElement') return null
      const key = p.key
      // key.name works for both Identifier and keyword nodes
      return key?.name ?? null
    })
    .filter((name) => name !== null)
}

/** Extract prop names (excluding children) from the first param of the exported function. */
export function extractExpressionProps(source) {
  let ast
  try {
    ast = babelParse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true,
    })
  } catch {
    return []
  }

  for (const node of ast.program.body) {
    // export function Foo({ a, b }: FooProps) {}
    if (
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'FunctionDeclaration'
    ) {
      const compName = node.declaration.id?.name
      // Prefer reading from the interface (avoids keyword-in-destructuring parse issues)
      const fromIface = compName ? propsFromInterface(ast, compName) : null
      return fromIface ?? propsFromParams(node.declaration.params)
    }
    // export const Foo = ({ a, b }) => {}
    if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration') {
      for (const decl of node.declaration.declarations) {
        const init = decl.init
        if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') {
          const compName = decl.id?.name
          const fromIface = compName ? propsFromInterface(ast, compName) : null
          return fromIface ?? propsFromParams(init.params)
        }
      }
    }
  }
  return []
}
