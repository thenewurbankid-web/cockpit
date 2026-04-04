/**
 * Shared utilities for the builder dev server.
 */
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { Worker } from 'worker_threads'

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

// ── TypeScript diagnostics (worker-thread based) ─────────────────────────────
//
// All ts.createProgram calls are synchronous and block the Node.js event loop
// for 2-6s on large projects.  Running them in a dedicated worker thread keeps
// the Express event loop free to serve source-file reads, tree builds, and
// other requests concurrently.

let _worker = null
const _pending = new Map()
let _nextId = 0

function getWorker() {
  if (_worker) return _worker
  _worker = new Worker(new URL('./diagnosticsWorker.js', import.meta.url))
  _worker.on('message', ({ id, result }) => {
    const resolve = _pending.get(id)
    if (resolve) { _pending.delete(id); resolve(result) }
  })
  _worker.on('error', (err) => {
    console.error('[diagnosticsWorker] error:', err.message)
    for (const [id, resolve] of _pending) {
      _pending.delete(id)
      resolve({ diagnostics: [], error: err.message })
    }
    _worker = null
  })
  _worker.on('exit', (code) => {
    if (code !== 0) {
      console.warn(`[diagnosticsWorker] exited with code ${code}`)
      _worker = null
    }
  })
  return _worker
}

/** Async: run TypeScript diagnostics in the worker thread (non-blocking). */
export function getDiagnosticsAsync(filePath, overrideContent) {
  return new Promise((resolve) => {
    const id = _nextId++
    _pending.set(id, resolve)
    getWorker().postMessage({ id, type: 'diagnose', filePath, content: overrideContent })
  })
}

/** Pre-warm the worker's TypeScript program cache for the project (fire-and-forget). */
export function warmDiagnosticsCache(projectRoot) {
  const id = _nextId++
  _pending.set(id, () => {}) // fire-and-forget — result is ignored
  getWorker().postMessage({ id, type: 'warm', projectRoot })
}
