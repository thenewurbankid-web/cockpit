import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'

/**
 * Vite plugin that corrects _debugSource lineNumber values injected by esbuild.
 *
 * Problem: @vitejs/plugin-react's fast-refresh wrapper prepends lines (19 for
 * functional components, 3 for class components) before the original source.
 * esbuild then transforms JSX and injects __source.lineNumber based on these
 * shifted positions, making every lineNumber too high by the wrapper size.
 *
 * Fix: run after esbuild (enforce:'post') and subtract the wrapper offset from
 * every lineNumber inside __source objects.
 */
function fixSourceLineNumbers(): Plugin {
  return {
    name: 'fix-source-line-numbers',
    enforce: 'post',
    apply: 'serve', // dev only — production builds don't include __source
    transform(code, id) {
      if (!/\.[jt]sx(\?.*)?$/.test(id)) return null
      if (!code.includes('lineNumber:')) return null

      // Detect wrapper type from markers left by @vitejs/plugin-react
      let offset = 0
      if (code.includes('prevRefreshReg')) {
        // Full fast-refresh wrapper: sharedHead (3 lines) + refreshHead (16 lines)
        offset = 19
      } else if (code.includes('RefreshRuntime')) {
        // Class-component wrapper: sharedHead only (3 lines)
        offset = 3
      }
      if (offset === 0) return null

      // Fix lineNumber values inside __source objects (fileName: "…", lineNumber: N)
      const fixed = code.replace(
        /(fileName:\s*"[^"]*",\s*lineNumber:\s*)(\d+)/g,
        (_match, prefix, num) => `${prefix}${Math.max(1, parseInt(num) - offset)}`
      )
      return fixed !== code ? fixed : null
    },
  }
}

/**
 * Vite plugin that watches project source files and sends a custom HMR event
 * so the builder-app preview can reload components loaded via /@fs/ imports.
 * Watches the entire monorepo root to cover all sibling apps; external projects
 * are auto-watched by Vite when their files are imported via /@fs/.
 */
function projectHmrNotify(): Plugin {
  return {
    name: 'project-hmr-notify',
    apply: 'serve',
    configureServer(server) {
      const monorepoRoot = path.resolve(__dirname, '..')
      server.watcher.add(monorepoRoot)
      server.watcher.on('change', (file) => {
        if (/\.[jt]sx?$/.test(file)) {
          server.ws.send({ type: 'custom', event: 'project:update', data: { file } })
        }
      })

      // ── explicit invalidation endpoint ──────────────────────────────────────
      // Called by InspectorPanel immediately after writing a file via POST /__source.
      // This bypasses the file-watcher race condition: Vite's transform cache is
      // flushed synchronously so the very next dynamic import (`?t=N`) fetches
      // fresh content from disk instead of a stale cached transform.
      server.middlewares.use('/__cockpit/invalidate', (req, res) => {
        try {
          const qs = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
          const filePath = new URLSearchParams(qs).get('file')
          if (!filePath) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'missing file param' }))
            return
          }
          // Normalise to forward slashes — Vite keys its module graph this way.
          const normalised = filePath.replace(/\\/g, '/')
          const mods = server.moduleGraph.getModulesByFile(normalised)
          let count = 0
          if (mods) {
            for (const mod of mods) {
              server.moduleGraph.invalidateModule(mod)
              count++
            }
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: true, invalidated: count }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e) }))
        }
      })
    },
    handleHotUpdate({ file, server }) {
      const builderRoot = path.resolve(__dirname)
      const monorepoRoot = path.resolve(__dirname, '..')
      const normalised = file.replace(/\\/g, '/')
      const isBuilderFile = normalised.startsWith(builderRoot.replace(/\\/g, '/'))
      const isMonorepoFile = normalised.startsWith(monorepoRoot.replace(/\\/g, '/'))

      if (!isBuilderFile && !isMonorepoFile) {
        // File is from an external project (e.g. max-ai-ui). Send our custom
        // event so ComponentLoader can refresh, but suppress Vite's default
        // handling which would fall back to a full page reload.
        server.ws.send({ type: 'custom', event: 'project:update', data: { file } })
        return []
      }
      // Let Vite handle builder-app and monorepo files normally (HMR).
    },
  }
}

/**
 * Vite plugin that injects CSS/Tailwind files from the child project into
 * the builder preview. Files are listed in cockpit.settings.json under
 * `cssFiles`.
 *
 * Returns a CSS virtual module (RESOLVED_ID ends in .css) so that Vite and
 * @tailwindcss/vite process the content through the full CSS pipeline.
 * Relative @import statements inside the CSS files are inlined so they
 * resolve correctly from the virtual module context. @source directives are
 * prepended so Tailwind v4 scans the external project's source files and
 * generates all required utility classes.
 */
function cockpitCssInjector(): Plugin {
  const VIRTUAL_ID = 'virtual:cockpit-css'
  // .css extension is required so Vite routes this through the CSS pipeline
  // (PostCSS / @tailwindcss/vite) rather than treating it as a JS module.
  const RESOLVED_ID = '\0virtual:cockpit-css.css'
  const SETTINGS_FILE = path.resolve(__dirname, '..', 'cockpit.settings.json')

  function readSettings(): { cssFiles: string[]; projectDirs: Record<string, { pagesDir?: string; componentsDir?: string }> } {
    try {
      if (!fs.existsSync(SETTINGS_FILE)) return { cssFiles: [], projectDirs: {} }
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'))
      return {
        cssFiles: Array.isArray(data.cssFiles) ? (data.cssFiles.filter((f: unknown) => typeof f === 'string' && (f as string).trim()) as string[]) : [],
        projectDirs: (typeof data.projectDirs === 'object' && data.projectDirs !== null ? data.projectDirs : {}) as Record<string, { pagesDir?: string; componentsDir?: string }>,
      }
    } catch { return { cssFiles: [], projectDirs: {} } }
  }

  // Read a CSS file and inline its relative @import './...' references one
  // level deep, so the content works in a virtual module that has no real
  // location on disk and therefore cannot resolve relative paths.
  function inlineRelativeImports(filePath: string): string {
    if (!fs.existsSync(filePath)) return `/* css file not found: ${filePath} */`
    let content = fs.readFileSync(filePath, 'utf-8')
    const basedir = path.dirname(filePath)
    content = content.replace(/@import\s+(['"])(\.\/[^'"]+)\1\s*;?/g, (_match, _q, rel) => {
      const absPath = path.resolve(basedir, rel)
      if (!fs.existsSync(absPath)) return `/* @import not resolved: ${rel} */`
      return fs.readFileSync(absPath, 'utf-8')
    })
    return content
  }

  return {
    name: 'cockpit-css-injector',
    apply: 'serve',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID
      return null
    },
    load(id) {
      if (id !== RESOLVED_ID) return null
      const { cssFiles, projectDirs } = readSettings()

      // @source directives tell Tailwind v4 to scan the external project's
      // source files for utility class detection. Without these, classes used
      // in dynamically-loaded pages (e.g. bg-success-600, container) won't be
      // emitted because Tailwind only sees builder-app files by default.
      const sourceDirs = Object.keys(projectDirs).map(root =>
        `@source "${path.join(root, 'src').replace(/\\/g, '/')}/**/*.{tsx,ts,jsx,js,html}";`
      )

      if (cssFiles.length === 0) {
        return sourceDirs.join('\n') || '/* no css configured */'
      }

      // Inline relative @import statements so CSS works in virtual module context.
      const cssContents = cssFiles.map(f => inlineRelativeImports(f))

      // Put @source directives after the css content so they appear after
      // the @import 'tailwindcss' line that globalcss includes.
      return [...cssContents, ...sourceDirs].join('\n\n')
    },
  }
}

/**
 * Vite plugin that serves static files from configured publicDirs and injects
 * Google Font (or any stylesheet) <link> tags into the page <head>.
 *
 * publicDirs — absolute paths to directories served as additional static roots.
 *   Requests like /assets/images/foo.png are resolved against each dir.
 * fontLinks  — href values for <link rel="stylesheet"> tags injected into
 *   <head> (Google Fonts API URLs, local font CSS URLs, etc.).
 *
 * Both settings are read from cockpit.settings.json on every request/transform
 * so changes take effect after a full page reload without a server restart.
 */
function cockpitAssets(): Plugin {
  const SETTINGS_FILE = path.resolve(__dirname, '..', 'cockpit.settings.json')

  const MIME: Record<string, string> = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.xml': 'application/xml',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',
  }

  function readSettings(): { publicDirs: string[]; fontLinks: string[] } {
    try {
      if (!fs.existsSync(SETTINGS_FILE)) return { publicDirs: [], fontLinks: [] }
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'))
      return {
        publicDirs: Array.isArray(data.publicDirs) ? (data.publicDirs.filter(Boolean) as string[]) : [],
        fontLinks: Array.isArray(data.fontLinks) ? (data.fontLinks.filter(Boolean) as string[]) : [],
      }
    } catch { return { publicDirs: [], fontLinks: [] } }
  }

  return {
    name: 'cockpit-assets',
    apply: 'serve',

    // Serve files from each configured publicDir as additional static roots.
    // This handles URLs like /assets/images/foo.png, /data/foo.json, etc.
    // that components reference with root-relative paths (Next.js public/ pattern).
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next()
        const { publicDirs } = readSettings()
        if (!publicDirs.length) return next()
        const urlPath = decodeURIComponent(req.url.split('?')[0])
        for (const dir of publicDirs) {
          const filePath = path.join(dir, urlPath)
          try {
            const stat = fs.statSync(filePath)
            if (stat.isFile()) {
              const ext = path.extname(filePath).toLowerCase()
              res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream')
              res.setHeader('Cache-Control', 'no-cache')
              fs.createReadStream(filePath).pipe(res)
              return
            }
          } catch { /* file does not exist — try next dir */ }
        }
        next()
      })
    },

    // Inject font preconnect + stylesheet <link> tags into index.html <head>.
    transformIndexHtml() {
      const { fontLinks } = readSettings()
      if (!fontLinks.length) return []

      // Only emit preconnect tags if we have Google Fonts links.
      const hasGoogleFonts = fontLinks.some(l => l.includes('fonts.googleapis.com') || l.includes('fonts.gstatic.com'))
      const preconnects = hasGoogleFonts
        ? [
            { tag: 'link' as const, attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' }, injectTo: 'head' as const },
            { tag: 'link' as const, attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }, injectTo: 'head' as const },
          ]
        : []

      const stylesheets = fontLinks.map(href => ({
        tag: 'link' as const,
        attrs: { rel: 'stylesheet', href },
        injectTo: 'head' as const,
      }))

      return [...preconnects, ...stylesheets]
    },
  }
}

/**
 * Vite plugin that intercepts Next.js-specific imports and provides
 * browser-safe stubs so components using next/navigation, next/router,
 * next/link, next/image etc. render without throwing in the Cockpit preview.
 */
function nextJsStubs(): Plugin {
  const VIRTUAL_PREFIX = '\0next-stub:'

  // Stub source code keyed by module specifier.
  const stubs: Record<string, string> = {
    'next/navigation': `
import { useState, useEffect } from 'react'
export function useRouter() {
  return { push: () => {}, replace: () => {}, back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {}, pathname: '/' }
}
export function usePathname() { return '/' }
export function useSearchParams() {
  const params = new URLSearchParams()
  params.get = () => null
  return params
}
export function useParams() { return {} }
export function redirect() {}
export function notFound() {}
export function useSelectedLayoutSegment() { return null }
export function useSelectedLayoutSegments() { return [] }
`,
    'next/router': `
export function useRouter() {
  return { push: () => {}, replace: () => {}, back: () => {}, query: {}, pathname: '/', asPath: '/', isReady: true }
}
`,
    'next/link': `
import React from 'react'
export default function Link({ href, children, ...rest }) {
  return React.createElement('a', { href: typeof href === 'string' ? href : href?.pathname ?? '#', ...rest }, children)
}
`,
    'next/image': `
import React from 'react'
export default function Image({ src, alt, width, height, fill, style, className, ...rest }) {
  const s = fill ? { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', ...style } : style
  return React.createElement('img', { src, alt, width, height, style: s, className, ...rest })
}
`,
    'next/head': `
import React from 'react'
export default function Head({ children }) { return null }
`,
    'next/headers': `
export function headers() { return new Headers() }
export function cookies() { return { get: () => undefined, getAll: () => [], has: () => false } }
`,
    'next/cache': `
export function unstable_cache(fn) { return fn }
export function revalidatePath() {}
export function revalidateTag() {}
`,
  }

  return {
    name: 'next-js-stubs',
    apply: 'serve',
    resolveId(id) {
      if (stubs[id]) return VIRTUAL_PREFIX + id
      return null
    },
    load(id) {
      if (id.startsWith(VIRTUAL_PREFIX)) {
        const mod = id.slice(VIRTUAL_PREFIX.length)
        return stubs[mod] ?? ''
      }
      return null
    },
  }
}

/**
 * Vite plugin that reads cockpit.settings.json at resolve time and applies
 * path aliases for external projects (e.g. "@" → "/path/to/project/src").
 * Because it reads the file on every resolution, changes take effect after
 * a full page reload without restarting the dev server.
 */
function cockpitDynamicAlias(): Plugin {
  const SETTINGS_FILE = path.resolve(__dirname, '..', 'cockpit.settings.json')

  function readSettings() {
    try {
      if (!fs.existsSync(SETTINGS_FILE)) return { aliases: {} as Record<string, string>, nodeModulesDirs: [] as string[], projectDirs: {} as Record<string, { pagesDir?: string; componentsDir?: string }> }
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'))
      return {
        aliases: typeof data.aliases === 'object' && data.aliases !== null ? data.aliases as Record<string, string> : {} as Record<string, string>,
        nodeModulesDirs: Array.isArray(data.nodeModulesDirs) ? data.nodeModulesDirs as string[] : [] as string[],
        projectDirs: typeof data.projectDirs === 'object' && data.projectDirs !== null ? data.projectDirs as Record<string, { pagesDir?: string; componentsDir?: string }> : {} as Record<string, { pagesDir?: string; componentsDir?: string }>,
      }
    } catch { return { aliases: {} as Record<string, string>, nodeModulesDirs: [] as string[], projectDirs: {} as Record<string, { pagesDir?: string; componentsDir?: string }> } }
  }

  return {
    name: 'cockpit-dynamic-alias',
    apply: 'serve',
    // Runs once at startup: tell Vite about external node_modules and pre-crawl
    // all external project pages so their deps are optimized before first load.
    // This prevents the "new dependency discovered → full page reload" cycle
    // that fires every time the user switches to a page whose packages haven't
    // been seen yet.
    config() {
      const { nodeModulesDirs, projectDirs } = readSettings()

      // Build glob entries for all configured external pages/components dirs.
      const entries: string[] = []
      for (const [root, dirs] of Object.entries(projectDirs)) {
        const pagesDir = dirs.pagesDir ?? path.join(root, 'src', 'pages')
        if (fs.existsSync(pagesDir)) entries.push(path.join(pagesDir, '**/*.tsx').replace(/\\/g, '/'))
        const componentsDir = dirs.componentsDir ?? path.join(root, 'src', 'components')
        if (fs.existsSync(componentsDir)) entries.push(path.join(componentsDir, '**/*.tsx').replace(/\\/g, '/'))
      }

      return {
        // Adding external pages as entries ensures Vite crawls them during startup
        // dep-optimization so all their imports are pre-bundled before first use.
        optimizeDeps: entries.length > 0 ? { entries } : {},
      }
    },
    async resolveId(id, importer) {
      const { aliases, nodeModulesDirs = [] } = readSettings()

      // Path alias resolution (e.g. "@" → "/path/to/src").
      // Sort longest prefix first so "@/public" wins over "@" for "@/public/foo".
      const sortedAliases = Object.entries(aliases).sort((a, b) => b[0].length - a[0].length)
      for (const [prefix, target] of sortedAliases) {
        if (id === prefix || id.startsWith(prefix + '/')) {
          const rest = id.slice(prefix.length)
          const resolved = (target + rest).replace(/\\/g, '/')
          return this.resolve(resolved, importer, { skipSelf: true })
        }
      }

      // Package resolution from project node_modules (e.g. "next/navigation")
      // Only bare module specifiers (no leading . or /)
      if (nodeModulesDirs.length > 0 && !id.startsWith('.') && !id.startsWith('/')) {
        for (const nmDir of nodeModulesDirs) {
          // id might be "next" or "next/navigation" — resolve the package root
          const pkgName = id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0]
          const pkgDir = path.join(nmDir, pkgName)
          if (fs.existsSync(pkgDir)) {
            const fullPath = path.join(nmDir, id)
            return this.resolve(fullPath, importer, { skipSelf: true })
          }
        }
      }

      return null
    },
  }
}

export default defineConfig({
  plugins: [
    // Process Tailwind v4 CSS directives (@import 'tailwindcss', @theme blocks)
    // from child-project CSS files injected via cockpitCssInjector.
    tailwindcss(),
    // The react() plugin uses esbuild for JSX transformation in automatic
    // runtime mode. esbuild injects __source (fileName, lineNumber,
    // columnNumber) on every JSX element via jsxDEV(). We read this via
    // React fiber _debugSource at runtime.
    react(),
    // Must run after esbuild to correct the line-number offset.
    fixSourceLineNumbers(),
    // Watch project files and notify the browser so the preview reloads.
    projectHmrNotify(),
    // Inject CSS/Tailwind files from the child project (from cockpit.settings.json cssFiles).
    cockpitCssInjector(),
    // Serve child-project public/ assets and inject font <link> tags into <head>.
    cockpitAssets(),
    // Stub Next.js APIs (useRouter, Link, Image, etc.) for the Vite browser preview.
    nextJsStubs(),
    // Resolve path aliases from cockpit.settings.json (e.g. "@" for external projects).
    cockpitDynamicAlias(),
  ],
  define: {
    // Polyfill Node's `process` for components (e.g. Next.js) that reference
    // process.env.* at runtime. These values are normally substituted at build
    // time by Next.js but are undefined in a raw Vite browser context.
    'process': '({ env: { NODE_ENV: "development" }, browser: true, version: "" })',
  },
  resolve: {
    alias: {
      // Lets builder-app import login-app source files directly.
      '@login-app': path.resolve(__dirname, '../login-app/src'),
    },
  },
  server: {
    port: 5174,
    // Allow serving files from anywhere on disk (needed for /@fs/ imports of external projects).
    fs: { strict: false },
    watch: {
      // Prevent Vite from triggering a full reload when the settings file is written.
      ignored: ['**/cockpit.settings.json'],
    },
    proxy: {
      // Proxy source API requests to the Express dev server.
      '/__source': 'http://localhost:3001',
      '/__diagnostics': 'http://localhost:3001',
    },
  },
})
