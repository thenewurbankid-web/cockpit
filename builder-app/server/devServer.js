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

const PORT = 3001
app.listen(PORT, () => {
  console.log(`[builder-server] Source API ready → http://localhost:${PORT}/__source`)
})
