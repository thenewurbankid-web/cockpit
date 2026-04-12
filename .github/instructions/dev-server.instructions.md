---
applyTo: "builder-app/server/**"
description: "Use when editing devServer.js or adding new API endpoints. Covers the Express source API, path safety, and TypeScript diagnostics integration."
---

# Source API Server

## Module Structure

The server is split into focused modules under `builder-app/server/`:

| Module | Purpose |
|--------|---------|
| `utils.js` | `REPO_ROOT`, `isSafeFile()` path-traversal guard, TypeScript diagnostics (`getDiagnosticsForFile`) |
| `astInfo.js` | `extractAstInfo()` — parses files with `@babel/parser`, returns component & JSX expression metadata |
| `templates.js` | File templates (`buildPageTemplate`, `buildComponentTemplate`, `buildExpressionTemplate`) and `extractExpressionProps()` |
| `diagnosticsWorker.js` | Worker thread for running TypeScript diagnostics off the main thread |
| `devServer.js` | Express routes and server startup (~900 lines) |

## Security

All file operations use `isSafeFile(filePath)` which resolves the path and checks it starts with the monorepo root. On Windows, comparison is case-insensitive to handle drive letter casing (`d:` vs `D:`).

## Endpoints

### Core
- `GET /__source?file=<abs>` — read file as plain text
- `POST /__source` — write `{ file, content }` to disk (HMR auto-picks up changes)
- `GET /__source/diff?file=<abs>` — get stored original↔modified diff for a file
- `POST /__diagnostics` — TypeScript diagnostics for `{ file, content? }`

### Project Management
- `GET /__source/browse?path=<dir>` — browse directory tree (returns directories only)
- `GET /__source/project-info?root=<dir>` — probe a directory for React project validity, detect pages/components/expressions dirs
- `POST /__source/set-active-project` — set active project root `{ root }` and warm TypeScript cache
- `POST /__source/create-project` — scaffold a new project from template `{ name, location }`
- `POST /__source/init-project` — init `.cockpit/config.json` in an existing directory `{ root }`

### Settings
- `GET /__source/settings?root=<dir>` — read `.cockpit/config.json` for the project
- `POST /__source/settings` — write `.cockpit/config.json`

### Pages (configured pagesDir)
- `GET /__source/list-pages` — scans for directories containing `page.tsx`; `root` field = **actual exported component name** read from the AST (not the folder name); `file` = `<DirName>/page`
- `POST /__source/create-page` — creates `<ComponentName>/page.tsx` folder+file from template `{ name }`
- `DELETE /__source/page/:componentName` — deletes the entire `<ComponentName>/` directory

> **Critical**: `root` in the pages list must equal the React component name that the fiber reports. The server reads it via `extractAstInfo()` on `page.tsx`. Always use this value (not the folder name) for `rootComponentName` comparisons in the inspector and scope hierarchy.

### State Fixtures (colocated in page folder)
State fixtures live inside each page's folder, not in a global `src/states/` directory:

```
src/pages/<PageName>/states/<stateName>/data.json   ← key→value fixture data
src/pages/<PageName>/states/<stateName>/model.ts    ← auto-generated TypeScript interface
src/pages/<PageName>/states/order.json              ← custom ordering (array of state keys)
```

- `GET /__source/list-states?projectRoot=<abs>&page=<pageName>` — lists state dirs, respects `order.json`
- `GET /__source/state-data?projectRoot=<abs>&page=<pageName>&state=<key>` — reads `data.json`
- `POST /__source/state-data` — writes `data.json` + regenerates `model.ts`; body `{ projectRoot, page, state, data }`
- `POST /__source/create-state` — creates `data.json` + `model.ts`; body `{ projectRoot, page, stateName }`; `stateName` allows letters, numbers, hyphens, underscores
- `POST /__source/rename-state` — renames directory, regenerates `model.ts`; body `{ projectRoot, page, oldName, newName }`
- `POST /__source/reorder-states` — writes `order.json`; body `{ projectRoot, page, order: string[] }`
- `DELETE /__source/state?projectRoot=<abs>&page=<pageName>&state=<key>` — removes state directory

Helper: `getPageStatesDir(projectRoot, pageName)` returns `<pagesDir>/<pageName>/states` using project config.

### Components (configured componentsDir)
- `GET /__source/list-components` — lists `*.tsx` files
- `POST /__source/create-component` — creates from template
- `DELETE /__source/component/:componentName` — deletes component

### Expressions (configured expressionsDir)
- `GET /__source/list-expressions` — lists expressions with parsed props
- `POST /__source/create-expression` — creates with `{ name, props? }`
- `DELETE /__source/expression/:name` — deletes expression

### AST Info
- `GET /__source/ast-info?file=<abs>` — parses file with `@babel/parser`, returns component and JSX expression metadata

### TypeScript
- `GET /__source/tsconfig-paths?root=<dir>` — extract path aliases from project tsconfig.json
- `GET /__source/check-imports?file=<abs>` — check for unresolved imports in a file

### Package Management
- `GET /__source/project-deps?root=<dir>` — flat list of dependency names from project package.json
- `GET /__source/project-deps-full?root=<dir>` — full `{ dependencies, devDependencies }` with version strings
- `POST /__source/install-project-package` — install a package into the project via npm; body `{ packageName, root, dev? }`; responds as SSE stream (text/event-stream) with `data: <log line>` and `data: [done]` / `data: [error]`
- `POST /__source/install-package` — install a package into the builder's own node_modules; body `{ packageName }`; same SSE streaming pattern

## SSE Pattern for Install Endpoints

Install endpoints use Server-Sent Events for streaming npm output:

```js
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
// stream lines as: res.write(`data: ${line}\n\n`);
// on finish:       res.write('data: [done]\n\n'); res.end();
// on error:        res.write('data: [error]\n\n'); res.end();
```

## Adding New Endpoints

1. Define the route on `app` (Express instance)
2. Validate the file path with `isSafeFile()` before any fs operation
3. Use `path.resolve()` for path normalization
4. Return JSON responses with `{ ok: true }` on success or `{ error: string }` on failure
5. Log operations with `console.log(\`[endpoint-name] ...\`)`
