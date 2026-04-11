---
applyTo: "builder-app/vite.config.ts"
description: "Use when editing Vite configuration, HMR plugins, or build settings. Covers fixSourceLineNumbers, projectHmrNotify, and /@fs/ import setup."
---

# Vite Configuration Guide

## Custom Plugins

### `fixSourceLineNumbers()` (enforce: 'post', dev only)
Corrects `_debugSource.lineNumber` values that are shifted by the fast-refresh wrapper.
- Detects offset from `prevRefreshReg` (19) or `RefreshRuntime` (3) markers
- Regex-replaces `lineNumber: N` → `lineNumber: N - offset` in `__source` objects
- Must run after esbuild (enforce: 'post') to see the final transformed code

### `projectHmrNotify()` (dev only)
Watches the active project's source directory for file changes and sends `project:update` custom HMR events.
- `ComponentLoader.tsx` listens for this event and clears its lazy-import cache
- Enables live preview of target project changes without full page reload

## Key Config

- **Dynamic aliases** — resolved via `cockpit.settings.json` through the `cockpitDynamicAlias` plugin; no static alias needed
- **`server.fs.allow: ['..']`** — allows serving files from the monorepo root (needed for `/@fs/` imports)
- **Proxy** — `/__source*` and `/__diagnostics` proxied to Express on port 3001
