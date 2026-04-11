/**
 * Persistent tsserver client.
 *
 * Spawns one `tsserver` process per project root and keeps it alive.
 * First request takes ~1-3s (tsserver boot + project load).
 * Subsequent requests are ~50-200ms because the program is already loaded
 * and only the changed file is re-checked.
 *
 * Protocol: https://github.com/microsoft/TypeScript/blob/main/src/server/protocol.ts
 * Each message is framed with `Content-Length: N\r\n\r\n<json>`.
 */
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const _require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

function findTsserverPath() {
  try {
    // require.resolve('typescript') → .../typescript/lib/typescript.js
    const tsMain = _require.resolve('typescript')
    return path.resolve(path.dirname(tsMain), 'tsserver.js')
  } catch {
    // Fallback: hope it's on PATH
    return 'tsserver'
  }
}

const TSSERVER_JS = findTsserverPath()

// ── one client per project root ────────────────────────────────────────────────

const clients = new Map() // projectRoot → TsServerClient

class TsServerClient {
  constructor(projectRoot) {
    this.projectRoot = projectRoot
    this.proc = null
    this.seq = 0
    /** seq → {resolve, file, syntaxDiags, semanticDiags} */
    this.pending = new Map()
    /** filePath → last content string sent to tsserver (null = disk content) */
    this.fileContents = new Map()
    this._buf = ''
    this._spawn()
  }

  // ── process management ─────────────────────────────────────────────────────

  _spawn() {
    this.proc = spawn('node', [TSSERVER_JS, '--disableAutomaticTypingAcquisition'], {
      cwd: this.projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TSS_LOG: '' },
    })
    this.proc.stdout.on('data', chunk => this._onData(chunk.toString('utf8')))
    this.proc.stderr.on('data', chunk => process.stderr.write(chunk)) // forward tsserver log output
    this.proc.on('error', err => {
      console.error('[tsserver] spawn error:', err.message)
      this._handleCrash()
    })
    this.proc.on('exit', code => {
      if (code !== 0 && code !== null) console.warn(`[tsserver] exited (code ${code})`)
      this._handleCrash()
    })
    console.log(`[tsserver] started for ${this.projectRoot}`)
  }

  _handleCrash() {
    this.proc = null
    for (const [, entry] of this.pending) {
      entry.resolve({ diagnostics: [], error: 'tsserver process exited' })
    }
    this.pending.clear()
    this.fileContents.clear()
  }

  // ── framing / parsing ──────────────────────────────────────────────────────

  _onData(raw) {
    this._buf += raw
    while (true) {
      const headerEnd = this._buf.indexOf('\r\n\r\n')
      if (headerEnd === -1) break
      const header = this._buf.slice(0, headerEnd)
      const match = header.match(/Content-Length:\s*(\d+)/)
      if (!match) { this._buf = this._buf.slice(headerEnd + 4); continue }
      const len = parseInt(match[1], 10)
      const bodyStart = headerEnd + 4
      if (this._buf.length < bodyStart + len) break
      const body = this._buf.slice(bodyStart, bodyStart + len)
      this._buf = this._buf.slice(bodyStart + len)
      try { this._handleMessage(JSON.parse(body)) } catch { /* malformed response */ }
    }
  }

  _handleMessage(msg) {
    if (msg.type !== 'event') return
    switch (msg.event) {
      case 'syntaxDiag':
      case 'semanticDiag': {
        const msgFile = msg.body?.file
        if (!msgFile) return
        const norm = msgFile.toLowerCase()
        for (const [, entry] of this.pending) {
          if (entry.file.toLowerCase() === norm) {
            const key = msg.event === 'syntaxDiag' ? 'syntaxDiags' : 'semanticDiags'
            entry[key] = msg.body.diagnostics ?? []
          }
        }
        break
      }
      case 'requestCompleted': {
        const reqSeq = msg.body?.request_seq
        const entry = this.pending.get(reqSeq)
        if (!entry) return
        this.pending.delete(reqSeq)
        const raw = [...(entry.syntaxDiags ?? []), ...(entry.semanticDiags ?? [])]
        const result = {
          diagnostics: raw.map(d => ({
            code: d.code,
            message: typeof d.text === 'string' ? d.text : JSON.stringify(d.text),
            severity: d.category === 'error' ? 8 : d.category === 'warning' ? 4 : 2,
            startLineNumber: d.start?.line ?? 1,
            startColumn: d.start?.offset ?? 1,
            endLineNumber: d.end?.line ?? 1,
            endColumn: d.end?.offset ?? 1,
          })),
          error: null,
        }
        if (result.diagnostics.length > 0) {
          console.log(`[tsserver] ${result.diagnostics.length} diagnostic(s) for ${entry.file}:`)
          for (const d of result.diagnostics) {
            console.log(`  L${d.startLineNumber}: ${d.message}`)
          }
        } else {
          console.log(`[tsserver] no errors for ${entry.file}`)
        }
        entry.resolve(result)
        break
      }
    }
  }

  _send(command, args) {
    if (!this.proc) return 0
    const seq = ++this.seq
    const msg = JSON.stringify({ seq, type: 'request', command, arguments: args })
    const frame = `Content-Length: ${Buffer.byteLength(msg, 'utf8')}\r\n\r\n${msg}`
    try { this.proc.stdin.write(frame) } catch { /* proc died */ }
    return seq
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Get TypeScript diagnostics for `filePath`, optionally using in-memory
   * `content` instead of the on-disk file.
   * Returns { diagnostics: DiagnosticItem[], error: string|null }.
   */
  async getDiagnostics(filePath, content) {
    if (!this.proc) this._spawn()

    const scriptKindName = /\.[jt]sx$/.test(filePath) ? 'TSX' : 'TS'
    const prev = this.fileContents.get(filePath) // undefined = never opened

    if (prev === undefined) {
      // First open — pass content directly if available
      const openArgs = { file: filePath, scriptKindName }
      if (content != null) openArgs.fileContent = content
      this._send('open', openArgs)
    } else if (content != null && content !== prev) {
      // Content changed — full-file replacement change
      const prevLines = prev.split('\n')
      this._send('change', {
        file: filePath,
        line: 1,
        offset: 1,
        endLine: prevLines.length,
        endOffset: prevLines[prevLines.length - 1].length + 1,
        insertString: content,
      })
    }

    this.fileContents.set(filePath, content ?? prev ?? null)

    return new Promise(resolve => {
      const seq = this._send('geterr', { files: [filePath], delay: 0 })
      if (!seq) { resolve({ diagnostics: [], error: 'tsserver not running' }); return }
      this.pending.set(seq, {
        resolve,
        file: filePath,
        syntaxDiags: [],
        semanticDiags: [],
      })
      // Safety timeout
      setTimeout(() => {
        if (this.pending.has(seq)) {
          this.pending.delete(seq)
          resolve({ diagnostics: [], error: 'tsserver timeout' })
        }
      }, 15000)
    })
  }

  dispose() {
    this._handleCrash()
    if (this.proc) { try { this.proc.stdin.end() } catch { } }
    clients.delete(this.projectRoot)
  }
}

// ── public helpers ─────────────────────────────────────────────────────────────

/** Get (or create) the persistent client for a project root. */
export function getTsServerClient(projectRoot) {
  const resolved = path.resolve(projectRoot)
  if (!clients.has(resolved)) clients.set(resolved, new TsServerClient(resolved))
  return clients.get(resolved)
}

/** Kill the client for a project root (called when user switches projects). */
export function disposeTsServerClient(projectRoot) {
  const resolved = path.resolve(projectRoot)
  const client = clients.get(resolved)
  if (client) client.dispose()
}
