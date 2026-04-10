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
import { execSync, spawn } from 'child_process'

import { REPO_ROOT, isSafeFile, getDiagnosticsAsync, setActiveProjectRoot, warmDiagnosticsCache, readProjectConfig, writeProjectConfig } from './utils.js'
import { extractAstInfo } from './astInfo.js'
import { buildPageTemplate, buildComponentTemplate, buildExpressionTemplate, extractExpressionProps, DEFAULT_EXPRESSIONS } from './templates.js'

const app = express()
app.use(express.json({ limit: '2mb' }))

// In-memory store of last write diff per file path.
// Maps absolute file path → { original: string, modified: string }
const fileDiffStore = new Map()

// ── Core file endpoints ───────────────────────────────────────────────────────

// Simple request timing middleware — logs path + duration for every /__source request.
app.use('/__source', (req, _res, next) => {
  req._t0 = performance.now()
  next()
})

app.use((req, res, next) => {
  if (!req.path.startsWith('/__source') && !req.path.startsWith('/__diagnostics')) return next()
  const orig = res.json.bind(res)
  const origSend = res.send.bind(res)
  const finish = (label) => {
    const ms = req._t0 != null ? (performance.now() - req._t0).toFixed(1) : '?'
    const file = (req.query?.file ?? req.body?.file ?? '').toString().replace(/.*[/\\]/, '')
    console.log(`[${ms}ms] ${req.method} ${req.path}${file ? ` file=${file}` : ''}`)
  }
  res.json = (body) => { finish('json'); return orig(body) }
  res.send = (body) => { finish('send'); return origSend(body) }
  next()
})

app.get('/__source', (req, res) => {
  const rawFile = req.query.file
  if (typeof rawFile !== 'string' || !rawFile) {
    return res.status(400).json({ error: 'Missing ?file= query parameter' })
  }

  const filePath = path.resolve(rawFile)
  const t0 = performance.now()

  if (!isSafeFile(filePath)) {
    console.warn(`[GET /__source] DENIED ${filePath}`)
    return res.status(403).json({ error: 'Access denied' })
  }

  if (!fs.existsSync(filePath)) {
    console.error(`[GET /__source] NOT FOUND ${filePath}`)
    return res.status(404).json({ error: `File not found: ${filePath}` })
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const readMs = (performance.now() - t0).toFixed(1)
  const sizeKb = (Buffer.byteLength(content, 'utf-8') / 1024).toFixed(1)
  console.log(`[GET /__source] ${readMs}ms  ${sizeKb}KB  ${filePath}`)
  res.type('text/plain').send(content)
})

app.post('/__source', (req, res) => {
  const { file: rawFile, content, agent } = req.body ?? {}

  if (typeof rawFile !== 'string' || typeof content !== 'string') {
    return res.status(400).json({ error: 'Body must contain { file: string, content: string }' })
  }

  const filePath = path.resolve(rawFile)

  if (!isSafeFile(filePath)) {
    return res.status(403).json({ error: 'Access denied' })
  }

  if (agent) {
    // Agent write: capture original and store diff so the inspector can display it.
    let original = ''
    try { original = fs.readFileSync(filePath, 'utf-8') } catch { /* new file */ }
    fs.writeFileSync(filePath, content, 'utf-8')
    if (original !== content) {
      fileDiffStore.set(filePath, { original, modified: content })
    }
  } else {
    // User-initiated write: clear any stored agent diff so it stops showing in Changes tab.
    fileDiffStore.delete(filePath)
    fs.writeFileSync(filePath, content, 'utf-8')
  }

  // Vite HMR will detect the file change automatically.
  res.json({ ok: true })
})

app.get('/__source/diff', (req, res) => {
  const rawFile = req.query.file
  if (typeof rawFile !== 'string' || !rawFile) {
    return res.status(400).json({ error: 'Missing ?file= query parameter' })
  }
  const filePath = path.resolve(rawFile)
  if (!isSafeFile(filePath)) {
    return res.status(403).json({ error: 'Access denied' })
  }
  const diff = fileDiffStore.get(filePath)
  if (!diff) {
    return res.status(404).json({ error: 'No diff stored for this file' })
  }
  res.json(diff)
})

app.delete('/__source/diff', (req, res) => {
  const rawFile = req.query.file
  if (typeof rawFile !== 'string' || !rawFile) {
    return res.status(400).json({ error: 'Missing ?file= query parameter' })
  }
  const filePath = path.resolve(rawFile)
  if (!isSafeFile(filePath)) {
    return res.status(403).json({ error: 'Access denied' })
  }
  fileDiffStore.delete(filePath)
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

  const { pagesDir, componentsDir, expressionsDir } = getProjectDirs(resolved)

  const hasPages = fs.existsSync(pagesDir)
  const hasComponents = fs.existsSync(componentsDir)
  const hasExpressions = fs.existsSync(expressionsDir)
  const hasConfig = fs.existsSync(path.join(resolved, '.cockpit', 'config.json'))

  const pkgPath = path.join(resolved, 'package.json')
  const hasPackageJson = fs.existsSync(pkgPath)
  let isReactProject = false
  if (hasPackageJson) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
      isReactProject = 'react' in allDeps || 'next' in allDeps
    } catch { /* ignore malformed package.json */ }
  }

  res.json({
    name: path.basename(resolved),
    root: resolved,
    pagesDir: hasPages ? pagesDir.replace(/\\/g, '/') : null,
    componentsDir: hasComponents ? componentsDir.replace(/\\/g, '/') : null,
    expressionsDir: hasExpressions ? expressionsDir.replace(/\\/g, '/') : null,
    hasSrc: fs.existsSync(path.join(resolved, 'src')),
    hasConfig,
    hasPackageJson,
    isReactProject,
    valid: hasPages || hasComponents,
  })
})

/**
 * Sync a project's .cockpit/config.json settings into the monorepo-level
 * cockpit.settings.json so Vite plugins (cockpitCssInjector, cockpitAssets,
 * cockpitDynamicAlias) pick up the correct CSS files, aliases, and source
 * directories for the newly-active project.
 */
function syncProjectSettingsToGlobal(projectRoot) {
  try {
    const cfg = readProjectConfig(projectRoot)
    const dirs = getProjectDirs(projectRoot)
    const globalPath = path.resolve(REPO_ROOT, 'cockpit.settings.json')
    let globalSettings = {}
    try {
      if (fs.existsSync(globalPath)) {
        globalSettings = JSON.parse(fs.readFileSync(globalPath, 'utf-8'))
      }
    } catch { /* use empty defaults */ }
    const updated = {
      ...globalSettings,
      aliases: cfg.aliases ?? {},
      packages: cfg.packages ?? [],
      nodeModulesDirs: cfg.nodeModulesDirs ?? [],
      cssFiles: cfg.cssFiles ?? [],
      publicDirs: cfg.publicDirs ?? [],
      fontLinks: cfg.fontLinks ?? [],
      projectDirs: {
        [projectRoot]: {
          pagesDir: dirs.pagesDir.replace(/\\/g, '/'),
          componentsDir: dirs.componentsDir.replace(/\\/g, '/'),
        },
      },
    }
    fs.writeFileSync(globalPath, JSON.stringify(updated, null, 2), 'utf-8')
    console.log(`[syncProjectSettings] Wrote cockpit.settings.json for ${projectRoot}`)
  } catch (e) {
    console.warn(`[syncProjectSettings] Failed: ${e.message}`)
  }
}

/**
 * Detect if a project uses @subframe/core and auto-populate missing CSS files
 * and font links so Subframe components render correctly out of the box.
 *
 * Only fills in values that are not already configured — never overwrites
 * user-specified settings.
 *
 * Auto-added when @subframe/core is detected:
 *   cssFiles  — any Subframe theme CSS files found on disk (src/ui/theme.css,
 *               src/subframe/theme.css, etc.) that are not already listed.
 *   fontLinks — Inter font from Google Fonts (common Subframe default font).
 *
 * The updated config is written back to .cockpit/config.json and then synced
 * to the global cockpit.settings.json so Vite picks up the changes immediately.
 */
function autoConfigureSubframe(projectRoot) {
  let pkg = {}
  try {
    const pkgPath = path.join(projectRoot, 'package.json')
    if (fs.existsSync(pkgPath)) pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  } catch { /* ignore */ }

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
  if (!allDeps['@subframe/core']) return // not a Subframe project

  const cfg = readProjectConfig(projectRoot)

  // ── CSS files ──────────────────────────────────────────────────────────────
  // Subframe projects typically have a theme.css that is NOT imported by
  // globals.css (Next.js loads it separately). We auto-add it so the builder
  // has all @theme variables available.
  const subframeThemeCandidates = [
    'src/ui/theme.css',
    'src/subframe/theme.css',
    'src/subframe-theme.css',
    'src/subframe/styles/theme.css',
  ]

  const existingCss = new Set((cfg.cssFiles ?? []).map(f => path.resolve(f).toLowerCase()))
  const cssToAdd = []
  for (const rel of subframeThemeCandidates) {
    const abs = path.join(projectRoot, rel)
    if (fs.existsSync(abs) && !existingCss.has(abs.toLowerCase())) {
      cssToAdd.push(abs.replace(/\\/g, '/'))
    }
  }

  // ── Font links ─────────────────────────────────────────────────────────────
  // Inter is the default Subframe font. Add it only if no font links are set.
  const INTER_FONT_URL = 'https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap'
  const existingFonts = cfg.fontLinks ?? []
  const fontsToAdd = existingFonts.length === 0 ? [INTER_FONT_URL] : []

  if (cssToAdd.length === 0 && fontsToAdd.length === 0) return // nothing to do

  const updatedCfg = {
    ...cfg,
    cssFiles: [...(cfg.cssFiles ?? []), ...cssToAdd],
    fontLinks: [...existingFonts, ...fontsToAdd],
  }
  writeProjectConfig(projectRoot, updatedCfg)
  console.log(`[autoConfigureSubframe] Added ${cssToAdd.length} CSS file(s) and ${fontsToAdd.length} font link(s) for ${projectRoot}`)
}

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
  // Auto-configure Subframe-specific CSS and font links if not already set.
  autoConfigureSubframe(resolved)
  // Sync per-project config (CSS files, aliases, etc.) into cockpit.settings.json
  // so that Vite plugins pick up the correct settings for this project.
  syncProjectSettingsToGlobal(resolved)
  // Pre-warm the TypeScript program cache in the background so the first
  // diagnostics request hits the warm cache instead of cold-starting (~2-6s).
  warmDiagnosticsCache(resolved)
  res.json({ ok: true })
})

// ── Pages ─────────────────────────────────────────────────────────────────────

/**
 * Recursively walk a directory and return all .tsx files.
 * Returns { name, relPath, filePath } where:
 *   name    = filename without .tsx  (used as export name)
 *   relPath = relative path from baseDir without .tsx (used for URL construction)
 *   filePath = absolute path
 */
function walkTsx(baseDir) {
  const results = []
  function walk(dir, relDir) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relDir ? `${relDir}/${entry.name}` : entry.name)
      } else if (entry.name.endsWith('.tsx')) {
        const name = entry.name.replace(/\.tsx$/, '')
        const relPath = relDir ? `${relDir}/${name}` : name
        results.push({ name, relPath, filePath: path.join(dir, entry.name) })
      }
    }
  }
  walk(baseDir, '')
  return results
}

app.get('/__source/list-pages', (req, res) => {
  const projectRoot = getProjectRoot(req)
  const loginAppPages = getProjectDirs(projectRoot).pagesDir
  console.log(`[list-pages] projectRoot=${projectRoot} pagesDir=${loginAppPages} exists=${fs.existsSync(loginAppPages)}`)
  if (!fs.existsSync(loginAppPages)) {
    console.log(`[list-pages] pagesDir not found, returning empty`)
    return res.json({ pages: [] })
  }

  const files = walkTsx(loginAppPages)
  console.log(`[list-pages] walkTsx found ${files.length} file(s):`, files.map(f => f.relPath))
  const pages = files
    .map(({ name, relPath }) => {
      // Derive label from the filename: strip trailing "Page", prettify camelCase
      const baseName = name.endsWith('Page') ? name.slice(0, -4) : name
      const label = (relPath.includes('/')
        ? relPath.split('/').slice(0, -1).join(' / ') + ' / ' + baseName
        : baseName
      ).replace(/([A-Z])/g, ' $1').trim()
      const id = relPath.toLowerCase().replace(/\//g, '-').replace(/\s+/g, '-')
      return { id, label, root: name, file: relPath }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  console.log(`[list-pages] returning ${pages.length} page(s):`, pages.map(p => p.id))
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

  const loginAppPages = getProjectDirs(getProjectRoot(req)).pagesDir
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

  const loginAppPages = getProjectDirs(getProjectRoot(req)).pagesDir
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
  const dir = getProjectDirs(getProjectRoot(req)).componentsDir
  if (!fs.existsSync(dir)) return res.json({ components: [] })

  const files = walkTsx(dir)
  const components = files
    .map(({ name, relPath }) => {
      const label = (relPath.includes('/')
        ? relPath.split('/').slice(0, -1).join(' / ') + ' / ' + name
        : name
      ).replace(/([A-Z])/g, ' $1').trim()
      const id = relPath.toLowerCase().replace(/\//g, '-').replace(/\s+/g, '-')
      return { id, label, name, file: relPath }
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
  const dir = getProjectDirs(getProjectRoot(req)).componentsDir
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
  const dir = getProjectDirs(getProjectRoot(req)).componentsDir
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

app.post('/__diagnostics', async (req, res) => {
  const { file: rawFile, content } = req.body ?? {}
  if (typeof rawFile !== 'string' || !rawFile) {
    return res.status(400).json({ error: 'Body must contain { file: string, content?: string }' })
  }

  const filePath = path.resolve(rawFile)
  if (!isSafeFile(filePath)) {
    return res.status(403).json({ error: 'Access denied' })
  }

  const t0 = performance.now()
  const { diagnostics, error } = await getDiagnosticsAsync(filePath, typeof content === 'string' ? content : undefined)
  console.log(`[POST /__diagnostics] ${(performance.now() - t0).toFixed(1)}ms  ${diagnostics.length} diagnostics  ${filePath}`)
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

  const t0 = performance.now()
  const source = fs.readFileSync(filePath, 'utf-8')
  const info = extractAstInfo(source, filePath)
  console.log(`[GET /__source/ast-info] ${(performance.now() - t0).toFixed(1)}ms  ${filePath}`)
  res.json(info)
})

// ── Expressions ───────────────────────────────────────────────────────────────

app.get('/__source/list-expressions', (req, res) => {
  const EXPRESSIONS_DIR = getProjectDirs(getProjectRoot(req)).expressionsDir
  if (!fs.existsSync(EXPRESSIONS_DIR)) return res.json({ expressions: [] })

  const files = walkTsx(EXPRESSIONS_DIR)
  const expressions = files.map(({ name, filePath }) => {
    const source = fs.readFileSync(filePath, 'utf-8')
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

  const EXPRESSIONS_DIR = getProjectDirs(getProjectRoot(req)).expressionsDir
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

app.post('/__source/add-default-expressions', (req, res) => {
  const EXPRESSIONS_DIR = getProjectDirs(getProjectRoot(req)).expressionsDir
  if (!isSafeFile(EXPRESSIONS_DIR)) return res.status(403).json({ error: 'Access denied' })
  fs.mkdirSync(EXPRESSIONS_DIR, { recursive: true })
  const results = {}
  for (const [name, content] of Object.entries(DEFAULT_EXPRESSIONS)) {
    const filePath = path.join(EXPRESSIONS_DIR, `${name}.tsx`)
    if (!isSafeFile(filePath)) { results[name] = 'denied'; continue }
    if (fs.existsSync(filePath)) { results[name] = 'exists'; continue }
    fs.writeFileSync(filePath, content, 'utf-8')
    console.log(`[add-default-expressions] Created ${filePath}`)
    results[name] = 'created'
  }
  res.json({ ok: true, results })
})

app.delete('/__source/expression/:name', (req, res) => {
  const { name } = req.params
  if (!name || !/^[A-Z][a-zA-Z0-9]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid expression name' })
  }

  const EXPRESSIONS_DIR = getProjectDirs(getProjectRoot(req)).expressionsDir
  const filePath = path.join(EXPRESSIONS_DIR, `${name}.tsx`)

  if (!isSafeFile(filePath)) return res.status(403).json({ error: 'Access denied' })
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File not found: ${name}.tsx` })
  }

  fs.unlinkSync(filePath)
  console.log(`[delete-expression] Deleted ${filePath}`)
  res.json({ ok: true })
})

// ── Settings ──────────────────────────────────────────────────────────────────

/**
 * Resolve pages/components/expressions directories for a project root.
 * Relative paths (e.g. "src/pages") are resolved against the project root.
 * Absolute override paths are used as-is.
 */
function getProjectDirs(projectRootArg) {
  const resolved = path.resolve(projectRootArg)
  const cfg = readProjectConfig(resolved)
  return {
    pagesDir: cfg.pagesDir
      ? (path.isAbsolute(cfg.pagesDir) ? cfg.pagesDir : path.join(resolved, cfg.pagesDir))
      : path.join(resolved, 'src', 'pages'),
    componentsDir: cfg.componentsDir
      ? (path.isAbsolute(cfg.componentsDir) ? cfg.componentsDir : path.join(resolved, cfg.componentsDir))
      : path.join(resolved, 'src', 'components'),
    expressionsDir: cfg.expressionsDir
      ? (path.isAbsolute(cfg.expressionsDir) ? cfg.expressionsDir : path.join(resolved, cfg.expressionsDir))
      : path.join(resolved, 'src', 'expressions'),
  }
}

app.get('/__source/settings', (req, res) => {
  const root = req.query.root
  if (!root) return res.status(400).json({ error: 'Missing ?root= query parameter' })
  const resolved = path.resolve(root)
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Project root not found' })
  res.json(readProjectConfig(resolved))
})

app.get('/__source/project-deps', (req, res) => {
  const root = req.query.root
  if (!root) return res.status(400).json({ error: 'Missing ?root= query parameter' })
  const pkgPath = path.join(path.resolve(root), 'package.json')
  if (!fs.existsSync(pkgPath)) return res.json({ deps: [] })
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    }
    res.json({ deps: Object.keys(allDeps) })
  } catch (e) {
    res.status(400).json({ error: `Failed to read package.json: ${e.message}` })
  }
})

app.get('/__source/project-deps-full', (req, res) => {
  const root = req.query.root
  if (!root) return res.status(400).json({ error: 'Missing ?root= query parameter' })
  const pkgPath = path.join(path.resolve(root), 'package.json')
  if (!fs.existsSync(pkgPath)) return res.json({ dependencies: {}, devDependencies: {} })
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    res.json({
      dependencies: pkg.dependencies ?? {},
      devDependencies: pkg.devDependencies ?? {},
    })
  } catch (e) {
    res.status(400).json({ error: `Failed to read package.json: ${e.message}` })
  }
})

app.post('/__source/install-project-package', (req, res) => {
  const { packageName, root, dev = true } = req.body ?? {}
  if (typeof packageName !== 'string' || !/^[@a-zA-Z0-9_\-./]+(@[^\s]+)?$/.test(packageName)) {
    return res.status(400).json({ error: 'Invalid package name' })
  }
  const resolved = path.resolve(root ?? '')
  if (!root || !isSafeFile(resolved) || !fs.existsSync(resolved)) {
    return res.status(400).json({ error: 'Invalid or missing project root' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  function send(type, data) {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`)
  }

  const flag = dev ? '--save-dev' : '--save'
  send('start', `Installing ${packageName}…\n`)

  const child = spawn('npm', ['install', flag, packageName], {
    cwd: resolved,
    shell: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  })

  child.stdout.on('data', (chunk) => send('stdout', chunk.toString()))
  child.stderr.on('data', (chunk) => send('stderr', chunk.toString()))

  child.on('close', (code) => {
    if (code === 0) {
      send('done', `\n✓ ${packageName} installed successfully.`)
    } else {
      send('error', `\n✗ Install failed (exit code ${code}).`)
    }
    res.end()
  })

  child.on('error', (err) => {
    send('error', `\n✗ ${err.message}`)
    res.end()
  })
})

app.post('/__source/settings', (req, res) => {
  const { root: rawRoot, aliases, packages, nodeModulesDirs, cssFiles, publicDirs, fontLinks,
          pagesDir, componentsDir, expressionsDir } = req.body ?? {}
  if (!rawRoot || typeof rawRoot !== 'string') {
    return res.status(400).json({ error: 'Body must contain { root: string }' })
  }
  if (typeof aliases !== 'object' || aliases === null || Array.isArray(aliases)) {
    return res.status(400).json({ error: 'Body must contain { aliases: object }' })
  }
  for (const [k, v] of Object.entries(aliases)) {
    if (typeof k !== 'string' || typeof v !== 'string') {
      return res.status(400).json({ error: 'Alias keys and values must be strings' })
    }
  }
  const resolved = path.resolve(rawRoot)
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Project root not found' })
  // Preserve the existing config name
  const existing = readProjectConfig(resolved)
  writeProjectConfig(resolved, {
    name: existing.name,
    pagesDir: typeof pagesDir === 'string' ? pagesDir : existing.pagesDir,
    componentsDir: typeof componentsDir === 'string' ? componentsDir : existing.componentsDir,
    expressionsDir: typeof expressionsDir === 'string' ? expressionsDir : existing.expressionsDir,
    aliases,
    packages: Array.isArray(packages) ? packages : [],
    nodeModulesDirs: Array.isArray(nodeModulesDirs) ? nodeModulesDirs : [],
    cssFiles: Array.isArray(cssFiles) ? cssFiles.filter(f => typeof f === 'string' && f.trim()) : [],
    publicDirs: Array.isArray(publicDirs) ? publicDirs.filter(f => typeof f === 'string' && f.trim()) : [],
    fontLinks: Array.isArray(fontLinks) ? fontLinks.filter(f => typeof f === 'string' && f.trim()) : [],
  })
  // Also sync the active project's settings into cockpit.settings.json so Vite
  // plugins (CSS injector, asset server, alias resolver) pick up changes immediately
  // without requiring a server restart.
  syncProjectSettingsToGlobal(resolved)
  res.json({ ok: true })
})

/** Create a brand-new project directory with a .cockpit/config.json. */
app.post('/__source/create-project', (req, res) => {
  const { name, location, pagesDir = '', componentsDir = '', expressionsDir = '' } = req.body ?? {}
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Body must contain { name: string }' })
  }
  if (!/^[a-zA-Z0-9_\-. ]+$/.test(name)) {
    return res.status(400).json({ error: 'Project name contains invalid characters' })
  }
  if (typeof location !== 'string' || !location.trim()) {
    return res.status(400).json({ error: 'Body must contain { location: string }' })
  }
  const parentDir = path.resolve(location)
  if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
    return res.status(400).json({ error: 'Location does not exist or is not a directory' })
  }
  // Prevent path traversal in name
  const safeName = path.basename(name.trim())
  const newRoot = path.join(parentDir, safeName)
  if (fs.existsSync(newRoot)) {
    return res.status(409).json({ error: `Directory already exists: ${newRoot}` })
  }
  fs.mkdirSync(newRoot, { recursive: true })
  writeProjectConfig(newRoot, {
    name: safeName,
    pagesDir: typeof pagesDir === 'string' ? pagesDir : '',
    componentsDir: typeof componentsDir === 'string' ? componentsDir : '',
    expressionsDir: typeof expressionsDir === 'string' ? expressionsDir : '',
    aliases: {},
    packages: [],
    nodeModulesDirs: [],
    cssFiles: [],
    publicDirs: [],
    fontLinks: [],
  })
  setActiveProjectRoot(newRoot)
  console.log(`[create-project] Created ${newRoot}`)
  res.json({ ok: true, root: newRoot.replace(/\\/g, '/') })
})

/** Initialise an existing directory as a Cockpit project (creates .cockpit/config.json). */
app.post('/__source/init-project', (req, res) => {
  const { root: rawRoot, name, pagesDir = '', componentsDir = '', expressionsDir = '' } = req.body ?? {}
  if (!rawRoot || typeof rawRoot !== 'string') {
    return res.status(400).json({ error: 'Body must contain { root: string }' })
  }
  const resolved = path.resolve(rawRoot)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return res.status(404).json({ error: 'Directory not found' })
  }
  const configPath = path.join(resolved, '.cockpit', 'config.json')
  if (fs.existsSync(configPath)) {
    return res.status(409).json({ error: '.cockpit/config.json already exists' })
  }
  writeProjectConfig(resolved, {
    name: (typeof name === 'string' && name.trim()) ? name.trim() : path.basename(resolved),
    pagesDir: typeof pagesDir === 'string' ? pagesDir : '',
    componentsDir: typeof componentsDir === 'string' ? componentsDir : '',
    expressionsDir: typeof expressionsDir === 'string' ? expressionsDir : '',
    aliases: {},
    packages: [],
    nodeModulesDirs: [],
    cssFiles: [],
    publicDirs: [],
    fontLinks: [],
  })
  setActiveProjectRoot(resolved)
  console.log(`[init-project] Initialised ${resolved}`)
  res.json({ ok: true })
})

function stripJsoncComments(str) {
  let result = ''
  let i = 0
  while (i < str.length) {
    // String literal — copy verbatim including escaped quotes
    if (str[i] === '"') {
      result += str[i++]
      while (i < str.length) {
        if (str[i] === '\\') { result += str[i] + str[i + 1]; i += 2 }
        else if (str[i] === '"') { result += str[i++]; break }
        else { result += str[i++] }
      }
    // Block comment — skip
    } else if (str[i] === '/' && str[i + 1] === '*') {
      i += 2
      while (i < str.length && !(str[i] === '*' && str[i + 1] === '/')) i++
      i += 2
    // Line comment — skip to end of line
    } else if (str[i] === '/' && str[i + 1] === '/') {
      while (i < str.length && str[i] !== '\n') i++
    } else {
      result += str[i++]
    }
  }
  // Remove trailing commas before } or ]
  return result.replace(/,(\s*[}\]])/g, '$1')
}

app.get('/__source/detect-css', (req, res) => {
  const root = req.query.root
  if (!root) return res.status(400).json({ error: 'Missing ?root= query parameter' })
  const projectRoot = path.resolve(root)
  if (!fs.existsSync(projectRoot)) return res.status(404).json({ error: 'Project root not found' })

  // Common CSS entry-point patterns, ordered by precedence.
  const candidates = [
    'src/styles/globals.css',
    'src/styles/global.css',
    'src/app/globals.css',
    'src/app/global.css',
    'src/index.css',
    'src/main.css',
    'src/style.css',
    'src/styles.css',
    'app/globals.css',
    'styles/globals.css',
    'styles/global.css',
    'styles/index.css',
    // Subframe-specific theme CSS locations
    'src/ui/theme.css',
    'src/subframe/theme.css',
    'src/subframe-theme.css',
    'src/subframe/styles/theme.css',
  ]

  // Also scan src/styles/, src/, src/ui/, src/subframe/, and styles/ for any
  // .css files not already in candidates.
  const extraDirs = ['src/styles', 'src', 'src/ui', 'src/subframe', 'styles']
  const found = []
  const foundSet = new Set()

  for (const rel of candidates) {
    const abs = path.join(projectRoot, rel)
    if (fs.existsSync(abs)) {
      const normalised = abs.replace(/\\/g, '/')
      if (!foundSet.has(normalised)) { found.push(normalised); foundSet.add(normalised) }
    }
  }

  for (const dir of extraDirs) {
    const absDir = path.join(projectRoot, dir)
    if (!fs.existsSync(absDir)) continue
    let entries
    try { entries = fs.readdirSync(absDir) } catch { continue }
    for (const name of entries) {
      if (!name.endsWith('.css')) continue
      const abs = path.join(absDir, name)
      const normalised = abs.replace(/\\/g, '/')
      if (!foundSet.has(normalised)) { found.push(normalised); foundSet.add(normalised) }
    }
  }

  res.json({ cssFiles: found })
})

app.get('/__source/tsconfig-paths', (req, res) => {
  const root = req.query.root
  if (!root) return res.status(400).json({ error: 'Missing ?root= query parameter' })

  const tsconfigPath = path.join(path.resolve(root), 'tsconfig.json')
  const projectRoot = path.resolve(root)

  // Always include the project's node_modules as a resolution source
  const projectNodeModules = path.join(projectRoot, 'node_modules').replace(/\\/g, '/')
  const hasNodeModules = fs.existsSync(path.join(projectRoot, 'node_modules'))

  if (!fs.existsSync(tsconfigPath)) {
    return res.json({ aliases: {}, nodeModulesDir: hasNodeModules ? projectNodeModules : null })
  }

  try {
    const raw = fs.readFileSync(tsconfigPath, 'utf-8')
    const tsconfig = JSON.parse(stripJsoncComments(raw))
    const pathsMap = tsconfig.compilerOptions?.paths ?? {}
    const baseUrl = tsconfig.compilerOptions?.baseUrl ?? '.'

    const aliases = {}
    for (const [pattern, targets] of Object.entries(pathsMap)) {
      if (!Array.isArray(targets) || !targets[0]) continue
      const aliasKey = pattern.replace(/\/\*$/, '')
      const targetPath = targets[0].replace(/\/\*$/, '')
      aliases[aliasKey] = path.resolve(projectRoot, baseUrl, targetPath).replace(/\\/g, '/')
    }
    res.json({ aliases, nodeModulesDir: hasNodeModules ? projectNodeModules : null })
  } catch (e) {
    res.status(400).json({ error: `Failed to parse tsconfig.json: ${e.message}` })
  }
})

// Scan a source file's direct imports and return which package names can't be
// found in any configured nodeModulesDirs (or the project's own node_modules).
app.get('/__source/check-imports', (req, res) => {
  const filePath = req.query.file
  if (!filePath || !isSafeFile(filePath)) return res.status(400).json({ error: 'Invalid file' })
  if (!fs.existsSync(filePath)) return res.json({ missing: [] })

  // Read configured nodeModulesDirs and aliases from the project config.
  let nodeModulesDirs = []
  let aliases = {}
  try {
    // Walk up from the file to find a .cockpit/config.json
    let dir = path.dirname(path.resolve(filePath))
    let cfg = null
    for (let i = 0; i < 15 && !cfg; i++) {
      const candidate = path.join(dir, '.cockpit', 'config.json')
      if (fs.existsSync(candidate)) { cfg = JSON.parse(fs.readFileSync(candidate, 'utf-8')); break }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    if (cfg) {
      nodeModulesDirs = Array.isArray(cfg.nodeModulesDirs) ? cfg.nodeModulesDirs : []
      aliases = (cfg.aliases && typeof cfg.aliases === 'object') ? cfg.aliases : {}
    }
  } catch {}

  // Also walk up the directory tree from the file to find any node_modules folders.
  let dir = path.dirname(path.resolve(filePath))
  for (let i = 0; i < 10; i++) {
    const nm = path.join(dir, 'node_modules')
    if (fs.existsSync(nm) && !nodeModulesDirs.includes(nm)) nodeModulesDirs.push(nm)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const source = fs.readFileSync(filePath, 'utf-8')

  // Extract all import specifiers from the file.
  const specifiers = new Set()
  const importRe = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let m
  while ((m = importRe.exec(source)) !== null) specifiers.add(m[1] ?? m[2])

  const NODE_BUILTINS = new Set(['fs', 'path', 'http', 'https', 'crypto', 'util', 'events',
    'stream', 'os', 'net', 'url', 'assert', 'zlib', 'buffer', 'child_process', 'cluster',
    'dns', 'domain', 'module', 'punycode', 'querystring', 'readline', 'repl',
    'string_decoder', 'tls', 'tty', 'v8', 'vm', 'worker_threads'])

  const missing = []
  for (const spec of specifiers) {
    if (!spec) continue
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.startsWith('virtual:')) continue
    // Skip if the specifier matches a configured alias prefix
    const isAlias = Object.keys(aliases).some(alias => spec === alias || spec.startsWith(alias + '/'))
    if (isAlias) continue
    const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (!pkgName || NODE_BUILTINS.has(pkgName)) continue
    const found = nodeModulesDirs.length > 0 && nodeModulesDirs.some(nm => fs.existsSync(path.join(nm, pkgName)))
    if (!found) missing.push(pkgName)
  }

  res.json({ missing: [...new Set(missing)] })
})

app.post('/__source/install-package', (req, res) => {
  const { packageName } = req.body ?? {}
  if (typeof packageName !== 'string' || !/^[@a-zA-Z0-9_\-./]+$/.test(packageName)) {
    return res.status(400).json({ error: 'Invalid package name' })
  }

  const builderDir = path.resolve(REPO_ROOT, 'builder-app')

  // Server-Sent Events stream so the client sees live output
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  function send(type, data) {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`)
  }

  send('start', `Installing ${packageName}…\n`)

  const child = spawn('npm', ['install', '--save-dev', packageName], {
    cwd: builderDir,
    shell: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  })

  child.stdout.on('data', (chunk) => send('stdout', chunk.toString()))
  child.stderr.on('data', (chunk) => send('stderr', chunk.toString()))

  child.on('close', (code) => {
    if (code === 0) {
      send('done', `\n✓ ${packageName} installed successfully.`)
    } else {
      send('error', `\n✗ Install failed (exit code ${code}).`)
    }
    res.end()
  })

  child.on('error', (err) => {
    send('error', `\n✗ ${err.message}`)
    res.end()
  })
})

// ── Start server ──────────────────────────────────────────────────────────────

const PORT = 3001
app.listen(PORT, () => {
  console.log(`[builder-server] Source API ready → http://localhost:${PORT}/__source`)
})
