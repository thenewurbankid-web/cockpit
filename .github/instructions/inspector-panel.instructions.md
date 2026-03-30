---
applyTo: "builder-app/src/inspector/**"
description: "Use when editing InspectorPanel.tsx or inspector-related code. Covers AST parsing, scope hierarchy, binding links, Monaco editor integration, and prop management."
---

# InspectorPanel Development Guide

## File Structure (~4000+ lines)

InspectorPanel.tsx is a large single-file module. Know the section layout before editing:

| Section | Lines (approx) | Contents |
|---------|----------------|----------|
| Interfaces | 1–170 | `ScopeItem`, `ScopeLayer`, `SelectedNodeContext`, `JsxAttr`, `ComponentProp`, `BlockRange` |
| AST helpers | 170–1200 | `extractJsxAttrs`, `extractOwnerProps`, `extractComponentLocals`, `inferOwnerComponentName`, `extractBlock`, `findSmallestContainingNode` |
| Rewrite helpers | 1200–2500 | `rewriteAttrValue`, `addPropToInterface`, `inferTypeOfLocal`, `removePropFromInterface`, JSX text child extraction |
| Sub-components | 2500–2900 | `LINK_COLORS`, `ScopePanel`, `ScopeItemChip`, `InfoIcon`, `scopeStyles` |
| Main component | 2900+ | `InspectorPanel` function: `refreshBindings`, effects, Monaco setup, event handlers |
| Styles | bottom | `scopeStyles` and other style objects |

## Key Interfaces

```typescript
interface ScopeLayer {
  componentName: string
  isCurrent: boolean
  props: ScopeItem[]
  state: ScopeItem[]
  links?: Array<{ parentVar: string; childProp: string }>  // color-coded binding links
}

interface SelectedNodeContext {
  tag: string
  locatorFile: string | null
  locatorLine: number | null
  ownerComponentName: string | null
  ownerFile?: string | null    // fiber-supplied parent file
  ownerLine?: number | null    // fiber-supplied parent line
  domAttributes: Array<{ name: string; value: string }>
}
```

## refreshBindings Flow

`refreshBindings(source, node)` is called when a node is selected or source changes. Two paths:

### Component node (capitalised tag like `Input`)
1. `extractOwnerProps(source, tag)` → child's own props
2. Sync: set initial 1-layer scope (child only)
3. Async: fetch parent file via `node.ownerFile`/`ownerLine` → `extractJsxAttrs` at usage site → `inferOwnerComponentName` → build 2-layer scope with `links`

### DOM node (lowercase tag like `input`, `div`)
1. `extractJsxAttrs(source, locLine)` → element's attrs
2. Sync: set 1-layer scope for owner component
3. Async: if owner ≠ root, fetch parent via `node.ownerFile`/`ownerLine` → same 2-layer scope build

## Scope Color Links

The `ScopePanel` computes two color maps from the child layer's `links`:
- `parentVarColor`: maps parent variable names → catppuccin color
- `childPropColor`: maps child prop names → same color

`ScopeItemChip` accepts `linkColor?: string` to render colored dot + tinted border.

## Rules

- All AST parsing uses `@babel/parser` with `['typescript', 'jsx']` plugins
- Never use regex for structural source transforms — always parse → locate → rewrite
- The `file` prop points to the component's definition file; `ownerFile`/`ownerLine` point to where it's used in its parent
- Scope layers are async — the initial render shows 1 layer, then updates to 2 when the parent fetch completes
- Monaco editor changes write back to disk via `POST /__source` and trigger HMR
