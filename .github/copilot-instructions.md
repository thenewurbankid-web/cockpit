# Cockpit — Copilot Workspace Instructions

## Project Overview

Cockpit is a visual dev tool for inspecting and editing React component source code in real time — built for agentic development workflows. An AI agent modifies **login-app** source files and a human reviews the live result in **builder-app**.

## Monorepo Layout

```
cockpit/
├── builder-app/          ← visual builder UI (Vite 5 + React 18, port 5174)
│   ├── server/devServer.js   ← Express source API (port 3001)
│   ├── src/
│   │   ├── App.tsx               ← root layout: tree | canvas | inspector
│   │   ├── fiberSource.ts        ← React fiber → source location resolver
│   │   ├── highlight.ts          ← DOM element highlight overlay
│   │   ├── inspector/InspectorPanel.tsx  ← bindings, scope, Monaco editor, AST parsing
│   │   ├── tree/DOMTreePanel.tsx         ← live DOM/component tree panel
│   │   ├── tree/expressionRewriter.ts    ← expression wrapping AST transforms
│   │   ├── locator/useLocator.ts         ← Alt+Click → source location
│   │   └── preview/
│   │       ├── ComponentLoader.tsx       ← lazy-loads login-app via /@fs/ imports
│   │       ├── ExpressionAssignPanel.tsx  ← expression assignment UI
│   │       └── ExpressionTester.tsx       ← expression testing sandbox
│   └── vite.config.ts
│
├── login-app/            ← target app being edited (Vite 5 + React 18, port 5173)
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
| `POST` | `/__diagnostics` | TypeScript diagnostics for `{ file, content? }` |
| `GET` | `/__source/ast-info?file=<path>` | AST component/expression metadata |
| `GET` | `/__source/list-pages` | List pages in login-app/src/pages/ |
| `POST` | `/__source/create-page` | Create new page `{ name }` |
| `DELETE` | `/__source/page/:name` | Delete page |
| `GET` | `/__source/list-components` | List components |
| `POST` | `/__source/create-component` | Create new component `{ name }` |
| `DELETE` | `/__source/component/:name` | Delete component |
| `GET` | `/__source/list-expressions` | List expression components |
| `POST` | `/__source/create-expression` | Create expression `{ name, props? }` |
| `DELETE` | `/__source/expression/:name` | Delete expression |

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

### Modifying InspectorPanel.tsx
This is the largest file (~4000+ lines). Key sections:
- **Interfaces** (top): `ScopeItem`, `ScopeLayer`, `SelectedNodeContext`, `JsxAttr`
- **AST helpers** (~line 170-1200): `extractJsxAttrs`, `extractOwnerProps`, `extractComponentLocals`, `inferOwnerComponentName`, `extractBlock`
- **Sub-components** (~line 2500-2900): `ScopePanel`, `ScopeItemChip`, `InfoIcon`
- **Main component logic** (~line 2900+): `refreshBindings`, effects, Monaco setup
- **Styles** (bottom): `scopeStyles`, other style objects

### Modifying DOMTreePanel.tsx
Key sections:
- **Tree building** (~line 157-340): `buildRawDomTree`, `toMixedTree`, `inferPageRoot`
- **Node selection** (~line 1290+): `handleSelect` for component and DOM nodes
- **Picker mode**: canvas mousedown handler with `pickerModeRef`

## Windows-Specific Notes

- Drive letter casing can differ (`d:` vs `D:`) — `isSafeFile()` uses case-insensitive comparison
- Use forward slashes in paths exposed to the browser (`__LOGIN_APP_PAGES_DIR__`)
- `path.resolve()` normalizes paths on Windows
