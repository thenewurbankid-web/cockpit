/**
 * Builder dev server — Express
 *
 * GET  /__source?file=<absolute-path>  → returns file contents as plain text
 * POST /__source                        → overwrites file (body: { file, content })
 *
 * Security note: this is DEV-ONLY. The file-path is validated to stay inside
 * the monorepo root before any read/write is performed.
 */
import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import ts from 'typescript'

import { parse as babelParse } from '@babel/parser'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Monorepo root is one level up from builder-app/server/
const REPO_ROOT = path.resolve(__dirname, '../../')

const app = express()
app.use(express.json({ limit: '2mb' }))

/** Ensure the resolved path is inside the monorepo root (path-traversal guard). */
function isSafeFile(filePath) {
  const resolved = path.resolve(filePath)
  // On Windows, drive letter casing can differ (d: vs D:), so compare
  // case-insensitively when on a case-insensitive file system.
  const isWin = process.platform === 'win32'
  const r = isWin ? resolved.toLowerCase() : resolved
  const root = isWin ? REPO_ROOT.toLowerCase() : REPO_ROOT
  return r.startsWith(root + path.sep) || r.startsWith(root + '/')
}

function findTsConfigForFile(filePath) {
  const fromDir = path.dirname(path.resolve(filePath))
  return ts.findConfigFile(fromDir, ts.sys.fileExists, 'tsconfig.json')
}

function formatDiagnosticMessage(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
}

function categoryToSeverity(category) {
  if (category === ts.DiagnosticCategory.Error) return 8
  if (category === ts.DiagnosticCategory.Warning) return 4
  if (category === ts.DiagnosticCategory.Suggestion) return 2
  return 1
}

function getDiagnosticsForFile(filePath, overrideContent) {
  const absFile = path.resolve(filePath)
  const configPath = findTsConfigForFile(absFile)
  if (!configPath) {
    return { diagnostics: [], error: `No tsconfig.json found for ${absFile}` }
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) {
    return { diagnostics: [], error: formatDiagnosticMessage(configFile.error) }
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath
  )

  if (parsed.errors.length > 0) {
    return { diagnostics: [], error: formatDiagnosticMessage(parsed.errors[0]) }
  }

  const overrideAbs = overrideContent != null ? absFile : null
  const defaultHost = ts.createCompilerHost(parsed.options)
  const host = {
    ...defaultHost,
    readFile(fileName) {
      const resolved = path.resolve(fileName)
      if (overrideAbs && resolved === overrideAbs) return overrideContent
      return defaultHost.readFile(fileName)
    },
    fileExists(fileName) {
      const resolved = path.resolve(fileName)
      if (overrideAbs && resolved === overrideAbs) return true
      return defaultHost.fileExists(fileName)
    },
    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      const resolved = path.resolve(fileName)
      if (overrideAbs && resolved === overrideAbs) {
        return ts.createSourceFile(fileName, overrideContent, languageVersion, true)
      }
      return defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
    },
  }

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    host,
  })

  const source = program.getSourceFile(absFile)
  if (!source) {
    return { diagnostics: [], error: `File is not included in project: ${absFile}` }
  }

  const diagnostics = [
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source),
  ]

  return {
    diagnostics: diagnostics.map((d) => {
      const start = d.start ?? 0
      const length = d.length ?? 1
      const s = source.getLineAndCharacterOfPosition(start)
      const e = source.getLineAndCharacterOfPosition(start + Math.max(length, 1))
      return {
        code: d.code,
        message: formatDiagnosticMessage(d),
        severity: categoryToSeverity(d.category),
        startLineNumber: s.line + 1,
        startColumn: s.character + 1,
        endLineNumber: e.line + 1,
        endColumn: e.character + 1,
      }
    }),
    error: null,
  }
}

app.get('/__source', (req, res) => {
  const rawFile = req.query.file
  if (typeof rawFile !== 'string' || !rawFile) {
    return res.status(400).json({ error: 'Missing ?file= query parameter' })
  }

  const filePath = path.resolve(rawFile)
  console.log(`[GET /__source] raw="${rawFile}" resolved="${filePath}"`)

  if (!isSafeFile(filePath)) {
    return res.status(403).json({ error: 'Access denied' })
  }

  if (!fs.existsSync(filePath)) {
    console.error(`[GET /__source] File not found: ${filePath}`)
    return res.status(404).json({ error: `File not found: ${filePath}` })
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  res.type('text/plain').send(content)
})

app.post('/__source', (req, res) => {
  const { file: rawFile, content } = req.body ?? {}

  if (typeof rawFile !== 'string' || typeof content !== 'string') {
    return res.status(400).json({ error: 'Body must contain { file: string, content: string }' })
  }

  const filePath = path.resolve(rawFile)

  if (!isSafeFile(filePath)) {
    return res.status(403).json({ error: 'Access denied' })
  }

  fs.writeFileSync(filePath, content, 'utf-8')
  // Vite HMR will detect the file change automatically.
  res.json({ ok: true })
})

app.get('/__source/list-pages', (req, res) => {
  const loginAppPages = path.resolve(REPO_ROOT, 'login-app/src/pages')
  if (!fs.existsSync(loginAppPages)) {
    return res.json({ pages: [] })
  }

  const files = fs.readdirSync(loginAppPages)
  const pages = files
    .filter((f) => f.endsWith('Page.tsx'))
    .map((f) => {
      const componentName = f.replace(/\.tsx$/, '')
      // "ForgotPasswordPage" → "Forgot Password", "TestPage" → "Test"
      const label = componentName
        .replace(/Page$/, '')
        .replace(/([A-Z])/g, ' $1')
        .trim()
      const id = label.toLowerCase().replace(/\s+/g, '-')
      return { id, label, root: componentName }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  res.json({ pages })
})

app.post('/__source/create-page', (req, res) => {
  const { name } = req.body ?? {}
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Body must contain { name: string }' })
  }

  const trimmed = name.trim()
  // "my page" → "MyPage", "settings" → "SettingsPage"
  const componentName =
    trimmed.replace(/(?:^|\s+)\w/g, (c) => c.trim().toUpperCase()).replace(/\s+/g, '') + 'Page'
  const id = trimmed.toLowerCase().replace(/\s+/g, '-')

  const loginAppPages = path.resolve(REPO_ROOT, 'login-app/src/pages')
  const filePath = path.join(loginAppPages, `${componentName}.tsx`)

  if (!isSafeFile(filePath)) {
    return res.status(403).json({ error: 'Access denied' })
  }
  if (fs.existsSync(filePath)) {
    return res.status(409).json({ error: `File already exists: ${componentName}.tsx` })
  }

  const template = [
    `import React from 'react'`,
    ``,
    `interface ${componentName}Props {`,
    `  navigate?: (page: string) => void`,
    `}`,
    ``,
    `export function ${componentName}({ navigate }: ${componentName}Props) {`,
    `  return (`,
    `    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>`,
    `      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.5rem' }}>${trimmed}</h1>`,
    `      <p style={{ color: '#6b7280', margin: 0 }}>New page \u2014 start editing in your editor.</p>`,
    `    </div>`,
    `  )`,
    `}`,
  ].join('\n')

  fs.mkdirSync(loginAppPages, { recursive: true })
  fs.writeFileSync(filePath, template, 'utf-8')
  console.log(`[create-page] Created ${filePath}`)
  res.json({ ok: true, componentName, id })
})

app.delete('/__source/page/:componentName', (req, res) => {
  const { componentName } = req.params
  if (!componentName || !/^[A-Z][a-zA-Z0-9]+Page$/.test(componentName)) {
    return res.status(400).json({ error: 'Invalid component name' })
  }

  const loginAppPages = path.resolve(REPO_ROOT, 'login-app/src/pages')
  const filePath = path.join(loginAppPages, `${componentName}.tsx`)

  if (!isSafeFile(filePath)) {
    return res.status(403).json({ error: 'Access denied' })
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File not found: ${componentName}.tsx` })
  }

  fs.unlinkSync(filePath)
  console.log(`[delete-page] Deleted ${filePath}`)
  res.json({ ok: true })
})

app.get('/__source/list-components', (req, res) => {
  const dir = path.resolve(REPO_ROOT, 'login-app/src/components')
  if (!fs.existsSync(dir)) return res.json({ components: [] })

  const files = fs.readdirSync(dir)
  const components = files
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => {
      const name = f.replace(/\.tsx$/, '')
      const label = name.replace(/([A-Z])/g, ' $1').trim()
      const id = label.toLowerCase().replace(/\s+/g, '-')
      return { id, label, name }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
  res.json({ components })
})

app.post('/__source/create-component', (req, res) => {
  const { name } = req.body ?? {}
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Body must contain { name: string }' })
  }
  const trimmed = name.trim()
  const componentName =
    trimmed.replace(/(?:^|\s+)\w/g, (c) => c.trim().toUpperCase()).replace(/\s+/g, '')
  const id = trimmed.toLowerCase().replace(/\s+/g, '-')
  const dir = path.resolve(REPO_ROOT, 'login-app/src/components')
  const filePath = path.join(dir, `${componentName}.tsx`)

  if (!isSafeFile(filePath)) return res.status(403).json({ error: 'Access denied' })
  if (fs.existsSync(filePath)) {
    return res.status(409).json({ error: `File already exists: ${componentName}.tsx` })
  }

  const template = [
    `import React from 'react'`,
    ``,
    `interface ${componentName}Props {}`,
    ``,
    `export function ${componentName}({}: ${componentName}Props) {`,
    `  return (`,
    `    <div style={{ padding: '1rem', fontFamily: 'system-ui, sans-serif' }}>`,
    `      <span>${trimmed}</span>`,
    `    </div>`,
    `  )`,
    `}`,
  ].join('\n')

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, template, 'utf-8')
  console.log(`[create-component] Created ${filePath}`)
  res.json({ ok: true, componentName, id })
})

app.delete('/__source/component/:componentName', (req, res) => {
  const { componentName } = req.params
  if (!componentName || !/^[A-Z][a-zA-Z0-9]+$/.test(componentName)) {
    return res.status(400).json({ error: 'Invalid component name' })
  }
  const dir = path.resolve(REPO_ROOT, 'login-app/src/components')
  const filePath = path.join(dir, `${componentName}.tsx`)

  if (!isSafeFile(filePath)) return res.status(403).json({ error: 'Access denied' })
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File not found: ${componentName}.tsx` })
  }
  fs.unlinkSync(filePath)
  console.log(`[delete-component] Deleted ${filePath}`)
  res.json({ ok: true })
})

app.post('/__diagnostics', (req, res) => {
  const { file: rawFile, content } = req.body ?? {}
  if (typeof rawFile !== 'string' || !rawFile) {
    return res.status(400).json({ error: 'Body must contain { file: string, content?: string }' })
  }

  const filePath = path.resolve(rawFile)
  if (!isSafeFile(filePath)) {
    return res.status(403).json({ error: 'Access denied' })
  }

  const { diagnostics, error } = getDiagnosticsForFile(filePath, typeof content === 'string' ? content : undefined)
  if (error) {
    return res.status(400).json({ error, diagnostics: [] })
  }
  return res.json({ diagnostics })
})

// ── On-demand AST info ────────────────────────────────────────────────────────
// Parses a file with @babel/parser and returns component & JSX expression metadata.
// Replaces the compile-time __LOCATOR_DATA__ that @locator/babel-jsx used to inject.

function extractAstInfo(source, filePath) {
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

app.get('/__source/ast-info', (req, res) => {
  const rawFile = req.query.file
  if (typeof rawFile !== 'string' || !rawFile) {
    return res.status(400).json({ error: 'Missing ?file= query parameter' })
  }

  const filePath = path.resolve(rawFile)
  if (!isSafeFile(filePath)) {
    return res.status(403).json({ error: 'Access denied' })
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File not found: ${filePath}` })
  }

  const source = fs.readFileSync(filePath, 'utf-8')
  const info = extractAstInfo(source, filePath)
  res.json(info)
})

// ── Expressions ──────────────────────────────────────────────────────────────

const EXPRESSIONS_DIR = path.resolve(REPO_ROOT, 'login-app/src/expressions')

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

/** Extract prop names (excluding children) from the first param of the exported function. */
function extractExpressionProps(source) {
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

app.get('/__source/list-expressions', (req, res) => {
  if (!fs.existsSync(EXPRESSIONS_DIR)) return res.json({ expressions: [] })

  const files = fs.readdirSync(EXPRESSIONS_DIR).filter((f) => f.endsWith('.tsx'))
  const expressions = files.map((f) => {
    const filePath = path.join(EXPRESSIONS_DIR, f)
    const source = fs.readFileSync(filePath, 'utf-8')
    const name = f.replace(/\.tsx$/, '')
    const props = extractExpressionProps(source)
    return { name, file: filePath, props }
  }).sort((a, b) => a.name.localeCompare(b.name))

  res.json({ expressions })
})

app.post('/__source/create-expression', (req, res) => {
  const { name, props: rawProps } = req.body ?? {}
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Body must contain { name: string }' })
  }

  const trimmed = name.trim()
  // Ensure PascalCase
  const componentName =
    trimmed.replace(/(?:^|\s+)\w/g, (c) => c.trim().toUpperCase()).replace(/\s+/g, '')

  if (!/^[A-Z][a-zA-Z0-9]+$/.test(componentName)) {
    return res.status(400).json({ error: 'Invalid expression name' })
  }

  const filePath = path.join(EXPRESSIONS_DIR, `${componentName}.tsx`)

  if (!isSafeFile(filePath)) return res.status(403).json({ error: 'Access denied' })
  if (fs.existsSync(filePath)) {
    return res.status(409).json({ error: `File already exists: ${componentName}.tsx` })
  }

  // Validate and sanitise prop names
  const props = Array.isArray(rawProps)
    ? rawProps.filter((p) => typeof p === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p) && p !== 'children')
    : []

  // Build interface props lines (children always included at end)
  const ifaceProps = [...props.map((p) => `  ${p}: unknown`), `  children: ReactNode`]
  // Build destructure params
  const destructure = [...props, 'children'].join(', ')
  // Build a trivial body — return children, ignore extra props for now
  const body = props.length > 0
    ? `  // TODO: use ${props.join(', ')}\n  return <>{children}</>`
    : `  return <>{children}</>`

  const template = [
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

  fs.mkdirSync(EXPRESSIONS_DIR, { recursive: true })
  fs.writeFileSync(filePath, template, 'utf-8')
  console.log(`[create-expression] Created ${filePath}`)
  res.json({ ok: true, componentName, file: filePath })
})

app.delete('/__source/expression/:name', (req, res) => {
  const { name } = req.params
  if (!name || !/^[A-Z][a-zA-Z0-9]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid expression name' })
  }

  const filePath = path.join(EXPRESSIONS_DIR, `${name}.tsx`)

  if (!isSafeFile(filePath)) return res.status(403).json({ error: 'Access denied' })
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File not found: ${name}.tsx` })
  }

  fs.unlinkSync(filePath)
  console.log(`[delete-expression] Deleted ${filePath}`)
  res.json({ ok: true })
})

const PORT = 3001
app.listen(PORT, () => {
  console.log(`[builder-server] Source API ready → http://localhost:${PORT}/__source`)
})
