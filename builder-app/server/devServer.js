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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Monorepo root is one level up from builder-app/server/
const REPO_ROOT = path.resolve(__dirname, '../../')

const app = express()
app.use(express.json({ limit: '2mb' }))

/** Ensure the resolved path is inside the monorepo root (path-traversal guard). */
function isSafeFile(filePath) {
  const resolved = path.resolve(filePath)
  return resolved.startsWith(REPO_ROOT + path.sep) || resolved.startsWith(REPO_ROOT + '/')
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

const PORT = 3001
app.listen(PORT, () => {
  console.log(`[builder-server] Source API ready → http://localhost:${PORT}/__source`)
})
