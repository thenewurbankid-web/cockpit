/**
 * Shared utilities for the builder dev server.
 */
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { parse as babelParse } from '@babel/parser'
import { getTsServerClient, disposeTsServerClient } from './tsserverClient.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** Monorepo root is one level up from builder-app/server/ */
export const REPO_ROOT = path.resolve(__dirname, '../../')

/** The active project root (set when user opens a project — may be outside REPO_ROOT). */
export let activeProjectRoot = null

export function setActiveProjectRoot(rootPath) {
  activeProjectRoot = path.resolve(rootPath)
}

function isWithinDir(child, parent) {
  const isWin = process.platform === 'win32'
  const c = isWin ? child.toLowerCase() : child
  const p = isWin ? parent.toLowerCase() : parent
  return c.startsWith(p + path.sep) || c.startsWith(p + '/')
}

/** Ensure the resolved path is inside the monorepo root OR the active project root (path-traversal guard). */
export function isSafeFile(filePath) {
  const resolved = path.resolve(filePath)
  if (isWithinDir(resolved, REPO_ROOT)) return true
  if (activeProjectRoot && isWithinDir(resolved, activeProjectRoot)) return true
  return false
}

// ── TypeScript diagnostics (persistent tsserver process) ──────────────────────
//
// One tsserver process is kept alive per project root.  Boot takes ~1-3s but
// subsequent requests are ~50-200ms because the project is already loaded.

/** Async: get TypeScript diagnostics via the persistent tsserver process. */
export function getDiagnosticsAsync(filePath, overrideContent) {
  const projectRoot = activeProjectRoot || path.dirname(path.resolve(filePath))
  return getTsServerClient(projectRoot).getDiagnostics(path.resolve(filePath), overrideContent ?? null)
}

let _activeProjectForTs = null

/** Spawn the tsserver for a project root, killing any previous project's process. */
export function warmDiagnosticsCache(projectRoot) {
  const resolved = path.resolve(projectRoot)
  if (_activeProjectForTs && _activeProjectForTs !== resolved) {
    disposeTsServerClient(_activeProjectForTs)
  }
  _activeProjectForTs = resolved
  getTsServerClient(resolved) // ensures the process is started now
}

/**
 * Pre-open a list of source files in the already-warm tsserver so it loads the
 * project graph eagerly. Call this after warmDiagnosticsCache.
 */
export function warmOpenFiles(projectRoot, filePaths) {
  getTsServerClient(path.resolve(projectRoot)).warmOpen(filePaths)
}

// ── Per-project .cockpit/config.json helpers ──────────────────────────────────

const COCKPIT_DIR = '.cockpit'
const COCKPIT_CONFIG = 'config.json'

const DEFAULT_PROJECT_CONFIG = {
  name: '',
  pagesDir: '',
  componentsDir: '',
  expressionsDir: '',
  aliases: {},
  packages: [],
  nodeModulesDirs: [],
  cssFiles: [],
  publicDirs: [],
  fontLinks: [],
}

/**
 * Read the per-project config from <projectRoot>/.cockpit/config.json.
 * Returns defaults if the file is missing or unparseable.
 */
export function readProjectConfig(projectRoot) {
  const configPath = path.join(path.resolve(projectRoot), COCKPIT_DIR, COCKPIT_CONFIG)
  try {
    if (!fs.existsSync(configPath)) return { ...DEFAULT_PROJECT_CONFIG }
    const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    return { ...DEFAULT_PROJECT_CONFIG, ...data }
  } catch {
    return { ...DEFAULT_PROJECT_CONFIG }
  }
}

/**
 * Write the per-project config to <projectRoot>/.cockpit/config.json.
 * Creates the .cockpit directory if it does not exist.
 */
export function writeProjectConfig(projectRoot, config) {
  const cockpitDir = path.join(path.resolve(projectRoot), COCKPIT_DIR)
  fs.mkdirSync(cockpitDir, { recursive: true })
  const configPath = path.join(cockpitDir, COCKPIT_CONFIG)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

// ── Features helpers (filesystem-only — code is source of truth) ──────────────

/** Absolute path to the features root directory for a project. */
export function featuresRoot(projectRoot) {
  return path.join(path.resolve(projectRoot), 'src', 'features')
}

/**
 * Format a directory name into a human-readable feature label.
 * e.g. "authFeature" → "Auth Feature", "user-profile" → "User Profile"
 */
function formatFeatureName(dirName) {
  return dirName
    .replace(/-/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * Scan page files under <projectRoot>/src/pages/ and return the IDs of any pages
 * that import something from src/features/<featureId>/.
 */
function inferPageLinks(projectRoot, featureId) {
  const pagesRoot = path.join(path.resolve(projectRoot), 'src', 'pages')
  if (!fs.existsSync(pagesRoot)) return []
  const linked = []
  try {
    const pattern = new RegExp(`['"](.*?/)?features/${featureId}/`, 'i')
    function scanDir(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { scanDir(full); continue }
        if (!/\.(tsx?|jsx?)$/.test(entry.name)) continue
        try {
          const content = fs.readFileSync(full, 'utf-8')
          if (pattern.test(content)) {
            // derive page ID from the relative path to pagesRoot
            const rel = path.relative(pagesRoot, full).replace(/\\/g, '/')
            const parts = rel.split('/')
            const pageId = parts[0].replace(/\.(tsx?|jsx?)$/, '')
            if (!linked.includes(pageId)) linked.push(pageId)
          }
        } catch { /* skip unreadable files */ }
      }
    }
    scanDir(pagesRoot)
  } catch { /* ignore */ }
  return linked
}

/**
 * Extract prop definitions from a page's page.tsx file.
 * Finds the first *Props interface and returns its fields.
 * @returns {Array<{name: string, type: string, optional: boolean}>}
 */
export function extractPageProps(pageFilePath) {
  let source
  try { source = fs.readFileSync(pageFilePath, 'utf-8') } catch { return [] }
  let ast
  try {
    ast = babelParse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    })
  } catch { return [] }

  for (const node of ast.program.body) {
    if (node.type === 'TSInterfaceDeclaration' && node.id?.name?.endsWith('Props')) {
      return node.body.body.map(prop => {
        const name = prop.key?.name ?? prop.key?.value ?? '?'
        const optional = !!prop.optional
        const ta = prop.typeAnnotation?.typeAnnotation
        const type = ta ? source.slice(ta.start, ta.end) : 'unknown'
        return { name, type, optional }
      })
    }
  }
  return []
}

/**
 * Read the linked pages for a feature from its pages.ts file.
 * Each export line like:
 *   export type { LoginPageProps } from '../../pages/LoginPage/page'
 * maps to a { id: 'LoginPage', props: [...] } entry.
 * @returns {Array<{id: string, props: Array<{name, type, optional}>}>}
 */
export function readLinkedPages(projectRoot, featureId) {
  const pagesRoot = path.join(path.resolve(projectRoot), 'src', 'pages')
  const pagesFile = path.join(featuresRoot(projectRoot), featureId, 'pages.ts')
  if (!fs.existsSync(pagesFile)) return []
  let source
  try { source = fs.readFileSync(pagesFile, 'utf-8') } catch { return [] }
  let ast
  try {
    ast = babelParse(source, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
  } catch { return [] }
  const result = []
  for (const node of ast.program.body) {
    if (node.type === 'ExportNamedDeclaration' && node.source?.value) {
      const match = node.source.value.match(/pages\/([^/]+)\/page$/)
      if (!match) continue
      const pageId = match[1]
      const pageFile = path.join(pagesRoot, pageId, 'page.tsx')
      const props = extractPageProps(pageFile)
      result.push({ id: pageId, props })
    }
  }
  return result
}

/**
 * Add a page link to a feature's pages.ts file.
 * Appends an export type line. Creates the file with a header comment if needed.
 * @returns {{ id: string, props: Array<{name, type, optional}> }}
 */
export function addPageToFeature(projectRoot, featureId, pageId) {
  const resolved = path.resolve(projectRoot)
  const pagesRoot = path.join(resolved, 'src', 'pages')
  const featureDir = path.join(featuresRoot(projectRoot), featureId)
  const pagesFile = path.join(featureDir, 'pages.ts')

  // Find the *Props interface name in the page file
  const pageFile = path.join(pagesRoot, pageId, 'page.tsx')
  let propsTypeName = `${pageId}Props`
  try {
    const src = fs.readFileSync(pageFile, 'utf-8')
    const m = src.match(/^(?:export\s+)?interface\s+(\w+Props)\s*\{/m)
    if (m) propsTypeName = m[1]
  } catch { /* use default */ }

  const exportLine = `export type { ${propsTypeName} } from '../../pages/${pageId}/page'`

  // Check if already linked
  if (fs.existsSync(pagesFile)) {
    const existing = fs.readFileSync(pagesFile, 'utf-8')
    if (existing.includes(`/pages/${pageId}/page`)) {
      return { id: pageId, props: extractPageProps(pageFile) }
    }
    fs.writeFileSync(pagesFile, existing.trimEnd() + '\n' + exportLine + '\n', 'utf-8')
  } else {
    const header = '// Pages linked to this feature — import these types in your machines.\n'
    fs.writeFileSync(pagesFile, header + exportLine + '\n', 'utf-8')
  }

  return { id: pageId, props: extractPageProps(pageFile) }
}

/**
 * Remove a page link from a feature's pages.ts file.
 */
export function removePageFromFeature(projectRoot, featureId, pageId) {
  const pagesFile = path.join(featuresRoot(projectRoot), featureId, 'pages.ts')
  if (!fs.existsSync(pagesFile)) return
  const lines = fs.readFileSync(pagesFile, 'utf-8').split('\n')
  const filtered = lines.filter(l => !l.includes(`/pages/${pageId}/page`))
  const content = filtered.join('\n')
  // If nothing real remains (only the header comment or empty), delete the file
  if (!content.replace(/\/\/[^\n]*/g, '').trim()) {
    fs.unlinkSync(pagesFile)
  } else {
    fs.writeFileSync(pagesFile, content, 'utf-8')
  }
}

/**
 * List all features for a project by scanning src/features/.
 * Returns Feature-shaped objects: { id, name, services[], flows[], pages[] }
 * No config files are read or written.
 */
/**
 * Read a feature's JSON definition file ({ apis, navigation }).
 * File: <featureDir>/<featureId>.feature.json
 */
export function readFeatureDefinition(projectRoot, featureId) {
  const defFile = path.join(featuresRoot(projectRoot), featureId, `${featureId}.feature.json`)
  if (!fs.existsSync(defFile)) return { apis: [], navigation: [] }
  try {
    const raw = JSON.parse(fs.readFileSync(defFile, 'utf-8'))
    return { apis: raw.apis ?? [], navigation: raw.navigation ?? [] }
  } catch {
    return { apis: [], navigation: [] }
  }
}

/**
 * Write a feature's JSON definition file.
 */
export function writeFeatureDefinition(projectRoot, featureId, def) {
  const defFile = path.join(featuresRoot(projectRoot), featureId, `${featureId}.feature.json`)
  if (!isSafeFile(defFile)) throw new Error('Access denied')
  fs.writeFileSync(defFile, JSON.stringify(def, null, 2) + '\n', 'utf-8')
}

export function listFeatures(projectRoot) {
  const root = featuresRoot(projectRoot)
  if (!fs.existsSync(root)) return []
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const featureId = e.name
        const featureDir = path.join(root, featureId)
        let files = []
        try { files = fs.readdirSync(featureDir) } catch { /* ignore */ }
        const services = files
          .filter(f => /\.(ts|tsx)$/.test(f) && !f.endsWith('.machine.ts') && !f.endsWith('.actor.ts') && !f.endsWith('.controller.ts') && f !== 'pages.ts')
          .map(f => f.replace(/\.(tsx?)$/, ''))
        const flows = files
          .filter(f => f.endsWith('.machine.ts'))
          .map(f => f.replace(/\.machine\.ts$/, ''))
        const controllers = files
          .filter(f => f.endsWith('.controller.ts'))
          .map(f => f.replace(/\.controller\.ts$/, ''))
        const summaryFile = path.join(featureDir, 'summary.md')
        let summary = ''
        try { summary = fs.readFileSync(summaryFile, 'utf-8') } catch { /* no summary yet */ }
        const nameFile = path.join(featureDir, 'name.txt')
        let name = formatFeatureName(featureId)
        try { const n = fs.readFileSync(nameFile, 'utf-8').trim(); if (n) name = n } catch { /* use default */ }
        const def = readFeatureDefinition(projectRoot, featureId)
        return {
          id: featureId,
          name,
          summary,
          services,
          flows,
          controllers,
          pages: readLinkedPages(projectRoot, featureId),
          apis: def.apis,
          navigation: def.navigation,
        }
      })
  } catch {
    return []
  }
}

/**
 * Extract fields from the first TypeScript interface whose name matches nameTest.
 * @param {string} filePath - absolute path to a .ts/.tsx file
 * @param {RegExp} nameTest - regex to match the interface name (e.g. /Context$/)
 * @returns {Array<{name: string, type: string, optional: boolean}>}
 */
export function extractInterfaceFields(filePath, nameTest) {
  let source
  try { source = fs.readFileSync(filePath, 'utf-8') } catch { return [] }
  let ast
  try {
    ast = babelParse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
  } catch { return [] }
  for (const rawNode of ast.program.body) {
    const node = rawNode.type === 'ExportNamedDeclaration' && rawNode.declaration?.type === 'TSInterfaceDeclaration'
      ? rawNode.declaration
      : rawNode
    if (node.type === 'TSInterfaceDeclaration' && nameTest.test(node.id?.name ?? '')) {
      return (node.body.body ?? []).map(prop => {
        const name = prop.key?.name ?? prop.key?.value ?? '?'
        const optional = !!prop.optional
        const ta = prop.typeAnnotation?.typeAnnotation
        const type = ta ? source.slice(ta.start, ta.end) : 'unknown'
        return { name, type, optional }
      })
    }
  }
  return []
}

/**
 * Extract context fields from a *.machine.ts file.
 * Finds the first interface whose name ends with "Context".
 * @param {string} machineFilePath
 * @returns {Array<{name: string, type: string, optional: boolean}>}
 */
export function extractMachineContext(machineFilePath) {
  let source
  try { source = fs.readFileSync(machineFilePath, 'utf-8') } catch { return [] }
  let ast
  try {
    ast = babelParse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
  } catch { return [] }
  for (const rawNode of ast.program.body) {
    const node = rawNode.type === 'ExportNamedDeclaration' && rawNode.declaration?.type === 'TSInterfaceDeclaration'
      ? rawNode.declaration
      : rawNode
    if (node.type === 'TSInterfaceDeclaration' && /Context$/.test(node.id?.name ?? '')) {
      return (node.body.body ?? []).map(prop => {
        const name = prop.key?.name ?? prop.key?.value ?? '?'
        const optional = !!prop.optional
        const ta = prop.typeAnnotation?.typeAnnotation
        const type = ta ? source.slice(ta.start, ta.end) : 'unknown'
        // Parse @cockpit-source from leading block comments
        let src = null
        for (const c of (prop.leadingComments ?? [])) {
          const m = (c.value ?? '').match(/@cockpit-source\s+(\w+):(.+)/)
          if (m) {
            const kind = m[1]
            const rest = m[2].trim()
            if (kind === 'page') {
              const dotIdx = rest.indexOf('.')
              src = { kind: 'page', pageId: rest.slice(0, dotIdx), prop: rest.slice(dotIdx + 1) }
            } else if (kind === 'service') {
              const parts = rest.split('.')
              src = { kind: 'service', serviceId: parts[0], interface: parts[1], field: parts[2] }
            }
            break
          }
        }
        return { name, type, optional, source: src }
      })
    }
  }
  return []
}

/**
 * Extract the *Params and *Result interfaces from a service .ts file.
 * @param {string} serviceFilePath
 * @returns {Array<{name: string, fields: Array<{name, type, optional}>}>}
 */
export function extractServiceInterfaces(serviceFilePath) {
  let source
  try { source = fs.readFileSync(serviceFilePath, 'utf-8') } catch { return [] }
  let ast
  try {
    ast = babelParse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
  } catch { return [] }
  const result = []
  for (const rawNode of ast.program.body) {
    const node = rawNode.type === 'ExportNamedDeclaration' && rawNode.declaration?.type === 'TSInterfaceDeclaration'
      ? rawNode.declaration
      : rawNode
    if (node.type === 'TSInterfaceDeclaration' && /Params$|Result$/.test(node.id?.name ?? '')) {
      const fields = (node.body.body ?? []).map(prop => {
        const name = prop.key?.name ?? prop.key?.value ?? '?'
        const optional = !!prop.optional
        const ta = prop.typeAnnotation?.typeAnnotation
        const type = ta ? source.slice(ta.start, ta.end) : 'unknown'
        return { name, type, optional }
      })
      result.push({ name: node.id.name, fields })
    }
  }
  return result
}

/**
 * Rewrite the *Context interface body in a *.machine.ts file in-place.
 * Only replaces the body between the braces — all other content is preserved.
 * @param {string} machineFilePath
 * @param {Array<{name: string, type: string, optional: boolean}>} fields
 */
export function rewriteMachineContext(machineFilePath, fields) {
  let source
  try { source = fs.readFileSync(machineFilePath, 'utf-8') } catch { return }
  let ast
  try {
    ast = babelParse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
  } catch { return }

  const edits = [] // { start, end, replacement }

  // 1. Find *Context interface
  for (const rawNode of ast.program.body) {
    const node = rawNode.type === 'ExportNamedDeclaration' && rawNode.declaration?.type === 'TSInterfaceDeclaration'
      ? rawNode.declaration
      : rawNode
    if (node.type === 'TSInterfaceDeclaration' && /Context$/.test(node.id?.name ?? '')) {
      const indent = '  '
      const bodyContent = fields.length === 0
        ? '\n  // No context fields defined\n'
        : '\n' + fields.map(f => {
            let comment = ''
            if (f.source?.kind === 'page') {
              comment = `${indent}/** @cockpit-source page:${f.source.pageId}.${f.source.prop} */\n`
            } else if (f.source?.kind === 'service') {
              comment = `${indent}/** @cockpit-source service:${f.source.serviceId}.${f.source.interface}.${f.source.field} */\n`
            }
            return `${comment}${indent}${f.name}${f.optional ? '?' : ''}: ${f.type}`
          }).join('\n') + '\n'
      edits.push({ start: node.body.start, end: node.body.end, replacement: '{' + bodyContent + '}' })
      break
    }
  }

  // 2. Find context: {} inside createMachine and rewrite with initial values
  function walkForMachine(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'CallExpression') {
      const { callee } = node
      const isMachineCall =
        (callee.type === 'Identifier' && callee.name === 'createMachine') ||
        (callee.type === 'MemberExpression' && callee.property?.name === 'createMachine')
      if (isMachineCall && node.arguments.length > 0) {
        const config = node.arguments[0]
        if (config.type === 'ObjectExpression') {
          const contextProp = config.properties.find(p =>
            (p.type === 'ObjectProperty' || p.type === 'Property') &&
            (p.key?.name === 'context' || p.key?.value === 'context')
          )
          if (contextProp) {
            // If it's `{} as Context`, replace just the object part
            let objNode = contextProp.value
            if (objNode.type === 'TSAsExpression') objNode = objNode.expression
            const newObj = fields.length === 0
              ? '{}'
              : '{\n' + fields.map(f => {
                  const t = (f.type || '').trim()
                  let val
                  if (f.optional || /\bnull\b/.test(t) || /\bundefined\b/.test(t)) val = 'null'
                  else if (t === 'string') val = "''"
                  else if (t === 'number') val = '0'
                  else if (t === 'boolean') val = 'false'
                  else val = 'null'
                  return `    ${f.name}: ${val},`
                }).join('\n') + '\n  }'
            edits.push({ start: objNode.start, end: objNode.end, replacement: newObj })
            return
          }
        }
        return
      }
    }
    for (const key of Object.keys(node)) {
      if (['type', 'start', 'end', 'loc', 'extra', 'tokens'].includes(key)) continue
      const val = node[key]
      if (Array.isArray(val)) val.forEach(walkForMachine)
      else if (val && typeof val === 'object' && val.type) walkForMachine(val)
    }
  }
  ast.program.body.forEach(walkForMachine)

  if (edits.length === 0) return
  edits.sort((a, b) => b.start - a.start)
  for (const { start, end, replacement } of edits) {
    source = source.slice(0, start) + replacement + source.slice(end)
  }
  fs.writeFileSync(machineFilePath, source, 'utf-8')
}

/**
 * Update a page controller.tsx to pull bound props from a machine actor context.
 * For each binding, replaces `const [prop, setProp] = useState<T>(default)` with
 * `const prop = machineState.context.contextVar` and adds the actor import + hook call.
 *
 * @param {string} controllerFile - absolute path to controller.tsx
 * @param {Array<{prop: string, contextVar: string}>} bindings
 * @param {string} actorHookName - e.g. 'useLoginFlowActor'
 * @param {string} actorImportPath - import specifier for the actor hook
 */
export function rewriteControllerBindings(controllerFile, bindings, actorHookName, actorImportPath) {
  if (!bindings.length || !fs.existsSync(controllerFile)) return
  let source
  try { source = fs.readFileSync(controllerFile, 'utf-8') } catch { return }
  let ast
  try {
    ast = babelParse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
  } catch { return }

  const bindingMap = new Map(bindings.map(b => [b.prop, b.contextVar]))
  const edits = []
  let actorStateVar = 'machineState'

  // 1. Find last import end + check if actor import already present
  let lastImportEnd = 0
  let hasActorImport = false
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration') {
      lastImportEnd = node.end
      if (node.source.value === actorImportPath) {
        const hasHook = node.specifiers.some(s =>
          (s.imported?.name ?? s.local?.name) === actorHookName
        )
        if (hasHook) hasActorImport = true
      }
    }
  }

  // 2. Find exported function body
  let funcBody = null
  for (const node of ast.program.body) {
    if (
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'FunctionDeclaration'
    ) {
      funcBody = node.declaration.body
      break
    }
  }
  if (!funcBody) return

  // 3. Check if actor hook call already exists; if so, use its variable name
  let hasActorHook = false
  for (const stmt of funcBody.body) {
    if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) {
        if (
          decl.init?.type === 'CallExpression' &&
          (decl.init.callee?.name === actorHookName ||
            (decl.init.callee?.type === 'MemberExpression' && decl.init.callee.property?.name === actorHookName))
        ) {
          hasActorHook = true
          actorStateVar = decl.id?.elements?.[0]?.name ?? actorStateVar
        }
      }
    }
  }

  // 4. Find useState declarations for bound props and plan replacements
  for (const stmt of funcBody.body) {
    if (stmt.type !== 'VariableDeclaration') continue
    for (const decl of stmt.declarations) {
      if (
        decl.id?.type === 'ArrayPattern' &&
        decl.init?.type === 'CallExpression'
      ) {
        const callee = decl.init.callee
        const isUseState =
          (callee.type === 'Identifier' && callee.name === 'useState') ||
          (callee.type === 'MemberExpression' && callee.property?.name === 'useState')
        if (!isUseState) continue
        const propName = decl.id.elements[0]?.name
        if (!propName || !bindingMap.has(propName)) continue
        const contextVar = bindingMap.get(propName)
        // Skip if already bound
        if (source.includes(`${actorStateVar}.context.${contextVar}`)) continue
        edits.push({
          start: stmt.start,
          end: stmt.end,
          replacement: `const ${propName} = ${actorStateVar}.context.${contextVar}`,
        })
      }
    }
  }

  if (edits.length === 0) return

  // 5. Add actor import after last import if missing
  if (!hasActorImport) {
    edits.push({
      start: lastImportEnd,
      end: lastImportEnd,
      replacement: `\nimport { ${actorHookName} } from '${actorImportPath}'`,
    })
  }

  // 6. Add actor hook call as first line of function body if missing
  if (!hasActorHook) {
    const insertAt = funcBody.body[0]?.start ?? (funcBody.start + 1)
    edits.push({
      start: insertAt,
      end: insertAt,
      replacement: `const [${actorStateVar}] = ${actorHookName}()\n  `,
    })
  }

  edits.sort((a, b) => b.start - a.start)
  for (const { start, end, replacement } of edits) {
    source = source.slice(0, start) + replacement + source.slice(end)
  }
  fs.writeFileSync(controllerFile, source, 'utf-8')
}

/**
 * Parse an XState v5 machine file and extract top-level state names from the
 * `states: { ... }` object inside `createMachine({ ... })`.
 * @param {string} machineFilePath - absolute path to the *.machine.ts file
 * @returns {string[]}
 */
export function extractMachineStates(machineFilePath) {
  let source
  try { source = fs.readFileSync(machineFilePath, 'utf-8') } catch { return [] }
  let ast
  try {
    ast = babelParse(source, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
  } catch { return [] }

  const result = []

  function walk(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'CallExpression') {
      const { callee } = node
      const isMachineCall =
        (callee.type === 'Identifier' && callee.name === 'createMachine') ||
        (callee.type === 'MemberExpression' && callee.property?.name === 'createMachine')
      if (isMachineCall && node.arguments.length > 0) {
        const config = node.arguments[0]
        if (config.type === 'ObjectExpression') {
          const statesProp = config.properties.find(
            p => (p.type === 'ObjectProperty' || p.type === 'Property') &&
              (p.key?.name === 'states' || p.key?.value === 'states')
          )
          if (statesProp?.value?.type === 'ObjectExpression') {
            for (const prop of statesProp.value.properties) {
              const name = prop.key?.name ?? prop.key?.value
              if (name) result.push(name)
            }
          }
        }
        return
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue
      const child = node[key]
      if (Array.isArray(child)) child.forEach(walk)
      else if (child && typeof child === 'object' && child.type) walk(child)
    }
  }

  for (const stmt of ast.program.body) walk(stmt)
  return result
}

/**
 * Extract events from the *Event union type in a *.machine.ts file.
 * Returns each event's type string + payload fields.
 * @param {string} machineFilePath
 * @returns {Array<{type: string, payload: Array<{name, type, optional}>}>}
 */
export function extractMachineEvents(machineFilePath) {
  let source
  try { source = fs.readFileSync(machineFilePath, 'utf-8') } catch { return [] }
  let ast
  try {
    ast = babelParse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
  } catch { return [] }
  for (const rawNode of ast.program.body) {
    const node = rawNode.type === 'ExportNamedDeclaration' && rawNode.declaration?.type === 'TSTypeAliasDeclaration'
      ? rawNode.declaration
      : rawNode
    if (node.type === 'TSTypeAliasDeclaration' && /Event$/.test(node.id?.name ?? '')) {
      const ta = node.typeAnnotation
      const members = ta?.type === 'TSUnionType' ? ta.types : (ta ? [ta] : [])
      return members
        .filter(m => m.type === 'TSTypeLiteral')
        .map(m => {
          const typeProp = m.members.find(p =>
            p.type === 'TSPropertySignature' && (p.key?.name === 'type' || p.key?.value === 'type')
          )
          const typeVal = typeProp?.typeAnnotation?.typeAnnotation
          const eventType = typeVal?.type === 'TSLiteralType' && typeVal.literal?.type === 'StringLiteral'
            ? typeVal.literal.value : null
          if (!eventType) return null
          const payload = m.members
            .filter(p => p.type === 'TSPropertySignature' && (p.key?.name ?? p.key?.value) !== 'type')
            .map(p => ({
              name: p.key?.name ?? p.key?.value ?? '?',
              type: p.typeAnnotation?.typeAnnotation
                ? source.slice(p.typeAnnotation.typeAnnotation.start, p.typeAnnotation.typeAnnotation.end)
                : 'unknown',
              optional: !!p.optional,
            }))
          return { type: eventType, payload }
        })
        .filter(Boolean)
    }
  }
  return []
}

/**
 * Extract detailed state info from a *.machine.ts file.
 * Returns per-state: name, stateType, entry/exit counts, and transitions.
 * @param {string} machineFilePath
 * @returns {Array<{name, stateType, entryCount, exitCount, transitions}>}
 */
export function extractMachineStatesDetailed(machineFilePath) {
  let source
  try { source = fs.readFileSync(machineFilePath, 'utf-8') } catch { return [] }
  let ast
  try {
    ast = babelParse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
  } catch { return [] }
  const result = []

  function getActionCount(node) {
    if (!node) return 0
    if (node.type === 'ArrayExpression') return node.elements.filter(Boolean).length
    return 1
  }

  function getActionNames(node) {
    if (!node) return []
    if (node.type === 'ArrayExpression')
      return node.elements.filter(Boolean).map(e => e.value ?? e.name ?? '?')
    if (node.type === 'StringLiteral') return [node.value]
    if (node.type === 'Identifier') return [node.name]
    return []
  }

  function getActionLabel(node) {
    if (!node) return '?'
    if (node.type === 'StringLiteral') return node.value
    if (node.type === 'Identifier') return node.name
    if (node.type === 'CallExpression') {
      const callee = node.callee?.name ?? node.callee?.property?.name ?? '?'
      return `${callee}(...)`
    }
    return '?'
  }

  function getTransitionActionLabels(actionsNode) {
    if (!actionsNode) return []
    if (actionsNode.type === 'ArrayExpression')
      return actionsNode.elements.filter(Boolean).map(getActionLabel)
    return [getActionLabel(actionsNode)]
  }

  /** Extract keys from assign({ key: ... }) call nodes */
  function getAssignTargetKeys(actionsNode) {
    const keys = []
    function collectAssign(n) {
      if (!n || typeof n !== 'object') return
      if (
        n.type === 'CallExpression' &&
        (n.callee?.name === 'assign' || n.callee?.property?.name === 'assign') &&
        n.arguments?.length > 0
      ) {
        const arg = n.arguments[0]
        if (arg?.type === 'ObjectExpression') {
          for (const prop of arg.properties) {
            const k = prop.key?.name ?? prop.key?.value
            if (k) keys.push(k)
          }
        }
        return
      }
      for (const key of Object.keys(n)) {
        if (['loc', 'start', 'end', 'type', 'extra', 'tokens'].includes(key)) continue
        const child = n[key]
        if (Array.isArray(child)) child.forEach(collectAssign)
        else if (child && typeof child === 'object' && child.type) collectAssign(child)
      }
    }
    collectAssign(actionsNode)
    return keys
  }

  function getTransitions(onProp) {
    if (!onProp?.value || onProp.value.type !== 'ObjectExpression') return []
    return onProp.value.properties.map(p => {
      const event = p.key?.name ?? p.key?.value ?? '?'
      const val = p.value
      let target, hasGuard = false, actionCount = 0, actions = [], assignTargets = []
      if (val?.type === 'StringLiteral') {
        target = val.value
      } else if (val?.type === 'ObjectExpression') {
        const targetProp = val.properties.find(x => x.key?.name === 'target' || x.key?.value === 'target')
        if (targetProp?.value?.type === 'StringLiteral') target = targetProp.value.value
        hasGuard = !!val.properties.find(x => x.key?.name === 'guard' || x.key?.value === 'guard')
        const actionsProp = val.properties.find(x => x.key?.name === 'actions' || x.key?.value === 'actions')
        actionCount = getActionCount(actionsProp?.value)
        actions = getTransitionActionLabels(actionsProp?.value)
        assignTargets = getAssignTargetKeys(actionsProp?.value)
      }
      return { event, target, hasGuard, actionCount, actions, assignTargets }
    })
  }

  function walk(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'CallExpression') {
      const { callee } = node
      const isMachineCall =
        (callee.type === 'Identifier' && callee.name === 'createMachine') ||
        (callee.type === 'MemberExpression' && callee.property?.name === 'createMachine')
      if (isMachineCall && node.arguments.length > 0) {
        const config = node.arguments[0]
        if (config.type === 'ObjectExpression') {
          const statesProp = config.properties.find(
            p => (p.type === 'ObjectProperty' || p.type === 'Property') &&
              (p.key?.name === 'states' || p.key?.value === 'states')
          )
          if (statesProp?.value?.type === 'ObjectExpression') {
            for (const sp of statesProp.value.properties) {
              const name = sp.key?.name ?? sp.key?.value
              if (!name) continue
              const stateConfig = sp.value
              if (!stateConfig || stateConfig.type !== 'ObjectExpression') {
                result.push({ name, stateType: 'normal', entryCount: 0, exitCount: 0, entryActions: [], exitActions: [], transitions: [] })
                continue
              }
              const typeProp = stateConfig.properties.find(p => p.key?.name === 'type' || p.key?.value === 'type')
              const stateType = typeProp?.value?.value ?? 'normal'
              const entryProp = stateConfig.properties.find(p => p.key?.name === 'entry' || p.key?.value === 'entry')
              const exitProp = stateConfig.properties.find(p => p.key?.name === 'exit' || p.key?.value === 'exit')
              const onProp = stateConfig.properties.find(p => p.key?.name === 'on' || p.key?.value === 'on')
              const invokeProp = stateConfig.properties.find(p => p.key?.name === 'invoke' || p.key?.value === 'invoke')
              // Extract invoke transitions (onDone / onError)
              const invokeTransitions = []
              if (invokeProp) {
                // invoke can be a single object or an array of objects
                const invArr = invokeProp.value?.type === 'ArrayExpression'
                  ? invokeProp.value.elements
                  : invokeProp.value?.type === 'ObjectExpression'
                    ? [invokeProp.value]
                    : []
                for (const inv of invArr) {
                  if (!inv || inv.type !== 'ObjectExpression') continue
                  // Extract actor id: prefer explicit `id:` prop, then `src:` string/identifier
                  let invokeActorId = null
                  const idProp = inv.properties?.find(x => x.key?.name === 'id' || x.key?.value === 'id')
                  if (idProp?.value?.type === 'StringLiteral') {
                    invokeActorId = idProp.value.value
                  } else {
                    const srcProp = inv.properties?.find(x => x.key?.name === 'src' || x.key?.value === 'src')
                    if (srcProp?.value?.type === 'StringLiteral') invokeActorId = srcProp.value.value
                    else if (srcProp?.value?.type === 'Identifier') invokeActorId = srcProp.value.name
                  }
                  for (const key of ['onDone', 'onError']) {
                    const p = inv.properties?.find(x => x.key?.name === key || x.key?.value === key)
                    if (!p) continue
                    const val = p.value
                    let target, assignTargets = [], actions = []
                    if (val?.type === 'StringLiteral') { target = val.value }
                    else if (val?.type === 'ObjectExpression') {
                      const tgt = val.properties.find(x => x.key?.name === 'target' || x.key?.value === 'target')
                      if (tgt?.value?.type === 'StringLiteral') target = tgt.value.value
                      const act = val.properties.find(x => x.key?.name === 'actions' || x.key?.value === 'actions')
                      assignTargets = getAssignTargetKeys(act?.value)
                      actions = getTransitionActionLabels(act?.value)
                    }
                    invokeTransitions.push({ event: key, target, hasGuard: false, actionCount: actions.length, actions, assignTargets, isInvoke: true, invokeActorId })
                  }
                }
              }
              result.push({
                name, stateType,
                entryCount: getActionCount(entryProp?.value),
                exitCount: getActionCount(exitProp?.value),
                entryActions: getActionNames(entryProp?.value),
                exitActions: getActionNames(exitProp?.value),
                transitions: [...getTransitions(onProp), ...invokeTransitions],
                hasInvoke: invokeTransitions.length > 0,
              })
            }
          }
        }
        return
      }
    }
    for (const key of Object.keys(node)) {
      if (['loc', 'start', 'end', 'type', 'extra', 'tokens'].includes(key)) continue
      const child = node[key]
      if (Array.isArray(child)) child.forEach(walk)
      else if (child && typeof child === 'object' && child.type) walk(child)
    }
  }
  for (const stmt of ast.program.body) walk(stmt)
  return result
}

/**
 * Extract all assign() calls from a *.machine.ts file, grouped by state + trigger.
 * @param {string} machineFilePath
 * @returns {Array<{state: string, trigger: string, assigns: string[]}>}
 */
export function extractMachineActions(machineFilePath) {
  let source
  try { source = fs.readFileSync(machineFilePath, 'utf-8') } catch { return [] }
  let ast
  try {
    ast = babelParse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
  } catch { return [] }
  const result = []

  function getAssignKeys(node) {
    const keys = []
    function find(n) {
      if (!n || typeof n !== 'object') return
      if (n.type === 'CallExpression') {
        const callee = n.callee
        if ((callee.type === 'Identifier' && callee.name === 'assign') ||
            (callee.type === 'MemberExpression' && callee.property?.name === 'assign')) {
          const arg = n.arguments[0]
          if (arg?.type === 'ObjectExpression') {
            for (const p of arg.properties) {
              const k = p.key?.name ?? p.key?.value
              if (k) keys.push(k)
            }
          }
          return
        }
      }
      for (const key of Object.keys(n)) {
        if (['loc', 'start', 'end', 'type', 'extra'].includes(key)) continue
        const child = n[key]
        if (Array.isArray(child)) child.forEach(find)
        else if (child && typeof child === 'object' && child.type) find(child)
      }
    }
    find(node)
    return keys
  }

  function collectFromActions(node, state, trigger) {
    const keys = getAssignKeys(node)
    if (keys.length > 0) result.push({ state, trigger, assigns: keys })
  }

  function processState(stateConfig, stateName) {
    for (const p of stateConfig.properties) {
      const key = p.key?.name ?? p.key?.value
      if (key === 'entry') collectFromActions(p.value, stateName, 'entry')
      else if (key === 'exit') collectFromActions(p.value, stateName, 'exit')
      else if (key === 'on' && p.value?.type === 'ObjectExpression') {
        for (const trans of p.value.properties) {
          const evName = trans.key?.name ?? trans.key?.value
          const val = trans.value
          if (val?.type === 'ObjectExpression') {
            const ap = val.properties.find(x => x.key?.name === 'actions' || x.key?.value === 'actions')
            if (ap) collectFromActions(ap.value, stateName, evName)
          }
        }
      }
    }
  }

  function walk(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'CallExpression') {
      const { callee } = node
      const isMachineCall =
        (callee.type === 'Identifier' && callee.name === 'createMachine') ||
        (callee.type === 'MemberExpression' && callee.property?.name === 'createMachine')
      if (isMachineCall && node.arguments.length > 0) {
        const config = node.arguments[0]
        if (config.type === 'ObjectExpression') {
          const globalOnProp = config.properties.find(p => p.key?.name === 'on' || p.key?.value === 'on')
          if (globalOnProp?.value?.type === 'ObjectExpression') {
            processState({ properties: [globalOnProp] }, '__global__')
          }
          const statesProp = config.properties.find(p => p.key?.name === 'states' || p.key?.value === 'states')
          if (statesProp?.value?.type === 'ObjectExpression') {
            for (const sp of statesProp.value.properties) {
              const name = sp.key?.name ?? sp.key?.value
              if (name && sp.value?.type === 'ObjectExpression') processState(sp.value, name)
            }
          }
        }
        return
      }
    }
    for (const key of Object.keys(node)) {
      if (['loc', 'start', 'end', 'type', 'extra', 'tokens'].includes(key)) continue
      const child = node[key]
      if (Array.isArray(child)) child.forEach(walk)
      else if (child && typeof child === 'object' && child.type) walk(child)
    }
  }
  for (const stmt of ast.program.body) walk(stmt)
  return result
}

/**
 * Rewrite the *Event union type in a *.machine.ts file with a new events array.
 * Inserts the declaration after the last import if not found.
 * @param {string} machineFilePath
 * @param {Array<{type: string, payload: Array<{name, type, optional}>}>} events
 */
export function rewriteMachineEvents(machineFilePath, events) {
  let source
  try { source = fs.readFileSync(machineFilePath, 'utf-8') } catch { return }
  let ast
  try {
    ast = babelParse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
  } catch { return }

  const buildBody = (evs) => evs.length === 0
    ? 'never'
    : evs.map(e => {
        const fields = e.payload.length === 0
          ? ''
          : '; ' + e.payload.map(p => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join('; ')
        return `  | { type: '${e.type}'${fields} }`
      }).join('\n')

  for (const rawNode of ast.program.body) {
    const isExport = rawNode.type === 'ExportNamedDeclaration' && rawNode.declaration?.type === 'TSTypeAliasDeclaration'
    const node = isExport ? rawNode.declaration : rawNode
    if (node.type === 'TSTypeAliasDeclaration' && /Event$/.test(node.id?.name ?? '')) {
      const newDecl = `export type ${node.id.name} =\n${buildBody(events)}`
      source = source.slice(0, rawNode.start) + newDecl + source.slice(rawNode.end)
      fs.writeFileSync(machineFilePath, source, 'utf-8')
      return
    }
  }
  // Not found — insert after last import
  let insertPos = 0
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration') insertPos = node.end
  }
  const base = path.basename(machineFilePath).replace(/\.machine\.ts$/, '')
  const pascal = base.charAt(0).toUpperCase() + base.slice(1)
  source = source.slice(0, insertPos) + `\n\nexport type ${pascal}Event =\n${buildBody(events)}` + source.slice(insertPos)
  fs.writeFileSync(machineFilePath, source, 'utf-8')
}

/**
 * Add a new state to the `states: {}` object in a *.machine.ts file.
 * @param {string} machineFilePath
 * @param {string} name - state name
 * @param {string} [stateType] - 'final' | 'parallel' | 'normal'
 */
export function addMachineState(machineFilePath, name, stateType) {
  let source
  try { source = fs.readFileSync(machineFilePath, 'utf-8') } catch { return }
  let ast
  try {
    ast = babelParse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
  } catch { return }

  function findStatesObj(node) {
    if (!node || typeof node !== 'object') return null
    if (node.type === 'CallExpression') {
      const { callee } = node
      const isMachineCall =
        (callee.type === 'Identifier' && callee.name === 'createMachine') ||
        (callee.type === 'MemberExpression' && callee.property?.name === 'createMachine')
      if (isMachineCall && node.arguments.length > 0) {
        const config = node.arguments[0]
        if (config?.type === 'ObjectExpression') {
          const sp = config.properties.find(p => p.key?.name === 'states' || p.key?.value === 'states')
          if (sp?.value?.type === 'ObjectExpression') return sp.value
        }
        return null
      }
    }
    for (const key of Object.keys(node)) {
      if (['loc', 'start', 'end', 'type', 'extra', 'tokens'].includes(key)) continue
      const child = node[key]
      if (Array.isArray(child)) { for (const c of child) { const r = findStatesObj(c); if (r) return r } }
      else if (child && typeof child === 'object' && child.type) { const r = findStatesObj(child); if (r) return r }
    }
    return null
  }

  let statesObj = null
  for (const stmt of ast.program.body) { statesObj = findStatesObj(stmt); if (statesObj) break }
  if (!statesObj) return

  const body = stateType === 'final' ? `{ type: 'final' }` : stateType === 'parallel' ? `{ type: 'parallel', states: {} }` : '{}'
  const props = statesObj.properties
  if (props.length > 0) {
    const lastProp = props[props.length - 1]
    const insertPos = lastProp.end
    // Insert immediately after the last prop's AST end (before any trailing comma).
    // This avoids a double-comma when the source already has a trailing comma.
    source = source.slice(0, insertPos) + `,\n    ${name}: ${body}` + source.slice(insertPos)
  } else {
    source = source.slice(0, statesObj.end - 1) + `\n    ${name}: ${body},\n  ` + source.slice(statesObj.end - 1)
  }
  fs.writeFileSync(machineFilePath, source, 'utf-8')
}

/**
 * Delete a named state from the `states: {}` object in a *.machine.ts file.
 * @param {string} machineFilePath
 * @param {string} name - state name to remove
 */
export function deleteMachineState(machineFilePath, name) {
  let source
  try { source = fs.readFileSync(machineFilePath, 'utf-8') } catch { return }
  let ast
  try {
    ast = babelParse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
  } catch { return }

  function findStatesObj(node) {
    if (!node || typeof node !== 'object') return null
    if (node.type === 'CallExpression') {
      const { callee } = node
      const isMachineCall =
        (callee.type === 'Identifier' && callee.name === 'createMachine') ||
        (callee.type === 'MemberExpression' && callee.property?.name === 'createMachine')
      if (isMachineCall && node.arguments.length > 0) {
        const config = node.arguments[0]
        if (config?.type === 'ObjectExpression') {
          const sp = config.properties.find(p => p.key?.name === 'states' || p.key?.value === 'states')
          if (sp?.value?.type === 'ObjectExpression') return sp.value
        }
        return null
      }
    }
    for (const key of Object.keys(node)) {
      if (['loc', 'start', 'end', 'type', 'extra', 'tokens'].includes(key)) continue
      const child = node[key]
      if (Array.isArray(child)) { for (const c of child) { const r = findStatesObj(c); if (r) return r } }
      else if (child && typeof child === 'object' && child.type) { const r = findStatesObj(child); if (r) return r }
    }
    return null
  }

  let statesObj = null
  for (const stmt of ast.program.body) { statesObj = findStatesObj(stmt); if (statesObj) break }
  if (!statesObj) return

  const prop = statesObj.properties.find(p => (p.key?.name ?? p.key?.value) === name)
  if (!prop) return

  // Find start of the property's line
  let lineStart = prop.start
  while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--

  // Find end past trailing comma + newline
  let lineEnd = prop.end
  if (source[lineEnd] === ',') lineEnd++
  if (source[lineEnd] === '\r') lineEnd++
  if (source[lineEnd] === '\n') lineEnd++

  source = source.slice(0, lineStart) + source.slice(lineEnd)
  fs.writeFileSync(machineFilePath, source, 'utf-8')
}

// ─── Machine builder helpers ───────────────────────────────────────────────

/** Helper: find the `states:` ObjectExpression inside createMachine. */
function findMachineStatesObj(ast) {
  function walk(node) {
    if (!node || typeof node !== 'object') return null
    if (node.type === 'CallExpression') {
      const { callee } = node
      if (
        (callee.type === 'Identifier' && callee.name === 'createMachine') ||
        (callee.type === 'MemberExpression' && callee.property?.name === 'createMachine')
      ) {
        const config = node.arguments[0]
        if (config?.type === 'ObjectExpression') {
          const sp = config.properties.find(p => p.key?.name === 'states' || p.key?.value === 'states')
          if (sp?.value?.type === 'ObjectExpression') return { config, statesObj: sp.value }
        }
        return null
      }
    }
    for (const key of Object.keys(node)) {
      if (['loc','start','end','type','extra','tokens'].includes(key)) continue
      const child = node[key]
      if (Array.isArray(child)) { for (const c of child) { const r = walk(c); if (r) return r } }
      else if (child && typeof child === 'object' && child.type) { const r = walk(child); if (r) return r }
    }
    return null
  }
  for (const stmt of ast.program.body) { const r = walk(stmt); if (r) return r }
  return null
}

/** Helper: find a named state's ObjectExpression in statesObj. */
function findStateProp(statesObj, stateName) {
  return statesObj.properties.find(p => (p.key?.name ?? p.key?.value) === stateName) ?? null
}

/** Helper: parse source + reuse pattern for machine file functions. */
function parseMachineFile(machineFilePath) {
  let source
  try { source = fs.readFileSync(machineFilePath, 'utf-8') } catch { return null }
  let ast
  try { ast = babelParse(source, { sourceType: 'module', plugins: ['typescript','jsx'], errorRecovery: true }) } catch { return null }
  return { source, ast }
}

/**
 * Add (or replace) a transition in a state's `on:` block.
 * Returns the XState snippet string that was written.
 * @param {string} machineFilePath
 * @param {string} stateName
 * @param {string} event
 * @param {string} target
 * @param {string|undefined} guard
 */
export function addMachineTransition(machineFilePath, stateName, event, target, guard) {
  const parsed = parseMachineFile(machineFilePath)
  if (!parsed) return ''
  let { source, ast } = parsed

  const found = findMachineStatesObj(ast)
  if (!found) return ''
  const stateProp = findStateProp(found.statesObj, stateName)
  if (!stateProp || stateProp.value?.type !== 'ObjectExpression') return ''

  const stateConfig = stateProp.value

  const snippet = guard
    ? `{ type: '${event}', target: '${target}', guard: '${guard}' }`
    : target ? `{ type: '${event}', target: '${target}' }` : `{ type: '${event}' }`
  const transitionCode = (() => {
    if (target && guard) return `{ target: '${target}', guard: '${guard}' }`
    if (target) return `'${target}'`
    if (guard) return `{ guard: '${guard}' }`
    return '{}'
  })()

  const onProp = stateConfig.properties.find(p => p.key?.name === 'on' || p.key?.value === 'on')
  if (onProp && onProp.value?.type === 'ObjectExpression') {
    // Check if event already exists
    const existing = onProp.value.properties.find(p => (p.key?.name ?? p.key?.value) === event)
    if (existing) {
      // Replace existing transition
      source = source.slice(0, existing.value.start) + transitionCode + source.slice(existing.value.end)
    } else {
      // Append to on block
      const onObj = onProp.value
      const props = onObj.properties
      if (props.length > 0) {
        const last = props[props.length - 1]
        let ins = last.end
        if (source[ins] === ',') ins++
        source = source.slice(0, ins) + `,\n        ${event}: ${transitionCode}` + source.slice(ins)
      } else {
        // Empty on: {} block
        source = source.slice(0, onObj.end - 1) + `\n        ${event}: ${transitionCode},\n      ` + source.slice(onObj.end - 1)
      }
    }
  } else {
    // No `on:` block — add one before closing brace of state
    const ins = stateConfig.end - 1
    const comma = stateConfig.properties.length > 0 ? ',' : ''
    source = source.slice(0, ins) + `${comma}\n      on: {\n        ${event}: ${transitionCode},\n      }` + source.slice(ins)
  }

  fs.writeFileSync(machineFilePath, source, 'utf-8')
  return guard
    ? `${stateName}: {\n  on: { ${event}: { target: '${target}', guard: '${guard}' } }\n}`
    : `${stateName}: {\n  on: { ${event}: '${target}' }\n}`
}

/**
 * Remove a specific event key from a state's `on:` block.
 * @param {string} machineFilePath
 * @param {string} stateName
 * @param {string} event
 */
/** Remove a property node from an object, keeping surrounding commas/whitespace tidy. */
function spliceProperty(source, props, node) {
  const idx = props.indexOf(node)
  if (idx === -1) return source

  let start = node.start
  let end = node.end
  if (source[end] === ',') end++

  if (props.length === 1) {
    // Only prop — eat surrounding whitespace (but not the enclosing braces)
    while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t' || source[start - 1] === '\n' || source[start - 1] === '\r')) start--
    while (source[end] === ' ' || source[end] === '\t' || source[end] === '\n' || source[end] === '\r') end++
  } else if (idx === 0) {
    // First of many — eat up to start of next prop
    end = props[1].start
  } else {
    // Not first — eat whitespace/newline back to (but not including) the separator comma
    let s = start - 1
    while (s >= 0 && (source[s] === ' ' || source[s] === '\t' || source[s] === '\n' || source[s] === '\r')) s--
    if (s >= 0 && source[s] === ',') start = s
  }

  return source.slice(0, start) + source.slice(end)
}

export function deleteMachineTransition(machineFilePath, stateName, event) {
  const parsed = parseMachineFile(machineFilePath)
  if (!parsed) return
  let { source, ast } = parsed

  const found = findMachineStatesObj(ast)
  if (!found) return
  const stateProp = findStateProp(found.statesObj, stateName)
  if (!stateProp || stateProp.value?.type !== 'ObjectExpression') return

  const onProp = stateProp.value.properties.find(p => p.key?.name === 'on' || p.key?.value === 'on')
  if (!onProp || onProp.value?.type !== 'ObjectExpression') return

  const onObj = onProp.value
  const evProp = onObj.properties.find(p => (p.key?.name ?? p.key?.value) === event)
  if (!evProp) return

  // Remove the event property using AST-range-based splice (handles inline and multiline)
  source = spliceProperty(source, onObj.properties, evProp)

  // Re-parse: if on: {} is now empty, remove the entire on: property too
  try {
    const ast2 = babelParse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
    const found2 = findMachineStatesObj(ast2)
    if (found2) {
      const stateProp2 = findStateProp(found2.statesObj, stateName)
      if (stateProp2?.value?.type === 'ObjectExpression') {
        const onProp2 = stateProp2.value.properties.find(p => p.key?.name === 'on' || p.key?.value === 'on')
        if (onProp2?.value?.type === 'ObjectExpression' && onProp2.value.properties.length === 0) {
          source = spliceProperty(source, stateProp2.value.properties, onProp2)
        }
      }
    }
  } catch { /* leave as-is */ }

  fs.writeFileSync(machineFilePath, source, 'utf-8')
}

/**
 * Set the `actions` array on a specific event transition inside a state's `on:` block.
 * Handles conversion from string form (`'target'`) to object form if needed.
 * @param {string} machineFilePath
 * @param {string} stateName
 * @param {string} event
 * @param {string[]} actionCodes  Already-serialized action expressions, e.g. ["assign({ count: (ctx) => ctx.count + 1 })", "raise({ type: 'DONE' })"]
 * @returns {string} snippet
 */
export function setTransitionActions(machineFilePath, stateName, event, actionCodes) {
  const parsed = parseMachineFile(machineFilePath)
  if (!parsed) return ''
  let { source, ast } = parsed

  const found = findMachineStatesObj(ast)
  if (!found) return ''
  const stateProp = findStateProp(found.statesObj, stateName)
  if (!stateProp || stateProp.value?.type !== 'ObjectExpression') return ''

  const onProp = stateProp.value.properties.find(p => p.key?.name === 'on' || p.key?.value === 'on')
  if (!onProp || onProp.value?.type !== 'ObjectExpression') return ''

  const evProp = onProp.value.properties.find(p => (p.key?.name ?? p.key?.value) === event)
  if (!evProp) return ''

  const actionsStr = actionCodes.length === 0
    ? null
    : actionCodes.length === 1
      ? actionCodes[0]
      : `[\n          ${actionCodes.join(',\n          ')},\n        ]`

  if (evProp.value.type === 'StringLiteral') {
    const target = evProp.value.value
    const newVal = actionsStr
      ? `{ target: '${target}', actions: ${actionsStr} }`
      : `'${target}'`
    source = source.slice(0, evProp.value.start) + newVal + source.slice(evProp.value.end)
  } else if (evProp.value.type === 'ObjectExpression') {
    // Re-parse to get fresh positions after potential prior edits
    const reparsed = parseMachineFile(machineFilePath)
    if (reparsed) { source = reparsed.source; ast = reparsed.ast }
    const found2 = findMachineStatesObj(ast)
    if (!found2) return ''
    const stateProp2 = findStateProp(found2.statesObj, stateName)
    if (!stateProp2) return ''
    const onProp2 = stateProp2.value.properties.find(p => p.key?.name === 'on' || p.key?.value === 'on')
    if (!onProp2) return ''
    const evProp2 = onProp2.value.properties.find(p => (p.key?.name ?? p.key?.value) === event)
    if (!evProp2 || evProp2.value.type !== 'ObjectExpression') return ''

    const actionsProp = evProp2.value.properties.find(p => p.key?.name === 'actions' || p.key?.value === 'actions')
    if (actionsProp) {
      if (actionsStr) {
        source = source.slice(0, actionsProp.value.start) + actionsStr + source.slice(actionsProp.value.end)
      } else {
        // Remove actions property
        let start = actionsProp.start
        let end = actionsProp.end
        if (source[end] === ',') end++
        if (source[start - 1] === ',') start--
        source = source.slice(0, start) + source.slice(end)
      }
    } else if (actionsStr) {
      // Append actions property
      const props = evProp2.value.properties
      const ins = props.length > 0 ? props[props.length - 1].end : evProp2.value.end - 1
      const sep = props.length > 0 ? ', ' : '\n        '
      source = source.slice(0, ins) + `${sep}actions: ${actionsStr}` + source.slice(ins)
    }
  }

  fs.writeFileSync(machineFilePath, source, 'utf-8')
  return `${stateName}.on.${event}: { actions: ${actionsStr ?? '[]'} }`
}

/**
 * Set the machine's top-level `initial:` property.
 * @param {string} machineFilePath
 * @param {string} stateName
 * @returns {string} snippet
 */
export function setMachineInitial(machineFilePath, stateName) {
  const parsed = parseMachineFile(machineFilePath)
  if (!parsed) return ''
  let { source, ast } = parsed

  const found = findMachineStatesObj(ast)
  if (!found) return ''
  const { config } = found

  const initialProp = config.properties.find(p => p.key?.name === 'initial' || p.key?.value === 'initial')
  if (initialProp) {
    source = source.slice(0, initialProp.value.start) + `'${stateName}'` + source.slice(initialProp.value.end)
  } else {
    // Insert initial: after id: if present, else at start of config
    const idProp = config.properties[0]
    const ins = idProp ? idProp.end : config.start + 1
    const sep = idProp ? ',\n  ' : '\n  '
    source = source.slice(0, ins) + `${sep}initial: '${stateName}'` + source.slice(ins)
  }
  fs.writeFileSync(machineFilePath, source, 'utf-8')
  return `initial: '${stateName}'`
}

/**
 * Set the `type:` property on a named state. Pass null/undefined to remove it.
 * @param {string} machineFilePath
 * @param {string} stateName
 * @param {'final'|'parallel'|'history'|null} stateType
 * @returns {string} snippet
 */
export function setMachineStateType(machineFilePath, stateName, stateType) {
  const parsed = parseMachineFile(machineFilePath)
  if (!parsed) return ''
  let { source, ast } = parsed

  const found = findMachineStatesObj(ast)
  if (!found) return ''
  const stateProp = findStateProp(found.statesObj, stateName)
  if (!stateProp || stateProp.value?.type !== 'ObjectExpression') return ''

  const stateConfig = stateProp.value
  const typeProp = stateConfig.properties.find(p => p.key?.name === 'type' || p.key?.value === 'type')

  if (!stateType) {
    // Remove type prop if present
    if (typeProp) {
      let ls = typeProp.start; while (ls > 0 && source[ls - 1] !== '\n') ls--
      let le = typeProp.end
      if (source[le] === ',') le++
      if (source[le] === '\r') le++
      if (source[le] === '\n') le++
      source = source.slice(0, ls) + source.slice(le)
      fs.writeFileSync(machineFilePath, source, 'utf-8')
    }
    return `${stateName}: { /* atomic */ }`
  }

  if (typeProp) {
    source = source.slice(0, typeProp.value.start) + `'${stateType}'` + source.slice(typeProp.value.end)
  } else {
    const ins = stateConfig.start + 1
    const sep = stateConfig.properties.length > 0 ? '\n      ' : '\n      '
    source = source.slice(0, ins) + `${sep}type: '${stateType}',` + source.slice(ins)
  }
  fs.writeFileSync(machineFilePath, source, 'utf-8')
  return `${stateName}: { type: '${stateType}' }`
}

/**
 * Set `entry:` and `exit:` action arrays on a named state.
 * @param {string} machineFilePath
 * @param {string} stateName
 * @param {string[]} entry  - action names
 * @param {string[]} exit   - action names
 * @returns {string} snippet
 */
export function setMachineStateActions(machineFilePath, stateName, entry, exit) {
  const parsed = parseMachineFile(machineFilePath)
  if (!parsed) return ''
  let { source, ast } = parsed

  function buildActionVal(names) {
    if (!names || names.length === 0) return null
    return names.length === 1 ? `'${names[0]}'` : `[${names.map(n => `'${n}'`).join(', ')}]`
  }

  function applyProp(src, stateConfig, keyName, val) {
    // Re-parse to get fresh positions after prior mutations
    let freshAst
    try { freshAst = babelParse(src, { sourceType: 'module', plugins: ['typescript','jsx'], errorRecovery: true }) } catch { return src }
    const freshFound = findMachineStatesObj(freshAst)
    if (!freshFound) return src
    const freshStateProp = findStateProp(freshFound.statesObj, stateName)
    if (!freshStateProp || freshStateProp.value?.type !== 'ObjectExpression') return src
    const freshConfig = freshStateProp.value
    const existingProp = freshConfig.properties.find(p => p.key?.name === keyName || p.key?.value === keyName)

    if (existingProp) {
      if (val === null) {
        let ls = existingProp.start; while (ls > 0 && src[ls - 1] !== '\n') ls--
        let le = existingProp.end
        if (src[le] === ',') le++
        if (src[le] === '\r') le++
        if (src[le] === '\n') le++
        return src.slice(0, ls) + src.slice(le)
      }
      return src.slice(0, existingProp.value.start) + val + src.slice(existingProp.value.end)
    } else if (val !== null) {
      const ins = freshConfig.start + 1
      return src.slice(0, ins) + `\n      ${keyName}: ${val},` + src.slice(ins)
    }
    return src
  }

  const entryVal = buildActionVal(entry)
  const exitVal = buildActionVal(exit)
  source = applyProp(source, null, 'entry', entryVal)
  source = applyProp(source, null, 'exit', exitVal)
  fs.writeFileSync(machineFilePath, source, 'utf-8')

  const parts = []
  if (entryVal) parts.push(`entry: ${entryVal}`)
  if (exitVal) parts.push(`exit: ${exitVal}`)
  return `${stateName}: { ${parts.join(', ')} }`
}

/**
 * Collect all .d.ts files from an installed npm package for Monaco extra libs.
 * Returns Array<{ path: string (file:/// URI), content: string }>.
 *
 * @param {string} nodeModulesDir  - absolute path to a node_modules directory
 * @param {string} packageName     - e.g. 'xstate' or '@xstate/react'
 */
export function collectPackageTypeDefs(nodeModulesDir, packageName) {
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(packageName)) return []
  const pkgDir = path.join(nodeModulesDir, ...packageName.split('/'))
  if (!fs.existsSync(pkgDir)) return []

  let typesEntry = 'index.d.ts'
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'))
    const raw = pkgJson.types || pkgJson.typings || ''
    if (raw) { typesEntry = (raw.endsWith('.d.ts') ? raw : raw + '.d.ts').replace(/^\.\//, '') }
  } catch { /* use default */ }

  const packagePrefix = `file:///node_modules/${packageName}`
  const files = []

  if (typesEntry !== 'index.d.ts') {
    const shimTarget = typesEntry.replace(/\.d\.ts$/, '')
    files.push({
      path: `${packagePrefix}/index.d.ts`,
      content: `export * from './${shimTarget}';\nexport { default } from './${shimTarget}';`,
    })
  }

  function walk(dir, depth) {
    if (depth > 6 || files.length > 200) return
    let entries
    try { entries = fs.readdirSync(dir) } catch { return }
    for (const entry of entries) {
      if (entry === 'node_modules') continue
      const full = path.join(dir, entry)
      let stat; try { stat = fs.statSync(full) } catch { continue }
      if (stat.isDirectory()) { walk(full, depth + 1) }
      else if (entry.endsWith('.d.ts')) {
        const rel = path.relative(pkgDir, full).replace(/\\/g, '/')
        try { files.push({ path: `${packagePrefix}/${rel}`, content: fs.readFileSync(full, 'utf-8') }) } catch { /* skip */ }
      }
    }
  }
  walk(pkgDir, 0)
  return files
}
