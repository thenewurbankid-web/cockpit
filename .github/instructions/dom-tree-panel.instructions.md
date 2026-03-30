---
applyTo: "builder-app/src/tree/**"
description: "Use when editing DOMTreePanel.tsx, expressionRewriter.ts, or tree-related code. Covers fiber-based DOM tree building, mixed tree (component + DOM nodes), picker mode, and node selection."
---

# DOMTreePanel Development Guide

## Tree Architecture

The tree panel builds a mixed component+DOM tree from live React fiber data:

1. **`buildRawDomTree(root)`** — walks DOM children recursively, attaches `ElementSourceInfo` from fiber `_debugSource`
2. **`toMixedTree(rawNode)`** — inserts synthetic component nodes when `ownerComponentName` changes between parent/child, creating the React hierarchy view
3. **`inferPageRoot(rawRoots)`** — finds the top-level page/component root from fiber metadata
4. **`buildMixedTree(root)`** — orchestrates the above, wraps in a page-root component node

## Node Types

```typescript
type DisplayNode = DisplayDomNode | DisplayComponentNode

interface DisplayDomNode {
  kind: 'dom'
  el: Element           // live DOM reference
  tag: string
  sourceInfo: ElementSourceInfo | null
  children: DisplayNode[]
}

interface DisplayComponentNode {
  kind: 'component'
  name: string          // e.g. "Input", "LoginPage"
  file: string          // component definition file
  line: number
  usageFile?: string    // where <Component> is used in parent source
  usageLine?: number
  children: DisplayNode[]
}
```

## Node Selection

`handleSelect(node)` handles both node types:

- **Component node**: calls `onLocate(file, line, 'file', name)` + sets `onNodeSelect` with `ownerFile`/`ownerLine` from `usageFile`/`usageLine`
- **DOM node**: reads fiber `sourceInfo` → calls `onLocate(file, line, 'node')` + sets `onNodeSelect` with fiber `ownerFile`/`ownerLine`

## Picker Mode

- Toggle button (⊕) in tree header sets `pickerMode` state
- `pickerModeRef` synced for use in event handlers
- Canvas `mousedown` (capture phase) intercepts clicks when `pickerMode` or Alt is held
- Canvas `mousemove` shows orange outline on hover (no Alt needed in picker mode)
- Picker uses `handleSelectRef` to call the full `handleSelect` flow

## Event Handler Constraints

- `useLocator.ts` registers a capture-phase `click` listener with `stopPropagation()` on `window`
- Canvas must use `mousedown` (not `click`) to avoid being blocked
- Picker mode adds a capture-phase click blocker to prevent default behavior

## Expression Nodes

Expression components (IfExpression, LoopExpression, etc.) are detected in the tree and get special handling:
- `exprProps` stored on component nodes for known expressions
- Clicking an expression node triggers `onExpressionNodeClick` instead of normal selection
