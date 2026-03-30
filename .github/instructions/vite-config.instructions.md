---
applyTo: "builder-app/vite.config.ts"
description: "Use when editing Vite configuration, HMR plugins, or build settings. Covers fixSourceLineNumbers, loginAppHmrNotify, and /@fs/ import setup."
---

# Vite Configuration Guide

## Custom Plugins

### `fixSourceLineNumbers()` (enforce: 'post', dev only)
Corrects `_debugSource.lineNumber` values that are shifted by the fast-refresh wrapper.
- Detects offset from `prevRefreshReg` (19) or `RefreshRuntime` (3) markers
- Regex-replaces `lineNumber: N` → `lineNumber: N - offset` in `__source` objects
- Must run after esbuild (enforce: 'post') to see the final transformed code

### `loginAppHmrNotify()` (dev only)
Watches `login-app/src/` for file changes and sends `login-app:update` custom HMR events.
- `ComponentLoader.tsx` listens for this event and clears its lazy-import cache
- Enables live preview of login-app changes without full page reload

## Key Config

- **`__LOGIN_APP_PAGES_DIR__`** / **`__LOGIN_APP_COMPONENTS_DIR__`** — define'd constants with forward-slash absolute paths for `/@fs/` dynamic imports
- **`@login-app` alias** — resolves to `../login-app/src` for direct source imports
- **`server.fs.allow: ['..']`** — allows serving files from the monorepo root (needed for `/@fs/` imports)
- **Proxy** — `/__source*` and `/__diagnostics` proxied to Express on port 3001
