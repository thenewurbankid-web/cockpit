# Cockpit — Copilot Workspace Instructions

## Project Overview

Cockpit is a visual dev tool for inspecting and editing React component source code in real time — built for agentic development workflows. An AI agent modifies **login-app** source files and a human reviews the live result in **builder-app**.

## Monorepo Layout

```
cockpit/
├── builder-app/          ← visual builder UI (Vite 5 + React 18, port 5174)
│   ├── server/
│   │   ├── devServer.js          ← Express routes + server startup
│   │   ├── utils.js              ← REPO_ROOT, isSafeFile, TS diagnostics
│   │   ├── astInfo.js            ← AST extraction (babel parser)
│   │   ├── diagnosticsWorker.js  ← TypeScript diagnostics worker thread
│   │   └── templates.js          ← Page/Component/Expression file templates
│   ├── src/
│   │   ├── App.tsx               ← root layout: tree | canvas | inspector
│   │   ├── modals.tsx            ← AddPageModal, AddComponentModal, AddExpressionModal
│   │   ├── appStyles.ts          ← CSS-in-JS styles for App + modals
│   │   ├── fiberSource.ts        ← React fiber → source location resolver
│   │   ├── highlight.ts          ← DOM element highlight overlay
│   │   ├── ProjectPickerModal.tsx ← project selection/creation UI
│   │   ├── SettingsPanel.tsx     ← full-screen settings (tabs: typescript/packages/css/builder)
│   │   ├── inspector/
│   │   │   ├── InspectorPanel.tsx    ← main component: bindings, Monaco editor
│   │   │   ├── types.ts             ← all interfaces
│   │   │   ├── astHelpers.ts        ← AST traversal utilities
│   │   │   ├── importHelpers.ts     ← import analysis + module declarations
│   │   │   ├── jsxExtraction.ts     ← JSX attr/text parsing
│   │   │   ├── typeInference.ts     ← type inference + owner props
│   │   │   ├── astRewriters.ts      ← source rewrite operations
│   │   │   ├── ExpressionPicker.tsx  ← expression wrap UI
│   │   │   ├── ScopePanel.tsx        ← scope hierarchy + color-coded links
│   │   │   ├── InfoIcon.tsx          ← reusable SVG icon
│   │   │   └── styles.ts            ← CSS-in-JS styles
│   │   ├── tree/
│   │   │   ├── DOMTreePanel.tsx      ← main component: selection, picker mode
│   │   │   ├── types.ts             ← DisplayNode types, SelectedNodeSnapshot
│   │   │   ├── treeBuilders.ts       ← tree construction from fiber data
│   │   │   ├── helpers.ts            ← node search + path utilities
│   │   │   ├── TreeRow.tsx           ← single tree row rendering
│   │   │   ├── styles.ts            ← CSS-in-JS styles
│   │   │   └── expressionRewriter.ts ← expression wrapping AST transforms
│   │   ├── locator/useLocator.ts     ← Alt+Click → source location
│   │   └── preview/
│   │       ├── ComponentLoader.tsx       ← lazy-loads target app via /@fs/ imports
│   │       ├── ExpressionAssignPanel.tsx  ← expression assignment UI
│   │       └── ExpressionTester.tsx       ← expression testing sandbox
│   └── vite.config.ts
│
├── login-app/            ← example target app (Vite 5 + React 18, port 5173)
│   └── src/
│       ├── pages/        ← full-page components (*Page.tsx)
│       ├── components/   ← shared UI components
│       └── expressions/  ← expression components (IfExpression, LoopExpression, etc.)
│
└── package.json          ← npm workspaces root
```

## Running the Dev Environment

```bash
npm install
# Terminal 1: target app
npm run dev:login
# Terminal 2: builder UI + source API
npm run dev:builder
```

Open http://localhost:5174 to use the builder.

## Source API (Express, port 3001)

All endpoints are proxied through Vite at `/__source*`. File paths must be absolute and within the monorepo root.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/__source?file=<abs-path>` | Read file as plain text |
| `POST` | `/__source` | Write `{ file, content }` to disk |
| `GET` | `/__source/diff?file=<abs>` | Get stored original↔modified diff |
| `POST` | `/__diagnostics` | TypeScript diagnostics for `{ file, content? }` |
| `GET` | `/__source/ast-info?file=<path>` | AST component/expression metadata |
| `GET` | `/__source/browse?path=<dir>` | Browse directory tree (dirs only) |
| `GET` | `/__source/project-info?root=<dir>` | Probe a directory: validity, pages/components/expressions dirs |
| `POST` | `/__source/set-active-project` | Set active project root `{ root }`, warm TS cache |
| `GET` | `/__source/list-pages` | List pages in configured pagesDir |
| `POST` | `/__source/create-page` | Create new page `{ name }` |
| `DELETE` | `/__source/page/:name` | Delete page |
| `GET` | `/__source/list-components` | List components |
| `POST` | `/__source/create-component` | Create new component `{ name }` |
| `DELETE` | `/__source/component/:name` | Delete component |
| `GET` | `/__source/list-expressions` | List expression components |
| `POST` | `/__source/create-expression` | Create expression `{ name, props? }` |
| `DELETE` | `/__source/expression/:name` | Delete expression |
| `GET` | `/__source/settings?root=<dir>` | Read `.cockpit/config.json` for the project |
| `POST` | `/__source/settings` | Write `.cockpit/config.json` |
| `GET` | `/__source/project-deps?root=<dir>` | All dependency names from package.json |
| `GET` | `/__source/project-deps-full?root=<dir>` | Full `{ dependencies, devDependencies }` with versions |
| `POST` | `/__source/install-project-package` | Install into project via npm `{ packageName, root, dev? }` — SSE stream |
| `POST` | `/__source/create-project` | Scaffold a new project directory `{ name, location }` |
| `POST` | `/__source/init-project` | Init `.cockpit/config.json` in an existing dir `{ root }` |
| `GET` | `/__source/tsconfig-paths?root=<dir>` | Extract path aliases from tsconfig.json |
| `GET` | `/__source/check-imports?file=<abs>` | Check for unresolved imports |
| `POST` | `/__source/install-package` | Install into builder's own `node_modules` `{ packageName }` — SSE stream |

## Architecture Principles

1. **React fiber as source of truth** — DOM elements map to source via `_debugSource` on React fiber nodes (no locatorjs). `fiberSource.ts` extracts `ElementSourceInfo` including `ownerFile`/`ownerLine` for parent component tracking.

2. **AST-based editing** — `InspectorPanel.tsx` uses `@babel/parser` to parse source files and perform targeted rewrites (prop adding, value changes, type inference). Never use regex for structural source transforms.

3. **Line number offset correction** — `@vitejs/plugin-react` prepends fast-refresh wrapper lines. The `fixSourceLineNumbers()` plugin in `vite.config.ts` subtracts the offset (19 for functional components, 3 for class components).

4. **Scope hierarchy** — The scope panel builds `ScopeLayer[]` with parent→child binding links by: fetching the parent file via `ownerFile`/`ownerLine` from fiber data, parsing JSX attrs at the usage site with `extractJsxAttrs()`, and computing `links: Array<{parentVar, childProp}>`.

5. **HMR propagation** — `loginAppHmrNotify()` Vite plugin watches login-app files and sends custom HMR events. `ComponentLoader.tsx` clears its lazy-import cache on HMR.

## Coding Conventions

- **TypeScript strict mode** — both apps use TypeScript with strict settings
- **No external state management** — React `useState`/`useRef` only
- **Inline styles** — both apps use inline `style` objects (no CSS modules, no Tailwind)
- **Named exports** — components use `export function ComponentName()`, not default exports
- **Props interfaces** — every component declares a `ComponentNameProps` interface
- **`@babel/parser`** — all AST work uses `@babel/parser` with `['typescript', 'jsx']` plugins
- **Path safety** — all file operations validate paths stay inside monorepo root (`isSafeFile()`)

## Common Patterns

### Adding a new login-app page
Create `login-app/src/pages/MyPage.tsx` with named export `MyPage` and `MyPageProps` interface. The builder auto-discovers it via `list-pages`.

### Adding a new component
Create `login-app/src/components/MyComponent.tsx` with named export and props interface. Auto-discovered via `list-components`.

### Modifying InspectorPanel
The inspector is modular — find the right file in `src/inspector/`:
- **Types**: `types.ts` — interfaces like `ScopeItem`, `ScopeLayer`, `SelectedNodeContext`, `JsxAttr`
- **AST traversal**: `astHelpers.ts` — `findSmallestContainingNode`, `extractBlock`
- **JSX parsing**: `jsxExtraction.ts` — `extractJsxAttrs`, `extractJsxTextChildren`
- **Type inference**: `typeInference.ts` — `extractOwnerProps`, `extractComponentLocals`, `inferOwnerComponentName`
- **Rewriters**: `astRewriters.ts` — `rewriteAttrValue`, `insertAttr`, `addPropToOwnerSignature`
- **Sub-components**: `ScopePanel.tsx`, `ExpressionPicker.tsx`, `InfoIcon.tsx`
- **Main component**: `InspectorPanel.tsx` (~2100 lines) — `refreshBindings`, effects, Monaco setup

### Modifying DOMTreePanel
The tree panel is modular — find the right file in `src/tree/`:
- **Types**: `types.ts` — `DisplayNode`, `SelectedNodeSnapshot`, `ExpressionMeta`
- **Tree building**: `treeBuilders.ts` — `buildRawDomTree`, `toMixedTree`, `inferPageRoot`
- **Helpers**: `helpers.ts` — `findPathToEl`, `findNodeByKey`, `getNodeFile`
- **Row rendering**: `TreeRow.tsx` — single tree row component
- **Main component**: `DOMTreePanel.tsx` (~1200 lines) — selection, picker mode, context menus
  - Pages section always renders when `activeSection === 'pages'` (not gated on `pages.length > 0`)
  - The "+ Add page" button is visible even when there are no pages yet

### Modifying SettingsPanel
`SettingsPanel.tsx` is a full-screen overlay with four tabs:
- **typescript** — Path aliases (auto-detect from tsconfig)
- **packages** — Project dependency viewer (`dependencies` + `devDependencies` with versions) and add-dependency UI with dev/prod toggle; calls `project-deps-full` and `install-project-package` endpoints
- **css** — CSS/Stylesheet files, Font links, Public/Static asset directories (merged)
- **builder** — Source directory overrides (pages, components, expressions dirs)

## Windows-Specific Notes

- Drive letter casing can differ (`d:` vs `D:`) — `isSafeFile()` uses case-insensitive comparison
- Use forward slashes in paths exposed to the browser
- `path.resolve()` normalizes paths on Windows
