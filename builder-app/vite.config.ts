import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

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
 * Vite plugin that watches login-app source files and sends a custom HMR event
 * so the builder-app preview can reload components loaded via /@fs/ imports.
 */
function loginAppHmrNotify(): Plugin {
  return {
    name: 'login-app-hmr-notify',
    apply: 'serve',
    configureServer(server) {
      const loginAppSrc = path.resolve(__dirname, '../login-app/src')
      server.watcher.add(loginAppSrc)
      server.watcher.on('change', (file) => {
        const rel = path.relative(loginAppSrc, file)
        if (!rel.startsWith('..') && /\.[jt]sx?$/.test(file)) {
          server.ws.send({ type: 'custom', event: 'login-app:update', data: { file } })
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [
    // The react() plugin uses esbuild for JSX transformation in automatic
    // runtime mode. esbuild injects __source (fileName, lineNumber,
    // columnNumber) on every JSX element via jsxDEV(). We read this via
    // React fiber _debugSource at runtime.
    react(),
    // Must run after esbuild to correct the line-number offset.
    fixSourceLineNumbers(),
    // Watch login-app files and notify the browser so the preview reloads.
    loginAppHmrNotify(),
  ],
  define: {
    // Forward-slash paths exposed to the browser for /@fs/ dynamic imports.
    __LOGIN_APP_PAGES_DIR__: JSON.stringify(
      path.resolve(__dirname, '../login-app/src/pages').replace(/\\/g, '/')
    ),
    __LOGIN_APP_COMPONENTS_DIR__: JSON.stringify(
      path.resolve(__dirname, '../login-app/src/components').replace(/\\/g, '/')
    ),
  },
  resolve: {
    alias: {
      // Lets builder-app import login-app source files directly.
      '@login-app': path.resolve(__dirname, '../login-app/src'),
    },
  },
  server: {
    port: 5174,
    // Allow serving files from the whole monorepo (needed for /@fs/ imports).
    fs: { allow: ['..'] },
    proxy: {
      // Proxy source API requests to the Express dev server.
      '/__source': 'http://localhost:3001',
      '/__diagnostics': 'http://localhost:3001',
    },
  },
})
