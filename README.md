# Cockpit

A visual dev tool for inspecting and editing React component source code in real time — built for agentic development workflows where an AI agent modifies source files and a human reviews the live result.

---

## What It Does

The builder runs alongside a target React app (currently `login-app`) and provides:

- **Live preview** — renders the target app inside a sandboxed canvas via Vite HMR; changes to source files are reflected instantly
- **DOM tree panel** — shows a live component/element tree; click any node to inspect it
- **Alt+Click locator** — Alt+Click any element in the preview to jump directly to its source location
- **Bindings inspector** — view and edit JSX attributes, component prop declarations, types, and default values; changes write back to source files immediately
- **Monaco source editor** — full TypeScript-aware editor for the file owning the selected element, with real-time diagnostics via the TypeScript compiler API
- **Type inference** — click ⟳ next to any type field to infer the TypeScript type from the current prop value (literal or variable)
- **Prop management** — add props (with type + default value + usage-site binding in one action), delete props, rename values, and toggle between literal and variable binding modes

---

## Repo Structure

```
builder/                        ← monorepo root
├── builder-app/                ← the visual builder UI
│   ├── server/
│   │   └── devServer.js        ← Express API: read/write source files + TS diagnostics
│   ├── src/
│   │   ├── App.tsx             ← root layout (tree | canvas | inspector)
│   │   ├── preview/
│   │   │   └── ComponentLoader.tsx   ← lazy-loads login-app inside an error boundary
│   │   ├── tree/
│   │   │   └── DOMTreePanel.tsx      ← live DOM component tree
│   │   ├── locator/
│   │   │   └── useLocator.ts         ← Alt+Click → source location resolver
│   │   └── inspector/
│   │       └── InspectorPanel.tsx    ← bindings tab + Monaco source tab
│   └── vite.config.ts          ← Vite config (port 5174, @login-app alias, locatorjs)
│
├── login-app/                  ← target app being edited
│   └── src/
│       ├── pages/
│       │   └── LoginPage.tsx
│       └── components/
│           ├── Button.tsx
│           └── Input.tsx
│
└── package.json                ← npm workspaces root
```

---

## How It Works

### Source file API

`builder-app/server/devServer.js` runs on **port 3001** and exposes three endpoints that the inspector UI calls to read and write source files:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/__source?file=<abs-path>` | Read a source file as plain text |
| `POST` | `/__source` | Write `{ file, content }` back to disk; Vite HMR picks up the change automatically |
| `POST` | `/__diagnostics` | Run the TypeScript compiler on a file (optionally with override content) and return Monaco-formatted diagnostic markers |

All file paths are validated to stay inside the monorepo root (path-traversal guard).

### Locator injection

`@locator/babel-jsx` is applied by the Vite config to every `.jsx`/`.tsx` file at dev time. It injects:

- `data-locatorjs-id="<file>::<index>"` onto every JSX element
- `window.__LOCATOR_DATA__[file]` with expression locations and component boundaries

`useLocator.ts` reads these at click time to resolve the clicked element back to its source file + line number.

### Live preview

`ComponentLoader.tsx` uses `React.lazy` to import `LoginPage` from `login-app` via the `@login-app` path alias (resolves to `../login-app/src`). Vite HMR propagates edits made by the inspector to the preview without a full page reload.

### Inspector data flow

1. User selects a node (Alt+Click or tree click) → `selectedNode` + `location` state set in `App.tsx`
2. `InspectorPanel` fetches the source file via `GET /__source`
3. For **component nodes** (capitalised tag): `extractOwnerProps` parses the component's props interface/type + destructure pattern using `@babel/parser` to populate the Bindings tab
4. For **DOM nodes**: `extractJsxAttrs` parses the JSX attributes at the located line
5. Edits (value, type, default) are applied to the AST-derived source string using targeted rewrite functions and committed via `POST /__source`; Monaco's undo history covers all writes

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
# Terminal 1 — target app (login-app) on port 5173
npm run dev:login

# Terminal 2 — builder UI + source API on ports 5174 / 3001
npm run dev:builder
```

Then open **http://localhost:5174** in your browser.

> The builder imports `login-app` source directly — both dev servers must be running for HMR to work correctly.

### Build

```bash
npm run build:login    # build login-app
npm run build:builder  # build builder-app
```

---

## Agentic Development Workflow

The builder is designed as a **human-in-the-loop** tool for AI-assisted React development:

1. **Agent writes source files** — AI agents (e.g. GitHub Copilot, Claude) edit `login-app/src/**` files directly, or via the `POST /__source` API
2. **Builder shows live result** — the preview canvas reflects every file change via HMR with no manual refresh
3. **Human inspects and corrects** — click any element to see its props, types, and default values; adjust bindings without touching source directly
4. **Agent reads current state** — agents can `GET /__source?file=<path>` to read back the current source before making further edits, ensuring they work from the latest version
5. **Diagnostics gate broken code** — `POST /__diagnostics` lets an agent check TypeScript errors on a proposed change before writing it to disk

### Source API for agents

All file paths must be absolute and within the monorepo root.

```
# Read a file
GET http://localhost:3001/__source?file=D:/Repositories/builder/login-app/src/components/Button.tsx

# Write a file
POST http://localhost:3001/__source
Content-Type: application/json
{ "file": "D:/Repositories/builder/login-app/src/components/Button.tsx", "content": "..." }

# Check TypeScript diagnostics (optionally with proposed content before writing)
POST http://localhost:3001/__diagnostics
Content-Type: application/json
{ "file": "D:/Repositories/builder/login-app/src/components/Button.tsx", "content": "..." }
```

---

## Key Files for Contributors

| File | Purpose |
|------|---------|
| `builder-app/src/inspector/InspectorPanel.tsx` | Core inspector: AST parsing, prop rewriting, Monaco integration, all bindings UI |
| `builder-app/src/tree/DOMTreePanel.tsx` | DOM tree construction from live React fiber data |
| `builder-app/src/locator/useLocator.ts` | Alt+Click → file/line resolution |
| `builder-app/server/devServer.js` | Source file API + TypeScript diagnostics API |
| `login-app/src/pages/LoginPage.tsx` | Root component of the target app |
| `login-app/src/components/` | Shared UI components (`Button`, `Input`) |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Build / HMR | Vite 5 |
| UI framework | React 18 |
| Language | TypeScript 5 |
| AST parsing | `@babel/parser` |
| Source-map locator injection | `@locator/babel-jsx` |
| Code editor | Monaco Editor (`@monaco-editor/react`) |
| TypeScript diagnostics | `typescript` compiler API (server-side) |
| Dev API server | Express 4 |
| Monorepo | npm workspaces |
