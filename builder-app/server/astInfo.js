/**
 * AST info extraction — parses a file with @babel/parser and returns
 * component & JSX expression metadata.
 */
import { parse as babelParse } from '@babel/parser'

export function extractAstInfo(source, filePath) {
  let ast
  try {
    ast = babelParse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true,
    })
  } catch {
    return { components: [], expressions: [] }
  }

  const components = []
  const expressions = []
  let currentComponent = null

  function walkNode(node) {
    if (!node || typeof node !== 'object') return
    if (!node.type) {
      // Array or plain object — recurse children
      if (Array.isArray(node)) node.forEach(walkNode)
      return
    }

    // Track component boundaries
    const prevComponent = currentComponent
    if (
      node.type === 'FunctionDeclaration' &&
      node.id?.name &&
      /^[A-Z]/.test(node.id.name)
    ) {
      currentComponent = { name: node.id.name, line: node.loc?.start?.line ?? 1 }
      components.push(currentComponent)
    } else if (node.type === 'VariableDeclarator' && node.id?.name && /^[A-Z]/.test(node.id.name)) {
      const init = node.init
      if (
        init &&
        (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')
      ) {
        currentComponent = { name: node.id.name, line: node.loc?.start?.line ?? 1 }
        components.push(currentComponent)
      }
    }

    // Collect JSX elements
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
      let name = null
      if (node.type === 'JSXElement' && node.openingElement?.name) {
        const n = node.openingElement.name
        name = n.type === 'JSXIdentifier' ? n.name : n.type === 'JSXMemberExpression' ? readJSXMemberName(n) : null
      }
      expressions.push({
        name,
        line: node.loc?.start?.line ?? 1,
        column: node.loc?.start?.column ?? 0,
        ownerComponent: currentComponent?.name ?? null,
      })
    }

    // Recurse into child nodes
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const child = node[key]
      if (Array.isArray(child)) {
        child.forEach(walkNode)
      } else if (child && typeof child === 'object' && child.type) {
        walkNode(child)
      }
    }

    currentComponent = prevComponent
  }

  function readJSXMemberName(node) {
    if (node.type === 'JSXIdentifier') return node.name
    if (node.type === 'JSXMemberExpression') {
      return `${readJSXMemberName(node.object)}.${readJSXMemberName(node.property)}`
    }
    return '?'
  }

  walkNode(ast.program)
  return { components, expressions }
}
