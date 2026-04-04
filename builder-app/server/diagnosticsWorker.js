/**
 * Worker thread for TypeScript diagnostics.
 *
 * All ts.createProgram calls are synchronous and CPU-heavy (~2-6s cold).
 * Running them in a worker thread keeps the main Express event loop free to
 * serve source-file reads, tree builds, and other requests concurrently.
 *
 * This worker maintains its own programCache and lastDiagResult so repeated
 * requests for the same file are served from cache (~0ms) after the first run.
 */
import { parentPort } from 'worker_threads'
import path from 'path'
import fs from 'fs'
import ts from 'typescript'

// ── helpers ───────────────────────────────────────────────────────────────────

function findTsConfigForFile(filePath) {
  return ts.findConfigFile(
    path.dirname(path.resolve(filePath)),
    ts.sys.fileExists,
    'tsconfig.json'
  )
}

function fmt(d) { return ts.flattenDiagnosticMessageText(d.messageText, '\n') }

function sev(c) {
  if (c === ts.DiagnosticCategory.Error) return 8
  if (c === ts.DiagnosticCategory.Warning) return 4
  if (c === ts.DiagnosticCategory.Suggestion) return 2
  return 1
}

// ── program cache ─────────────────────────────────────────────────────────────

const programCache = new Map() // configPath → { program }

function getBaseProgram(configPath, parsed) {
  const cached = programCache.get(configPath)
  const host = ts.createCompilerHost(parsed.options)
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    host,
    oldProgram: cached?.program,
  })
  programCache.set(configPath, { program })
  return program
}

function readParsed(configPath) {
  const cf = ts.readConfigFile(configPath, ts.sys.readFile)
  if (cf.error) return null
  const parsed = ts.parseJsonConfigFileContent(
    cf.config, ts.sys, path.dirname(configPath), undefined, configPath
  )
  return parsed.errors.length ? null : parsed
}

// ── per-file result cache ─────────────────────────────────────────────────────

const lastResult = new Map() // absFile → { content: string|null, result }

// ── diagnostics ───────────────────────────────────────────────────────────────

function diagnose(filePath, overrideContent) {
  const absFile = path.resolve(filePath)
  const contentKey = overrideContent ?? null

  const cached = lastResult.get(absFile)
  if (cached && cached.content === contentKey) return cached.result

  const configPath = findTsConfigForFile(absFile)
  if (!configPath) return { diagnostics: [], error: `No tsconfig found for ${absFile}` }

  const parsed = readParsed(configPath)
  if (!parsed) return { diagnostics: [], error: `Could not parse tsconfig: ${configPath}` }

  let program
  if (overrideContent != null) {
    const base = getBaseProgram(configPath, parsed)
    const dh = ts.createCompilerHost(parsed.options)
    const host = {
      ...dh,
      readFile(f) { return path.resolve(f) === absFile ? overrideContent : dh.readFile(f) },
      fileExists(f) { return path.resolve(f) === absFile ? true : dh.fileExists(f) },
      getSourceFile(f, lv, e) {
        return path.resolve(f) === absFile
          ? ts.createSourceFile(f, overrideContent, lv, true)
          : dh.getSourceFile(f, lv, e)
      },
    }
    program = ts.createProgram({
      rootNames: parsed.fileNames, options: parsed.options, host, oldProgram: base,
    })
  } else {
    program = getBaseProgram(configPath, parsed)
  }

  const src = program.getSourceFile(absFile)
  if (!src) return { diagnostics: [], error: `File not in project: ${absFile}` }

  const diags = [
    ...program.getSyntacticDiagnostics(src),
    ...program.getSemanticDiagnostics(src),
  ]

  const result = {
    diagnostics: diags.map(d => {
      const start = d.start ?? 0
      const s = src.getLineAndCharacterOfPosition(start)
      const e = src.getLineAndCharacterOfPosition(start + Math.max(d.length ?? 1, 1))
      return {
        code: d.code,
        message: fmt(d),
        severity: sev(d.category),
        startLineNumber: s.line + 1,
        startColumn: s.character + 1,
        endLineNumber: e.line + 1,
        endColumn: e.character + 1,
      }
    }),
    error: null,
  }

  lastResult.set(absFile, { content: contentKey, result })
  return result
}

// ── warm-up ───────────────────────────────────────────────────────────────────

function findTsConfigs(dir, maxDepth) {
  const results = []
  function walk(d, depth) {
    if (depth < 0) return
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      if (e.isDirectory()) walk(path.join(d, e.name), depth - 1)
      else if (e.name === 'tsconfig.json') results.push(path.join(d, e.name))
    }
  }
  walk(dir, maxDepth)
  return results
}

function warm(projectRoot) {
  const t0 = performance.now()
  const configs = findTsConfigs(projectRoot, 4)
  for (const configPath of configs) {
    try {
      const parsed = readParsed(configPath)
      if (parsed) getBaseProgram(configPath, parsed)
    } catch (e) {
      console.warn(`[diagnosticsWorker] warm failed for ${configPath}: ${e.message}`)
    }
  }
  console.log(`[diagnosticsWorker] warmed ${configs.length} config(s) in ${(performance.now() - t0).toFixed(0)}ms`)
}

// ── message loop ──────────────────────────────────────────────────────────────

parentPort.on('message', ({ id, type, filePath, content, projectRoot }) => {
  try {
    if (type === 'warm') {
      warm(projectRoot)
      parentPort.postMessage({ id, result: { ok: true } })
    } else {
      const result = diagnose(filePath, content)
      parentPort.postMessage({ id, result })
    }
  } catch (err) {
    parentPort.postMessage({ id, result: { diagnostics: [], error: err.message } })
  }
})
