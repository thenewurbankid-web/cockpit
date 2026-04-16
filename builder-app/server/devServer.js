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
import http from 'http'
import { execSync, spawn } from 'child_process'
import { WebSocketServer } from 'ws'
import pty from 'node-pty'

import { REPO_ROOT, isSafeFile, getDiagnosticsAsync, activeProjectRoot, setActiveProjectRoot, warmDiagnosticsCache, warmOpenFiles, readProjectConfig, writeProjectConfig } from './utils.js'
import { extractAstInfo } from './astInfo.js'
import { buildPageTemplate, buildLayoutTemplate, buildComponentTemplate, buildExpressionTemplate, extractExpressionProps, DEFAULT_EXPRESSIONS, buildControllerTemplate, buildNextRoutePageTemplate, buildNextRouteLayoutTemplate } from './templates.js'

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
 * Falls back to the active project root set via set-active-project, or null if none.
 */
function getProjectRoot(req) {
  const raw = req.query.projectRoot || req.body?.projectRoot
  if (raw) return path.resolve(raw)
  return activeProjectRoot ?? null
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

  // Eagerly open the project's page, component, and expression source files so
  // tsserver loads the full project graph now rather than on the first edit.
  setImmediate(() => {
    try {
      const cfg = readProjectConfig(resolved)
      const dirs = [cfg.pagesDir, cfg.componentsDir, cfg.expressionsDir].filter(Boolean)
      const tsxFiles = []
      for (const dir of dirs) {
        const abs = path.isAbsolute(dir) ? dir : path.join(resolved, dir)
        if (!fs.existsSync(abs)) continue
        ;(function walk(d) {
          let entries
          try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
          for (const e of entries) {
            if (e.isDirectory()) walk(path.join(d, e.name))
            else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) {
              tsxFiles.push(path.join(d, e.name))
            }
          }
        })(abs)
      }
      if (tsxFiles.length > 0) {
        warmOpenFiles(resolved, tsxFiles)
        console.log(`[set-active-project] warm-opened ${tsxFiles.length} file(s)`)
      }
    } catch (e) {
      console.warn(`[set-active-project] warmOpen scan failed: ${e.message}`)
    }
  })

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
  console.log(`[list-pages] projectRoot=${projectRoot} pagesDir=${loginAppPages} exists=${loginAppPages ? fs.existsSync(loginAppPages) : false}`)
  if (!loginAppPages || !fs.existsSync(loginAppPages)) {
    console.log(`[list-pages] pagesDir not found, returning empty`)
    return res.json({ pages: [] })
  }

  let pageDirEntries
  try { pageDirEntries = fs.readdirSync(loginAppPages, { withFileTypes: true }) } catch { return res.json({ pages: [] }) }
  const pages = pageDirEntries
    .filter(e => e.isDirectory() && fs.existsSync(path.join(loginAppPages, e.name, 'page.tsx')))
    .map(e => {
      const dirName = e.name  // e.g. "SignInPage"
      const filePath = path.join(loginAppPages, dirName, 'page.tsx')
      // Extract the actual exported component name from the file AST
      let componentName = dirName
      try {
        const source = fs.readFileSync(filePath, 'utf-8')
        const info = extractAstInfo(source, filePath)
        if (info.components.length > 0) componentName = info.components[0].name
      } catch { /* fall back to dirName */ }
      const baseName = dirName.endsWith('Page') ? dirName.slice(0, -4) : dirName
      const label = baseName.replace(/([A-Z])/g, ' $1').trim()
      const id = dirName
      return { id, label, root: componentName, file: `${dirName}/page` }
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
  if (!loginAppPages) return res.status(400).json({ error: 'No active project set' })
  const pageDir = path.join(loginAppPages, componentName)
  const filePath = path.join(pageDir, 'page.tsx')

  if (!isSafeFile(filePath)) {
    return res.status(403).json({ error: 'Access denied' })
  }
  if (fs.existsSync(filePath)) {
    return res.status(409).json({ error: `File already exists: ${componentName}/page.tsx` })
  }

  const template = buildPageTemplate(componentName, trimmed)

  fs.mkdirSync(pageDir, { recursive: true })
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
  if (!loginAppPages) return res.status(400).json({ error: 'No active project set' })
  const pageDir = path.join(loginAppPages, componentName)
  const filePath = path.join(pageDir, 'page.tsx')

  if (!isSafeFile(pageDir)) {
    return res.status(403).json({ error: 'Access denied' })
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File not found: ${componentName}/page.tsx` })
  }

  fs.rmSync(pageDir, { recursive: true, force: true })
  console.log(`[delete-page] Deleted ${pageDir}`)
  res.json({ ok: true })
})

// ── Components ────────────────────────────────────────────────────────────────

app.get('/__source/list-components', (req, res) => {
  const dir = getProjectDirs(getProjectRoot(req)).componentsDir
  if (!dir || !fs.existsSync(dir)) return res.json({ components: [] })

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
  if (!dir) return res.status(400).json({ error: 'No active project set' })
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
  if (!dir) return res.status(400).json({ error: 'No active project set' })
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
  if (!EXPRESSIONS_DIR || !fs.existsSync(EXPRESSIONS_DIR)) return res.json({ expressions: [] })

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
  if (!EXPRESSIONS_DIR) return res.status(400).json({ error: 'No active project set' })
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
  if (!EXPRESSIONS_DIR) return res.status(400).json({ error: 'No active project set' })
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
  if (!EXPRESSIONS_DIR) return res.status(400).json({ error: 'No active project set' })
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
  if (!projectRootArg) return { pagesDir: null, componentsDir: null, expressionsDir: null, layoutsDir: null }
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
    layoutsDir: cfg.layoutsDir
      ? (path.isAbsolute(cfg.layoutsDir) ? cfg.layoutsDir : path.join(resolved, cfg.layoutsDir))
      : path.join(resolved, 'src', 'layouts'),
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

// ── States (page state models) ────────────────────────────────────────────────

/**
 * Infer a TypeScript type string from a JSON-value string.
 * "true"/"false" → boolean, numeric → number, else → string.
 */
function inferTsType(value) {
  if (value === 'true' || value === 'false') return 'boolean'
  if (value !== '' && !isNaN(Number(value))) return 'number'
  return 'string'
}

/**
 * Generate a model.ts file content from a data object.
 * e.g. generateModelTs('SignInPage', 'error', { error: 'bad' })
 *   → "export interface SignInPageErrorState {\n  error?: string\n}\n"
 */
function generateModelTs(pageName, stateName, data) {
  const pascal = stateName.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('')
  const interfaceName = `${pageName}${pascal}State`
  const fields = Object.entries(data)
    .map(([k, v]) => `  ${k}?: ${inferTsType(String(v))}`)
    .join('\n')
  return `export interface ${interfaceName} {\n${fields}\n}\n`
}

function getPageStatesDir(projectRoot, pageName) {
  if (!projectRoot || !pageName) return null
  const { pagesDir } = getProjectDirs(projectRoot)
  if (!pagesDir) return null
  return path.join(pagesDir, pageName, 'states')
}

function getLayoutStatesDir(projectRoot, layoutName) {
  if (!projectRoot || !layoutName) return null
  const { layoutsDir } = getProjectDirs(projectRoot)
  if (!layoutsDir) return null
  return path.join(layoutsDir, layoutName, 'states')
}

/** Label from state key — e.g. "my-state" → "My State" */
function stateKeyToLabel(key) {
  return key.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ')
}

// GET /__source/list-states?projectRoot=<abs>&page=<pageName>
app.get('/__source/list-states', (req, res) => {
  const projectRoot = getProjectRoot(req)
  if (!projectRoot) return res.json({ states: [] })
  const page = req.query.page
  if (!page || typeof page !== 'string') {
    return res.status(400).json({ error: 'Missing ?page= query parameter' })
  }
  const pageDir = getPageStatesDir(projectRoot, page)
  if (!pageDir) return res.json({ states: [] })
  console.log(`[list-states] projectRoot=${projectRoot} page=${page} pageDir=${pageDir} exists=${fs.existsSync(pageDir)}`)
  if (!fs.existsSync(pageDir)) return res.json({ states: [] })

  let entries
  try {
    entries = fs.readdirSync(pageDir, { withFileTypes: true })
  } catch {
    return res.json({ states: [] })
  }
  const stateKeys = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)

  // Read optional order.json to sort states in custom order
  let order = []
  try {
    const orderFile = path.join(pageDir, 'order.json')
    if (fs.existsSync(orderFile)) order = JSON.parse(fs.readFileSync(orderFile, 'utf-8'))
  } catch { /* ignore */ }

  const ordered = [
    ...order.filter(k => stateKeys.includes(k)),
    ...stateKeys.filter(k => !order.includes(k)).sort((a, b) => a.localeCompare(b)),
  ]
  const states = ordered.map(k => ({ key: k, label: stateKeyToLabel(k) }))
  res.json({ states })
})

// POST /__source/reorder-states  body: { projectRoot, page, order: string[] }
app.post('/__source/reorder-states', (req, res) => {
  const { projectRoot, page, order } = req.body ?? {}
  if (!projectRoot || !page || !Array.isArray(order)) {
    return res.status(400).json({ error: 'Body must contain { projectRoot, page, order: string[] }' })
  }
  const statesDir = getPageStatesDir(projectRoot, page)
  if (!statesDir) return res.status(400).json({ error: 'No active project or pagesDir' })
  const orderFile = path.join(statesDir, 'order.json')
  if (!isSafeFile(orderFile)) return res.status(403).json({ error: 'Access denied' })
  fs.mkdirSync(statesDir, { recursive: true })
  fs.writeFileSync(orderFile, JSON.stringify(order, null, 2), 'utf-8')
  res.json({ ok: true })
})

// GET /__source/state-data?projectRoot=<abs>&page=<pageName>&state=<key>
app.get('/__source/state-data', (req, res) => {
  const projectRoot = getProjectRoot(req)
  if (!projectRoot) return res.json({ data: {} })
  const { page, state } = req.query
  if (!page || !state) return res.status(400).json({ error: 'Missing ?page= or ?state= query parameter' })
  const statesDir = getPageStatesDir(projectRoot, page)
  if (!statesDir) return res.json({ data: {} })
  const dataFile = path.join(statesDir, state, 'data.json')
  if (!isSafeFile(dataFile)) return res.status(403).json({ error: 'Access denied' })
  if (!fs.existsSync(dataFile)) return res.json({ data: {} })
  try {
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'))
    res.json({ data })
  } catch {
    res.json({ data: {} })
  }
})

// POST /__source/state-data  body: { projectRoot, page, state, data }
app.post('/__source/state-data', (req, res) => {
  const { projectRoot, page, state, data } = req.body ?? {}
  if (!projectRoot || !page || !state || data === undefined) {
    return res.status(400).json({ error: 'Body must contain { projectRoot, page, state, data }' })
  }
  const statesDir = getPageStatesDir(projectRoot, page)
  if (!statesDir) return res.status(400).json({ error: 'No active project or pagesDir' })
  const stateDir = path.join(statesDir, state)
  const dataFile = path.join(stateDir, 'data.json')
  const modelFile = path.join(stateDir, 'model.ts')
  if (!isSafeFile(dataFile)) return res.status(403).json({ error: 'Access denied' })
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf-8')
  fs.writeFileSync(modelFile, generateModelTs(page, state, data), 'utf-8')
  res.json({ ok: true })
})

// POST /__source/create-state  body: { projectRoot, page, stateName }
app.post('/__source/create-state', (req, res) => {
  const { projectRoot, page, stateName } = req.body ?? {}
  if (!projectRoot || !page || !stateName) {
    return res.status(400).json({ error: 'Body must contain { projectRoot, page, stateName }' })
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(stateName)) {
    return res.status(400).json({ error: 'stateName must contain only letters, numbers, hyphens, and underscores' })
  }
  const statesDir = getPageStatesDir(projectRoot, page)
  if (!statesDir) return res.status(400).json({ error: 'No active project or pagesDir' })
  const stateDir = path.join(statesDir, stateName)
  const dataFile = path.join(stateDir, 'data.json')
  if (!isSafeFile(dataFile)) return res.status(403).json({ error: 'Access denied' })
  if (fs.existsSync(stateDir)) return res.status(409).json({ error: `State "${stateName}" already exists` })
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(dataFile, '{}\n', 'utf-8')
  fs.writeFileSync(path.join(stateDir, 'model.ts'), generateModelTs(page, stateName, {}), 'utf-8')
  console.log(`[create-state] ${stateDir}`)
  res.json({ ok: true, key: stateName, label: stateKeyToLabel(stateName) })
})

// POST /__source/rename-state  body: { projectRoot, page, oldName, newName }
app.post('/__source/rename-state', (req, res) => {
  const { projectRoot, page, oldName, newName } = req.body ?? {}
  if (!projectRoot || !page || !oldName || !newName) {
    return res.status(400).json({ error: 'Body must contain { projectRoot, page, oldName, newName }' })
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(newName)) {
    return res.status(400).json({ error: 'newName must contain only letters, numbers, hyphens, and underscores' })
  }
  const statesDir = getPageStatesDir(projectRoot, page)
  if (!statesDir) return res.status(400).json({ error: 'No active project or pagesDir' })
  const oldDir = path.join(statesDir, oldName)
  const newDir = path.join(statesDir, newName)
  if (!isSafeFile(oldDir) || !isSafeFile(newDir)) return res.status(403).json({ error: 'Access denied' })
  if (!fs.existsSync(oldDir)) return res.status(404).json({ error: 'State not found' })
  if (fs.existsSync(newDir)) return res.status(409).json({ error: `State "${newName}" already exists` })
  fs.renameSync(oldDir, newDir)
  // Regenerate model.ts with new name
  try {
    const dataFile = path.join(newDir, 'data.json')
    const data = fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, 'utf-8')) : {}
    fs.writeFileSync(path.join(newDir, 'model.ts'), generateModelTs(page, newName, data), 'utf-8')
  } catch { /* best-effort */ }
  console.log(`[rename-state] ${oldDir} -> ${newDir}`)
  res.json({ ok: true, key: newName, label: stateKeyToLabel(newName) })
})

// DELETE /__source/state?projectRoot=<abs>&page=<pageName>&state=<key>
app.delete('/__source/state', (req, res) => {
  const projectRoot = getProjectRoot(req)
  if (!projectRoot) return res.status(400).json({ error: 'No active project set' })
  const { page, state } = req.query
  if (!page || !state) return res.status(400).json({ error: 'Missing ?page= or ?state= query parameter' })
  const statesDir = getPageStatesDir(projectRoot, page)
  if (!statesDir) return res.status(400).json({ error: 'No active project or pagesDir' })
  const stateDir = path.join(statesDir, state)
  if (!isSafeFile(stateDir)) return res.status(403).json({ error: 'Access denied' })
  if (!fs.existsSync(stateDir)) return res.status(404).json({ error: 'State not found' })
  fs.rmSync(stateDir, { recursive: true, force: true })
  console.log(`[delete-state] ${stateDir}`)
  res.json({ ok: true })
})

// ── Layouts ──────────────────────────────────────────────────────────────────

// GET /__source/list-layouts?projectRoot=<abs>
app.get('/__source/list-layouts', (req, res) => {
  const projectRoot = getProjectRoot(req)
  const { layoutsDir } = getProjectDirs(projectRoot)
  if (!layoutsDir || !fs.existsSync(layoutsDir)) return res.json({ layouts: [] })
  let entries
  try { entries = fs.readdirSync(layoutsDir, { withFileTypes: true }) } catch { return res.json({ layouts: [] }) }
  const layouts = entries
    .filter(e => e.isDirectory() && fs.existsSync(path.join(layoutsDir, e.name, 'layout.tsx')))
    .map(e => {
      const dirName = e.name
      const filePath = path.join(layoutsDir, dirName, 'layout.tsx')
      let componentName = dirName
      try {
        const source = fs.readFileSync(filePath, 'utf-8')
        const info = extractAstInfo(source, filePath)
        if (info.components.length > 0) componentName = info.components[0].name
      } catch { /* fall back to dirName */ }
      const baseName = dirName.endsWith('Layout') ? dirName.slice(0, -6) : dirName
      const label = baseName.replace(/([A-Z])/g, ' $1').trim()
      return { id: dirName, label, name: componentName, file: `${dirName}/layout` }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
  res.json({ layouts })
})

// POST /__source/create-layout  body: { name }
app.post('/__source/create-layout', (req, res) => {
  const { name } = req.body ?? {}
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Body must contain { name: string }' })
  }
  const trimmed = name.trim()
  const pascal = trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
  const componentName = pascal.endsWith('Layout') ? pascal : `${pascal}Layout`
  const baseName = componentName.endsWith('Layout') ? componentName.slice(0, -6) : componentName
  const label = baseName.replace(/([A-Z])/g, ' $1').trim()
  const projectRoot = getProjectRoot(req)
  const { layoutsDir } = getProjectDirs(projectRoot)
  if (!layoutsDir) return res.status(400).json({ error: 'No layouts directory configured' })
  const layoutDir = path.join(layoutsDir, componentName)
  const layoutFile = path.join(layoutDir, 'layout.tsx')
  if (!isSafeFile(layoutFile)) return res.status(403).json({ error: 'Access denied' })
  if (fs.existsSync(layoutDir)) return res.status(409).json({ error: `Layout "${componentName}" already exists` })
  fs.mkdirSync(layoutDir, { recursive: true })
  fs.writeFileSync(layoutFile, buildLayoutTemplate(componentName, label), 'utf-8')
  console.log(`[create-layout] ${layoutFile}`)
  res.json({ ok: true, id: componentName, label, name: componentName })
})

// DELETE /__source/layout/:name
app.delete('/__source/layout/:name', (req, res) => {
  const { name } = req.params
  const projectRoot = getProjectRoot(req)
  const { layoutsDir } = getProjectDirs(projectRoot)
  if (!layoutsDir) return res.status(400).json({ error: 'No layouts directory configured' })
  const layoutDir = path.join(layoutsDir, name)
  if (!isSafeFile(layoutDir)) return res.status(403).json({ error: 'Access denied' })
  if (!fs.existsSync(layoutDir)) return res.status(404).json({ error: 'Layout not found' })
  fs.rmSync(layoutDir, { recursive: true, force: true })
  console.log(`[delete-layout] ${layoutDir}`)
  res.json({ ok: true })
})

// GET /__source/page-layout?projectRoot=<abs>&page=<pageId>
app.get('/__source/page-layout', (req, res) => {
  const projectRoot = getProjectRoot(req)
  if (!projectRoot) return res.json({ layout: null })
  const page = req.query.page
  if (!page) return res.json({ layout: null })
  const cfg = readProjectConfig(path.resolve(projectRoot))
  const layout = (cfg.pageLayouts?.[page]) ?? null
  res.json({ layout })
})

// POST /__source/page-layout  body: { projectRoot, page, layout: string | null }
app.post('/__source/page-layout', (req, res) => {
  const { projectRoot, page, layout } = req.body ?? {}
  if (!projectRoot || !page) return res.status(400).json({ error: 'Body must contain { projectRoot, page }' })
  const resolved = path.resolve(projectRoot)
  const cfg = readProjectConfig(resolved)
  if (!cfg.pageLayouts) cfg.pageLayouts = {}
  if (layout) {
    cfg.pageLayouts[page] = layout
  } else {
    delete cfg.pageLayouts[page]
  }
  writeProjectConfig(resolved, cfg)
  res.json({ ok: true })
})

// GET /__source/list-layout-states?projectRoot=<abs>&layout=<layoutId>
app.get('/__source/list-layout-states', (req, res) => {
  const projectRoot = getProjectRoot(req)
  if (!projectRoot) return res.json({ states: [] })
  const layout = req.query.layout
  if (!layout || typeof layout !== 'string') return res.status(400).json({ error: 'Missing ?layout= query parameter' })
  const statesDir = getLayoutStatesDir(projectRoot, layout)
  if (!statesDir || !fs.existsSync(statesDir)) return res.json({ states: [] })
  let entries
  try { entries = fs.readdirSync(statesDir, { withFileTypes: true }) } catch { return res.json({ states: [] }) }
  const stateKeys = entries.filter(e => e.isDirectory()).map(e => e.name)
  let order = []
  try {
    const orderFile = path.join(statesDir, 'order.json')
    if (fs.existsSync(orderFile)) order = JSON.parse(fs.readFileSync(orderFile, 'utf-8'))
  } catch { /* ignore */ }
  const ordered = [
    ...order.filter(k => stateKeys.includes(k)),
    ...stateKeys.filter(k => !order.includes(k)).sort((a, b) => a.localeCompare(b)),
  ]
  res.json({ states: ordered.map(k => ({ key: k, label: stateKeyToLabel(k) })) })
})

// GET /__source/layout-state-data?projectRoot=<abs>&layout=<layoutId>&state=<key>
app.get('/__source/layout-state-data', (req, res) => {
  const projectRoot = getProjectRoot(req)
  if (!projectRoot) return res.json({ data: {} })
  const { layout, state } = req.query
  if (!layout || !state) return res.status(400).json({ error: 'Missing ?layout= or ?state= query parameter' })
  const statesDir = getLayoutStatesDir(projectRoot, layout)
  if (!statesDir) return res.json({ data: {} })
  const dataFile = path.join(statesDir, state, 'data.json')
  if (!isSafeFile(dataFile)) return res.status(403).json({ error: 'Access denied' })
  if (!fs.existsSync(dataFile)) return res.json({ data: {} })
  try { res.json({ data: JSON.parse(fs.readFileSync(dataFile, 'utf-8')) }) } catch { res.json({ data: {} }) }
})

// POST /__source/layout-state-data  body: { projectRoot, layout, state, data }
app.post('/__source/layout-state-data', (req, res) => {
  const { projectRoot, layout, state, data } = req.body ?? {}
  if (!projectRoot || !layout || !state || data === undefined) {
    return res.status(400).json({ error: 'Body must contain { projectRoot, layout, state, data }' })
  }
  const statesDir = getLayoutStatesDir(projectRoot, layout)
  if (!statesDir) return res.status(400).json({ error: 'No active project or layoutsDir' })
  const stateDir = path.join(statesDir, state)
  const dataFile = path.join(stateDir, 'data.json')
  const modelFile = path.join(stateDir, 'model.ts')
  if (!isSafeFile(dataFile)) return res.status(403).json({ error: 'Access denied' })
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf-8')
  fs.writeFileSync(modelFile, generateModelTs(layout, state, data), 'utf-8')
  res.json({ ok: true })
})

// POST /__source/create-layout-state  body: { projectRoot, layout, stateName }
app.post('/__source/create-layout-state', (req, res) => {
  const { projectRoot, layout, stateName } = req.body ?? {}
  if (!projectRoot || !layout || !stateName) {
    return res.status(400).json({ error: 'Body must contain { projectRoot, layout, stateName }' })
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(stateName)) {
    return res.status(400).json({ error: 'stateName must contain only letters, numbers, hyphens, and underscores' })
  }
  const statesDir = getLayoutStatesDir(projectRoot, layout)
  if (!statesDir) return res.status(400).json({ error: 'No active project or layoutsDir' })
  const stateDir = path.join(statesDir, stateName)
  const dataFile = path.join(stateDir, 'data.json')
  if (!isSafeFile(dataFile)) return res.status(403).json({ error: 'Access denied' })
  if (fs.existsSync(stateDir)) return res.status(409).json({ error: `State "${stateName}" already exists` })
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(dataFile, '{}\n', 'utf-8')
  fs.writeFileSync(path.join(stateDir, 'model.ts'), generateModelTs(layout, stateName, {}), 'utf-8')
  res.json({ ok: true, key: stateName, label: stateKeyToLabel(stateName) })
})

// POST /__source/rename-layout-state  body: { projectRoot, layout, oldName, newName }
app.post('/__source/rename-layout-state', (req, res) => {
  const { projectRoot, layout, oldName, newName } = req.body ?? {}
  if (!projectRoot || !layout || !oldName || !newName) {
    return res.status(400).json({ error: 'Body must contain { projectRoot, layout, oldName, newName }' })
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(newName)) {
    return res.status(400).json({ error: 'newName must contain only letters, numbers, hyphens, and underscores' })
  }
  const statesDir = getLayoutStatesDir(projectRoot, layout)
  if (!statesDir) return res.status(400).json({ error: 'No active project or layoutsDir' })
  const oldDir = path.join(statesDir, oldName)
  const newDir = path.join(statesDir, newName)
  if (!isSafeFile(oldDir) || !isSafeFile(newDir)) return res.status(403).json({ error: 'Access denied' })
  if (!fs.existsSync(oldDir)) return res.status(404).json({ error: 'State not found' })
  if (fs.existsSync(newDir)) return res.status(409).json({ error: `State "${newName}" already exists` })
  fs.renameSync(oldDir, newDir)
  try {
    const dataFile = path.join(newDir, 'data.json')
    const data = fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, 'utf-8')) : {}
    fs.writeFileSync(path.join(newDir, 'model.ts'), generateModelTs(layout, newName, data), 'utf-8')
  } catch { /* best-effort */ }
  res.json({ ok: true, key: newName, label: stateKeyToLabel(newName) })
})

// POST /__source/reorder-layout-states  body: { projectRoot, layout, order: string[] }
app.post('/__source/reorder-layout-states', (req, res) => {
  const { projectRoot, layout, order } = req.body ?? {}
  if (!projectRoot || !layout || !Array.isArray(order)) {
    return res.status(400).json({ error: 'Body must contain { projectRoot, layout, order: string[] }' })
  }
  const statesDir = getLayoutStatesDir(projectRoot, layout)
  if (!statesDir) return res.status(400).json({ error: 'No active project or layoutsDir' })
  const orderFile = path.join(statesDir, 'order.json')
  if (!isSafeFile(orderFile)) return res.status(403).json({ error: 'Access denied' })
  fs.mkdirSync(statesDir, { recursive: true })
  fs.writeFileSync(orderFile, JSON.stringify(order, null, 2), 'utf-8')
  res.json({ ok: true })
})

// DELETE /__source/layout-state?projectRoot=<abs>&layout=<layoutId>&state=<key>
app.delete('/__source/layout-state', (req, res) => {
  const projectRoot = getProjectRoot(req)
  if (!projectRoot) return res.status(400).json({ error: 'No active project set' })
  const { layout, state } = req.query
  if (!layout || !state) return res.status(400).json({ error: 'Missing ?layout= or ?state= query parameter' })
  const statesDir = getLayoutStatesDir(projectRoot, layout)
  if (!statesDir) return res.status(400).json({ error: 'No active project or layoutsDir' })
  const stateDir = path.join(statesDir, state)
  if (!isSafeFile(stateDir)) return res.status(403).json({ error: 'Access denied' })
  if (!fs.existsSync(stateDir)) return res.status(404).json({ error: 'State not found' })
  fs.rmSync(stateDir, { recursive: true, force: true })
  res.json({ ok: true })
})

// ── Route helpers ───────────────────────────────────────────────────────────

function getAppDir(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'src', 'app'),
    path.join(projectRoot, 'app'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return path.join(projectRoot, 'src', 'app') // default even if not yet created
}

function findPageFile(pagesDir, pageId) {
  const folder = path.join(pagesDir, pageId)
  if (!fs.existsSync(folder)) return null
  // Always read from the real directory listing to preserve correct filename casing.
  // On Windows, fs.existsSync is case-insensitive, so testing candidate strings
  // like 'page.tsx' would match 'Page.tsx' but return the wrong casing.
  let entries
  try { entries = fs.readdirSync(folder) } catch { return null }
  const preferred = ['page.tsx', 'Page.tsx', 'index.tsx']
  for (const name of preferred) {
    if (entries.includes(name)) return path.join(folder, name)
  }
  const tsx = entries.find(f => f.endsWith('.tsx') && f !== 'controller.tsx')
  if (tsx) return path.join(folder, tsx)
  return null
}

function extractPageComponentInfo(filePath) {
  let source = ''
  try { source = fs.readFileSync(filePath, 'utf-8') } catch {
    return { componentName: null, isDefaultExport: false, props: [] }
  }
  let componentName = null
  let isDefaultExport = false
  // 1. export default function Name
  const defaultFn = source.match(/export\s+default\s+function\s+(\w+)/)
  if (defaultFn) { componentName = defaultFn[1]; isDefaultExport = true }
  // 2. export { Name as default }
  if (!componentName) {
    const reExport = source.match(/export\s*\{[^}]*\b(\w+)\s+as\s+default[^}]*\}/)
    if (reExport) { componentName = reExport[1]; isDefaultExport = true }
  }
  // 3. export default Name  (identifier, not arrow/function keyword)
  if (!componentName) {
    const defaultId = source.match(/export\s+default\s+(?!function\b|class\b)([A-Z]\w+)/)
    if (defaultId) { componentName = defaultId[1]; isDefaultExport = true }
  }
  // 4. export function Name (named export)
  if (!componentName) {
    const namedFn = source.match(/export\s+function\s+(\w+)/)
    if (namedFn) { componentName = namedFn[1]; isDefaultExport = false }
  }
  // 5. export const Name = (named export)
  if (!componentName) {
    const constFn = source.match(/export\s+const\s+(\w+)\s*=/)
    if (constFn) { componentName = constFn[1]; isDefaultExport = false }
  }
  const props = []
  const ifaceMatch = source.match(/interface\s+\w*Props\s*\{([^}]+)\}/)
  if (ifaceMatch) {
    const body = ifaceMatch[1]
    const propRe = /(\w+)\??:\s*([^\n;]+)/g
    let m
    while ((m = propRe.exec(body)) !== null) {
      const name = m[1]
      const type = m[2].trim().replace(/,$/, '').replace(/;$/, '')
      if (name === 'children' || type.includes('ReactNode')) continue
      props.push({ name, type })
    }
  }
  return { componentName, isDefaultExport, props }
}

// ── Route endpoints ───────────────────────────────────────────────────────────

app.get('/__source/list-routes', (req, res) => {
  const projectRoot = req.query.projectRoot
  if (!projectRoot) return res.status(400).json({ error: 'Missing ?projectRoot=' })
  const resolved = path.resolve(projectRoot)
  const cfg = readProjectConfig(resolved)
  const pageRoutes = cfg.pageRoutes ?? {}
  const routes = Object.entries(pageRoutes).map(([pageId, info]) => ({
    pageId,
    route: info.route,
    layoutId: info.layoutId ?? null,
  }))
  res.json({ routes })
})

app.post('/__source/assign-route', (req, res) => {
  const { projectRoot, pageId, route, layoutId } = req.body ?? {}
  if (!projectRoot || !pageId || !route) {
    return res.status(400).json({ error: 'Missing projectRoot, pageId, or route' })
  }
  const resolved = path.resolve(projectRoot)
  const normalizedRoute = route.startsWith('/') ? route : '/' + route
  const routeSegment = normalizedRoute.replace(/^\//, '')
  const { pagesDir, layoutsDir } = getProjectDirs(resolved)
  const appDir = getAppDir(resolved)
  const controllerDir = path.join(pagesDir, pageId)
  const controllerFile = path.join(controllerDir, 'controller.tsx')
  if (!isSafeFile(controllerFile)) return res.status(403).json({ error: 'Access denied' })
  if (!fs.existsSync(controllerFile)) {
    const pageFile = findPageFile(pagesDir, pageId)
    const { componentName, isDefaultExport, props } = pageFile
      ? extractPageComponentInfo(pageFile)
      : { componentName: pageId, isDefaultExport: false, props: [] }
    const finalComponentName = componentName ?? pageId
    const controllerName = pageId + 'Controller'
    const pageImportPath = pageFile ? './' + path.basename(pageFile, '.tsx') : './page'
    const controllerSource = buildControllerTemplate(controllerName, finalComponentName, pageImportPath, isDefaultExport, props)
    fs.mkdirSync(controllerDir, { recursive: true })
    fs.writeFileSync(controllerFile, controllerSource, 'utf-8')
  }
  const srcDir = path.join(resolved, 'src')
  const pagesDirRel = path.relative(srcDir, pagesDir).replace(/\\/g, '/')
  const layoutsDirRel = layoutsDir ? path.relative(srcDir, layoutsDir).replace(/\\/g, '/') : 'layouts'
  const controllerName = pageId + 'Controller'
  const controllerImport = `@/${pagesDirRel}/${pageId}/controller`
  const routeDir = path.join(appDir, routeSegment)
  const routePageFile = path.join(routeDir, 'page.tsx')
  if (!isSafeFile(routePageFile)) return res.status(403).json({ error: 'Access denied' })
  fs.mkdirSync(routeDir, { recursive: true })
  fs.writeFileSync(routePageFile, buildNextRoutePageTemplate(controllerName, controllerImport), 'utf-8')
  if (layoutId) {
    const routeLayoutFile = path.join(routeDir, 'layout.tsx')
    if (!isSafeFile(routeLayoutFile)) return res.status(403).json({ error: 'Access denied' })
    let layoutComponentName = layoutId
    if (layoutsDir) {
      const layoutFile = path.join(layoutsDir, layoutId, 'layout.tsx')
      if (fs.existsSync(layoutFile)) {
        const layoutSource = fs.readFileSync(layoutFile, 'utf-8')
        const namedMatch = layoutSource.match(/export\s+function\s+(\w+)/)
        if (namedMatch) layoutComponentName = namedMatch[1]
      }
    }
    const layoutImport = `@/${layoutsDirRel}/${layoutId}/layout`
    fs.writeFileSync(routeLayoutFile, buildNextRouteLayoutTemplate(layoutComponentName, layoutImport), 'utf-8')
  }
  const cfg = readProjectConfig(resolved)
  cfg.pageRoutes = cfg.pageRoutes ?? {}
  cfg.pageRoutes[pageId] = { route: normalizedRoute, layoutId: layoutId ?? null }
  cfg.pageLayouts = cfg.pageLayouts ?? {}
  if (layoutId) { cfg.pageLayouts[pageId] = layoutId } else { delete cfg.pageLayouts[pageId] }
  writeProjectConfig(resolved, cfg)
  res.json({
    ok: true,
    route: normalizedRoute,
    controllerFile: controllerFile.replace(/\\/g, '/'),
    routeDir: routeDir.replace(/\\/g, '/'),
  })
})

app.delete('/__source/route', (req, res) => {
  const { projectRoot, pageId } = req.query
  if (!projectRoot || !pageId) return res.status(400).json({ error: 'Missing projectRoot or pageId' })
  const resolved = path.resolve(projectRoot)
  const cfg = readProjectConfig(resolved)
  const pageRoutes = cfg.pageRoutes ?? {}
  const entry = pageRoutes[pageId]
  if (entry?.route) {
    const routeSegment = entry.route.replace(/^\//, '')
    const appDir = getAppDir(resolved)
    const routeDir = path.join(appDir, routeSegment)
    if (isSafeFile(routeDir) && fs.existsSync(routeDir)) {
      fs.rmSync(routeDir, { recursive: true, force: true })
    }
  }
  // Also delete the controller file
  const { pagesDir } = getProjectDirs(resolved)
  const controllerFile = path.join(pagesDir, pageId, 'controller.tsx')
  if (isSafeFile(controllerFile) && fs.existsSync(controllerFile)) {
    fs.rmSync(controllerFile, { force: true })
  }
  delete cfg.pageRoutes[pageId]
  if (cfg.pageLayouts) delete cfg.pageLayouts[pageId]
  writeProjectConfig(resolved, cfg)
  res.json({ ok: true })
})

// ── Terminal WebSocket ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true })

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost:3001')
  const root = url.searchParams.get('root')

  if (!root || !isSafeFile(root)) {
    ws.close(1008, 'Invalid or disallowed root')
    return
  }

  const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')
  const shellArgs = process.platform === 'win32' ? ['-NoLogo'] : []

  let ptyProc
  try {
    ptyProc = pty.spawn(shell, shellArgs, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: root,
      env: process.env,
    })
  } catch (err) {
    ws.send(`\r\n[cockpit] Failed to start shell: ${err.message}\r\n`)
    ws.close()
    return
  }

  console.log(`[terminal] Spawned PID ${ptyProc.pid} in ${root}`)

  ptyProc.onData(data => {
    if (ws.readyState === ws.OPEN) ws.send(data)
  })

  ptyProc.onExit(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send('\r\n[process exited]\r\n')
      ws.close()
    }
  })

  ws.on('message', (data) => {
    const str = data.toString()
    try {
      const msg = JSON.parse(str)
      if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        ptyProc.resize(Math.max(1, msg.cols), Math.max(1, msg.rows))
        return
      }
    } catch { /* not JSON — treat as terminal input */ }
    ptyProc.write(str)
  })

  ws.on('close', () => {
    try { ptyProc.kill() } catch { /* already dead */ }
    console.log(`[terminal] Closed PID ${ptyProc.pid}`)
  })
})

// ── Start server ──────────────────────────────────────────────────────────────

const PORT = 3001
const server = http.createServer(app)

server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/__terminal')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
})

server.listen(PORT, () => {
  console.log(`[builder-server] Source API ready → http://localhost:${PORT}/__source`)
  console.log(`[builder-server] Terminal WS ready → ws://localhost:${PORT}/__terminal`)
})
