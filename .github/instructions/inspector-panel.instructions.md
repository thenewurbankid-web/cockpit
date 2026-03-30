---
applyTo: "builder-app/src/inspector/**"
description: "Use when editing InspectorPanel.tsx or inspector-related code. Covers AST parsing, scope hierarchy, binding links, Monaco editor integration, and prop management."
---

# InspectorPanel Development Guide

## Module Structure

The inspector is split into focused modules under `builder-app/src/inspector/`:

| Module | Purpose |
|--------|---------|
| `types.ts` | All interfaces: `ScopeItem`, `ScopeLayer`, `SelectedNodeContext`, `JsxAttr`, `ComponentProp`, `BlockRange`, etc. |
| `astHelpers.ts` | AST traversal: `isAstNode`, `getChildNodes`, `nodeContainsLine`, `findSmallestContainingNode`, `extractBlock`, `findNamedComponentNode` |
| `importHelpers.ts` | Import analysis: `extractImports`, `collectModuleUsages`, `buildBareModuleDeclarations`, `resolveRelativePath` |
| `jsxExtraction.ts` | JSX parsing: `extractJsxAttrs`, `extractJsxTextChildren`, `rewriteJsxTextChild`, `findLocatorUsages` |
| `typeInference.ts` | Type inference: `inferTypeFromExpression`, `inferTypeOfLocal`, `extractComponentLocals`, `extractOwnerProps`, `inferOwnerComponentName`, `enrichWithTypeDeclaration` |
| `astRewriters.ts` | Source rewriters: `rewriteAttrValue`, `removeAttr`, `insertAttr`, `addPropToOwnerSignature`, `removePropFromOwnerSignature`, `addStateVariable`, `removeStateVariable` |
| `ExpressionPicker.tsx` | `WrapExpressionChooser` and `ExpressionPickerPanel` components |
| `ScopePanel.tsx` | `ScopePanel` and `ScopeItemChip` components, `scopeStyles`, `LINK_COLORS` |
| `InfoIcon.tsx` | Reusable `InfoIcon` SVG component |
| `styles.ts` | Main CSS-in-JS styles object |
| `InspectorPanel.tsx` | Main component: `refreshBindings`, effects, Monaco setup, event handlers (~2100 lines) |

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
