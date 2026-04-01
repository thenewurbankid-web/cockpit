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

import { REPO_ROOT, isSafeFile, getDiagnosticsForFile, setActiveProjectRoot } from './utils.js'
import { extractAstInfo } from './astInfo.js'
import { buildPageTemplate, buildComponentTemplate, buildExpressionTemplate, extractExpressionProps } from './templates.js'

const app = express()
app.use(express.json({ limit: '2mb' }))

// ── Core file endpoints ───────────────────────────────────────────────────────

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

// ── Project selection ─────────────────────────────────────────────────────────

/**
 * Resolve the target project root from a request.
 * Accepts ?projectRoot= (GET/DELETE) or body.projectRoot (POST).
 * Falls back to login-app inside the monorepo to preserve backwards compatibility.
 */
function getProjectRoot(req) {
  const raw = req.query.projectRoot || req.body?.projectRoot
  if (raw) return path.resolve(raw)
  return path.resolve(REPO_ROOT, 'login-app')
}

/** Browse directory contents (directories only). No isSafeFile restriction — this is for navigation. */
app.get('/__source/browse', (req, res) => {
  let targetPath = req.query.path
  if (!targetPath) {
    targetPath = path.resolve(REPO_ROOT, '..')
  }
  const resolved = path.resolve(targetPath)

  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'Path not found' })
  }
  const stat = fs.statSync(resolved)
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: 'Not a directory' })
  }

  let entries = []
  try {
    entries = fs.readdirSync(resolved)
      .map((name) => {
        const full = path.join(resolved, name)
        try { return { name, isDir: fs.statSync(full).isDirectory() } } catch { return null }
      })
      .filter(Boolean)
      .filter((e) => e.isDir && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return res.status(403).json({ error: 'Cannot read directory' })
  }

  const parent = path.dirname(resolved)
  res.json({
    path: resolved,
    parent: parent !== resolved ? parent : null,
    entries,
  })
})

/** Probe a directory to determine if it's a valid Cockpit project. Returns dirs for all found subdirs. */
app.get('/__source/project-info', (req, res) => {
  const root = req.query.root
  if (!root) return res.status(400).json({ error: 'Missing ?root= query parameter' })

  const resolved = path.resolve(root)
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'Path not found' })
  }

  const pagesDir = path.join(resolved, 'src', 'pages')
  const componentsDir = path.join(resolved, 'src', 'components')
  const expressionsDir = path.join(resolved, 'src', 'expressions')

  const hasPages = fs.existsSync(pagesDir)
  const hasComponents = fs.existsSync(componentsDir)
  const hasExpressions = fs.existsSync(expressionsDir)

  res.json({
    name: path.basename(resolved),
    root: resolved,
    pagesDir: hasPages ? pagesDir.replace(/\\/g, '/') : null,
    componentsDir: hasComponents ? componentsDir.replace(/\\/g, '/') : null,
    expressionsDir: hasExpressions ? expressionsDir.replace(/\\/g, '/') : null,
    hasSrc: fs.existsSync(path.join(resolved, 'src')),
    valid: hasPages || hasComponents,
  })
})

/** Set the active project root so isSafeFile allows files within it. */
app.post('/__source/set-active-project', (req, res) => {
  const { root } = req.body ?? {}
  if (!root || typeof root !== 'string') {
    return res.status(400).json({ error: 'Body must contain { root: string }' })
  }
  const resolved = path.resolve(root)
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'Path not found' })
  }
  setActiveProjectRoot(resolved)
  console.log(`[set-active-project] ${resolved}`)
  res.json({ ok: true })
})

// ── Pages ─────────────────────────────────────────────────────────────────────

app.get('/__source/list-pages', (req, res) => {
  const loginAppPages = path.resolve(getProjectRoot(req), 'src/pages')
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

  const loginAppPages = path.resolve(getProjectRoot(req), 'src/pages')
  const filePath = path.join(loginAppPages, `${componentName}.tsx`)

  if (!isSafeFile(filePath)) {
    return res.status(403).json({ error: 'Access denied' })
  }
  if (fs.existsSync(filePath)) {
    return res.status(409).json({ error: `File already exists: ${componentName}.tsx` })
  }

  const template = buildPageTemplate(componentName, trimmed)

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

  const loginAppPages = path.resolve(getProjectRoot(req), 'src/pages')
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

// ── Components ────────────────────────────────────────────────────────────────

app.get('/__source/list-components', (req, res) => {
  const dir = path.resolve(getProjectRoot(req), 'src/components')
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
  const dir = path.resolve(getProjectRoot(req), 'src/components')
  const filePath = path.join(dir, `${componentName}.tsx`)

  if (!isSafeFile(filePath)) return res.status(403).json({ error: 'Access denied' })
  if (fs.existsSync(filePath)) {
    return res.status(409).json({ error: `File already exists: ${componentName}.tsx` })
  }

  const template = buildComponentTemplate(componentName, trimmed)

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
  const dir = path.resolve(getProjectRoot(req), 'src/components')
  const filePath = path.join(dir, `${componentName}.tsx`)

  if (!isSafeFile(filePath)) return res.status(403).json({ error: 'Access denied' })
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File not found: ${componentName}.tsx` })
  }
  fs.unlinkSync(filePath)
  console.log(`[delete-component] Deleted ${filePath}`)
  res.json({ ok: true })
})

// ── Diagnostics ───────────────────────────────────────────────────────────────

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

// ── AST info ──────────────────────────────────────────────────────────────────

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

// ── Expressions ───────────────────────────────────────────────────────────────

app.get('/__source/list-expressions', (req, res) => {
  const EXPRESSIONS_DIR = path.resolve(getProjectRoot(req), 'src/expressions')
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

  const EXPRESSIONS_DIR = path.resolve(getProjectRoot(req), 'src/expressions')
  const filePath = path.join(EXPRESSIONS_DIR, `${componentName}.tsx`)

  if (!isSafeFile(filePath)) return res.status(403).json({ error: 'Access denied' })
  if (fs.existsSync(filePath)) {
    return res.status(409).json({ error: `File already exists: ${componentName}.tsx` })
  }

  // Validate and sanitise prop names
  const props = Array.isArray(rawProps)
    ? rawProps.filter((p) => typeof p === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p) && p !== 'children')
    : []

  const template = buildExpressionTemplate(componentName, props)

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

  const EXPRESSIONS_DIR = path.resolve(getProjectRoot(req), 'src/expressions')
  const filePath = path.join(EXPRESSIONS_DIR, `${name}.tsx`)

  if (!isSafeFile(filePath)) return res.status(403).json({ error: 'Access denied' })
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File not found: ${name}.tsx` })
  }

  fs.unlinkSync(filePath)
  console.log(`[delete-expression] Deleted ${filePath}`)
  res.json({ ok: true })
})

// ── Start server ──────────────────────────────────────────────────────────────

const PORT = 3001
app.listen(PORT, () => {
  console.log(`[builder-server] Source API ready → http://localhost:${PORT}/__source`)
})
