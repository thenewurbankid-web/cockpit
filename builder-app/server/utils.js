/**
 * Shared utilities for the builder dev server.
 */
import path from 'path'
import { fileURLToPath } from 'url'
import ts from 'typescript'

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

// ── TypeScript diagnostics ────────────────────────────────────────────────────

export function findTsConfigForFile(filePath) {
  const fromDir = path.dirname(path.resolve(filePath))
  return ts.findConfigFile(fromDir, ts.sys.fileExists, 'tsconfig.json')
}

export function formatDiagnosticMessage(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
}

function categoryToSeverity(category) {
  if (category === ts.DiagnosticCategory.Error) return 8
  if (category === ts.DiagnosticCategory.Warning) return 4
  if (category === ts.DiagnosticCategory.Suggestion) return 2
  return 1
}

export function getDiagnosticsForFile(filePath, overrideContent) {
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
