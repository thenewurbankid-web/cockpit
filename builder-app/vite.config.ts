import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { createRequire } from 'module'

const _require = createRequire(import.meta.url)
// Load CJS plugin via require so Babel receives the function, not a string name.
const locatorBabelPlugin = _require('@locator/babel-jsx').default

export default defineConfig({
  plugins: [
    react({
      // Only run babel on JSX/TSX files — plain .ts files have no JSX and
      // would cause the locatorjs babel plugin to fail on special characters.
      include: /\.[jt]sx$/,
      babel:
        process.env.NODE_ENV !== 'production'
          ? { plugins: [[locatorBabelPlugin, { env: 'development' }]] }
          : undefined,
    }),
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
