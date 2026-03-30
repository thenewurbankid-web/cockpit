# Cockpit

A visual dev tool for inspecting and editing React component source code in real time — built for agentic development workflows where an AI agent modifies source files and a human reviews the live result.

---

## What It Does

The builder runs alongside a target React app (`login-app`) and provides:

- **Live preview** — renders the target app inside a sandboxed canvas via Vite HMR; changes to source files are reflected instantly
- **DOM + component tree** — shows a mixed React component / DOM element tree built from live React fiber data; click any node to inspect it
- **Alt+Click locator** — Alt+Click any element in the preview to jump directly to its source location
- **Picker mode** — toggle crosshair picker (⊕ button) to hover-highlight and click-select elements without holding Alt
- **Bindings inspector** — view and edit JSX attributes, component prop declarations, types, and default values; changes write back to source files immediately
- **Scope panel** — visualizes the component hierarchy with color-coded binding links between parent variables and child props (e.g. `email` state → `value` prop)
- **Monaco source editor** — full TypeScript-aware editor for the file owning the selected element, with real-time diagnostics
- **Type inference** — click ⟳ next to any type field to infer the TypeScript type from the current prop value
- **Prop management** — add props (with type + default value + usage-site binding in one action), delete props, rename values, and toggle between literal/variable binding modes
- **Expression system** — wrap JSX elements in expression components (IfExpression, LoopExpression, SwitchExpression, etc.) with a visual assign panel
- **Page/component/expression management** — create and delete pages, components, and expressions from the builder UI

---

## Repo Structure

```
cockpit/                         ← monorepo root (npm workspaces)
├── builder-app/                 ← visual builder UI (Vite 5 + React 18, port 5174)
│   ├── server/
│   │   └── devServer.js         ← Express API: source read/write, TS diagnostics, CRUD
│   ├── src/
│   │   ├── App.tsx              ← root layout (tree | canvas | inspector)
│   │   ├── fiberSource.ts       ← React fiber → source location resolver
│   │   ├── highlight.ts         ← DOM element highlight overlay
│   │   ├── preview/
│   │   │   ├── ComponentLoader.tsx       ← lazy-loads login-app via /@fs/ imports
│   │   │   ├── ExpressionAssignPanel.tsx ← expression assignment UI
│   │   │   └── ExpressionTester.tsx      ← expression testing sandbox
│   │   ├── tree/
│   │   │   ├── DOMTreePanel.tsx          ← live DOM/component tree + picker mode
│   │   │   └── expressionRewriter.ts     ← expression wrapping AST transforms
│   │   ├── locator/
│   │   │   └── useLocator.ts            ← Alt+Click → source location
│   │   └── inspector/
│   │       └── InspectorPanel.tsx       ← bindings, scope, Monaco editor, AST parsing
│   └── vite.config.ts           ← Vite config (HMR plugins, /@fs/ setup, proxy)
│
├── login-app/                   ← target app being edited (Vite 5 + React 18, port 5173)
│   └── src/
│       ├── pages/               ← full-page components (*Page.tsx)
│       ├── components/          ← shared UI components (Button, Input)
│       └── expressions/         ← expression components (IfExpression, LoopExpression, etc.)
│
├── .github/
│   ├── copilot-instructions.md  ← workspace-level AI coding instructions
│   ├── AGENTS.md                ← agent role definitions
│   └── instructions/            ← file-scoped AI instructions
│       ├── inspector-panel.instructions.md
│       ├── dom-tree-panel.instructions.md
│       ├── fiber-source.instructions.md
│       ├── dev-server.instructions.md
│       ├── login-app.instructions.md
│       └── vite-config.instructions.md
│
└── package.json                 ← npm workspaces root
```

---

## How It Works

### React Fiber Source Resolution

`fiberSource.ts` reads `_debugSource` from React fiber nodes attached to DOM elements. Every JSX element in development has `{ fileName, lineNumber }` injected by esbuild's JSX transform. We extract:

- **`file` / `line`** — where the element is defined (e.g. `Input.tsx:18`)
- **`ownerComponentName`** — the React component that rendered this element
- **`ownerFile` / `ownerLine`** — where the owner component is used in its parent's JSX

A custom Vite plugin (`fixSourceLineNumbers`) corrects a line-number offset caused by `@vitejs/plugin-react`'s fast-refresh wrapper prepending 19 lines to functional components.

### AST-Based Editing

`InspectorPanel.tsx` uses `@babel/parser` (with TypeScript + JSX plugins) to:
- Parse source files into ASTs
- Extract JSX attributes, component props, local variables, and type declarations
- Perform targeted source rewrites (value changes, prop additions, type inference)
- Build scope hierarchy with parent→child binding link tracking

All transforms are AST-based — never regex on source structure.

### Scope Hierarchy & Color-Coded Links

When you select a component or element, the scope panel shows:
1. **Parent layer** — the component that uses the selected component (e.g. LoginPage)
2. **Current layer** — the selected component itself (e.g. Input)
3. **Color-coded links** — matching colors between parent variables and child props they're bound to (e.g. green dot on `email` state ↔ green dot on `value` prop)

This is built by fetching the parent's source file using fiber `ownerFile`/`ownerLine`, parsing JSX attrs at the usage site, and computing `{ parentVar, childProp }` link pairs.

### Live Preview & HMR

`ComponentLoader.tsx` uses `React.lazy` with `/@fs/` dynamic imports to load login-app components. A custom Vite plugin (`loginAppHmrNotify`) watches login-app source files and sends HMR events that clear the lazy-import cache, enabling instant live preview of changes.

---

## Source API (Express, port 3001)

All endpoints are proxied through Vite at `/__source*`. File paths must be absolute and within the monorepo root.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/__source?file=<abs-path>` | Read file as plain text |
| `POST` | `/__source` | Write `{ file, content }` to disk |
| `POST` | `/__diagnostics` | TypeScript diagnostics for `{ file, content? }` |
| `GET` | `/__source/ast-info?file=<path>` | AST component/expression metadata |
| `GET` | `/__source/list-pages` | List pages |
| `POST` | `/__source/create-page` | Create page `{ name }` |
| `DELETE` | `/__source/page/:name` | Delete page |
| `GET` | `/__source/list-components` | List components |
| `POST` | `/__source/create-component` | Create component `{ name }` |
| `DELETE` | `/__source/component/:name` | Delete component |
| `GET` | `/__source/list-expressions` | List expressions (with parsed props) |
| `POST` | `/__source/create-expression` | Create expression `{ name, props? }` |
| `DELETE` | `/__source/expression/:name` | Delete expression |

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+ (workspaces support)

### Install

```bash
npm install
```

### Run

Open **two terminals**:

```bash
# Terminal 1 — target app on port 5173
npm run dev:login

# Terminal 2 — builder UI + source API on ports 5174 / 3001
npm run dev:builder
```

Then open **http://localhost:5174** in your browser.

> Both dev servers must be running — the builder imports login-app source directly.

### Build

```bash
npm run build:login
npm run build:builder
```

---

## Agentic Development Workflow

Cockpit is designed as a **human-in-the-loop** tool for AI-assisted React development:

1. **Agent writes source files** — AI agents edit `login-app/src/**` files directly, or via `POST /__source`
2. **Builder shows live result** — the preview canvas reflects every file change via HMR
3. **Human inspects and corrects** — click any element to see its props, types, scope bindings; adjust values without touching source directly
4. **Agent reads current state** — `GET /__source?file=<path>` reads back current source before further edits
5. **Diagnostics gate broken code** — `POST /__diagnostics` checks TypeScript errors before writing

### Source API for Agents

```bash
# Read a file
curl "http://localhost:3001/__source?file=/abs/path/to/Component.tsx"

# Write a file
curl -X POST http://localhost:3001/__source \
  -H "Content-Type: application/json" \
  -d '{"file":"/abs/path/to/Component.tsx","content":"..."}'

# Check TypeScript diagnostics before writing
curl -X POST http://localhost:3001/__diagnostics \
  -H "Content-Type: application/json" \
  -d '{"file":"/abs/path/to/Component.tsx","content":"..."}'

# Create a new page
curl -X POST http://localhost:3001/__source/create-page \
  -H "Content-Type: application/json" \
  -d '{"name":"Settings"}'

# Create a new component
curl -X POST http://localhost:3001/__source/create-component \
  -H "Content-Type: application/json" \
  -d '{"name":"Card"}'
```

---

## AI Instruction Files

The `.github/` directory contains instruction files that help AI coding agents understand the codebase:

| File | Scope |
|------|-------|
| `copilot-instructions.md` | Workspace-wide: architecture, conventions, patterns |
| `AGENTS.md` | Agent role definitions (builder-dev, login-app-dev, api-dev) |
| `instructions/inspector-panel.instructions.md` | InspectorPanel AST parsing, scope hierarchy |
| `instructions/dom-tree-panel.instructions.md` | DOMTreePanel fiber tree, picker mode |
| `instructions/fiber-source.instructions.md` | Fiber source resolution, line offsets |
| `instructions/dev-server.instructions.md` | Express API endpoints, path safety |
| `instructions/login-app.instructions.md` | Target app conventions, templates |
| `instructions/vite-config.instructions.md` | Vite plugins, HMR, build config |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Build / HMR | Vite 5 |
| UI framework | React 18 |
| Language | TypeScript 5 |
| AST parsing | `@babel/parser` |
| Source mapping | React fiber `_debugSource` |
| Code editor | Monaco Editor (`@monaco-editor/react`) |
| TypeScript diagnostics | `typescript` compiler API (server-side) |
| Dev API server | Express 4 |
| Monorepo | npm workspaces |
