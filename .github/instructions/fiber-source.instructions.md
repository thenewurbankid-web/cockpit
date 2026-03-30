---
applyTo: "builder-app/src/fiberSource.ts"
description: "Use when editing fiber source resolution code. Covers React fiber _debugSource reading, line number offset correction, and ElementSourceInfo extraction."
---

# Fiber Source Resolution

## How It Works

React's JSX transform injects `__source = { fileName, lineNumber, columnNumber }` on every JSX element. React stores this as `_debugSource` on fiber nodes. We read it at runtime to map DOM elements → source files.

## Key Functions

- **`getReactFiber(el)`** — finds `__reactFiber$*` key on DOM element
- **`findNearestComponentFiber(fiber)`** — walks fiber `.return` chain to find nearest function/class component
- **`getElementSourceInfo(el)`** — returns `ElementSourceInfo` with file, line, ownerComponentName, ownerFile, ownerLine
- **`findNearestSourceElement(el)`** — walks up DOM to find first element with fiber source info

## Line Number Offset

`@vitejs/plugin-react` prepends fast-refresh wrapper lines before esbuild processes JSX. This shifts `_debugSource.lineNumber` up by:
- **19 lines** for functional components (sharedHead + refreshHead)
- **3 lines** for class components (sharedHead only)

The `fixSourceLineNumbers()` plugin in `vite.config.ts` corrects this by subtracting the offset from every `lineNumber` value in the transformed output.

## Owner vs Definition

- `file`/`line` = where the JSX element is defined (e.g. `Input.tsx:18`)
- `ownerFile`/`ownerLine` = where the owning component is **used** in its parent (e.g. `LoginPage.tsx:58` for `<Input>`)

This distinction is critical for scope hierarchy — `ownerFile`/`ownerLine` tells us where to find the parent's JSX attrs.
