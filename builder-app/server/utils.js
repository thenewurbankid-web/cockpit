/**
 * Shared utilities for the builder dev server.
 */
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
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
