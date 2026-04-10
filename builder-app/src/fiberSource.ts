// Utility to extract source location info from React fiber internals.
//
// In development, React's JSX transform (@babel/plugin-transform-react-jsx-source,
// included by @vitejs/plugin-react) injects __source = { fileName, lineNumber,
// columnNumber } on every JSX element.  React stores this as _debugSource on the
// corresponding fiber node.  We read it here to map DOM elements back to source
// code — replacing the compile-time @locator/babel-jsx metadata injection.

// ── types ────────────────────────────────────────────────────────────────────

export interface FiberDebugSource {
  fileName: string
  lineNumber: number
  columnNumber?: number
}

export interface ElementSourceInfo {
  /** Absolute path to the source file containing the JSX that created this element. */
  file: string
  /** 1-based line number of the JSX expression. */
  line: number
  column?: number
  /** Name of the React component whose render produced this DOM element. */
  ownerComponentName: string | null
  /** Source file of the owner component (where the component function is defined). */
  ownerFile: string | null
  /** Line where the owner component's JSX invocation lives in its parent. */
  ownerLine: number | null
}

// ── fiber access ─────────────────────────────────────────────────────────────

/** Get the React fiber node attached to a DOM element (React 16+ internals). */
function getReactFiber(el: Element): any {
  for (const key of Object.keys(el)) {
    if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
      return (el as any)[key]
    }
  }
  return null
}

/** Walk up the fiber tree to find the nearest function/class component. */
function findNearestComponentFiber(fiber: any): any {
  let current = fiber?.return
  while (current) {
    if (isComponentType(current.type)) return current
    current = current.return
  }
  return null
}

/**
 * True for any fiber type that represents a user-defined component:
 * regular functions, React.forwardRef wrappers, and React.memo wrappers.
 * Previously this only checked `typeof type === 'function'`, which silently
 * skipped all forwardRef / memo components (their type is an object, not a
 * function). That caused every DOM element inside a forwardRef component
 * (e.g. ButtonRoot, ProfileSetupCardRoot) to be attributed to the nearest
 * plain-function ancestor instead.
 */
function isComponentType(type: any): boolean {
  if (!type) return false
  if (typeof type === 'function') return true
  if (typeof type === 'object') {
    const t = type.$$typeof
    // react.forward_ref — created by React.forwardRef()
    // react.memo        — created by React.memo()
    return (
      t === Symbol.for('react.forward_ref') ||
      t === Symbol.for('react.memo')
    )
  }
  return false
}

/**
 * Strip a trailing digit suffix that esbuild appends to deduplicate local
 * variable names when multiple modules in the same pre-bundle share the same
 * identifier (e.g. `ButtonRoot2` → `ButtonRoot`).  We only strip when the
 * result is still a valid PascalCase name so we do not accidentally truncate
 * intentionally-numbered component names like `Step1`.
 */
function stripEsbuildSuffix(name: string): string {
  const stripped = name.replace(/\d+$/, '')
  // Keep the stripped form only when the base itself starts with an uppercase letter
  // (i.e. it looks like a React component name), otherwise return the original.
  return stripped.length > 0 && /^[A-Z]/.test(stripped) ? stripped : name
}

/**
 * Extract the display name from a component fiber type, handling plain
 * functions, React.forwardRef wrappers, and React.memo wrappers.
 */
function getComponentName(fiber: any): string | null {
  if (!fiber?.type) return null
  const type = fiber.type
  if (typeof type === 'string') return null // host / DOM element
  if (typeof type === 'function') {
    const name = type.displayName || type.name || null
    return name ? stripEsbuildSuffix(name) : null
  }
  if (typeof type === 'object' && type !== null) {
    // forwardRef: { $$typeof, render: fn, displayName? }
    if (type.render) {
      const name = type.displayName || type.render.displayName || type.render.name || null
      return name ? stripEsbuildSuffix(name) : null
    }
    // memo: { $$typeof, type: wrappedType, displayName? }
    if (type.type) {
      const inner = type.type
      const name = type.displayName || inner.displayName || inner.name || null
      return name ? stripEsbuildSuffix(name) : null
    }
  }
  return null
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if any fiber in the ancestor chain of `el` (walking up via
 * fiber.return) is a component whose name matches `componentName`.  This is
 * more reliable than checking `ownerComponentName` on leaf elements because
 * pages that render only sub-components (e.g. pure Subframe pages) have no
 * direct DOM output — their leaf elements' ownerComponentName is a Subframe
 * component, never the page root itself.
 */
export function fiberTreeContainsComponent(el: Element, componentName: string): boolean {
  const fiber = getReactFiber(el)
  if (!fiber) return false
  let f = fiber
  while (f) {
    if (getComponentName(f) === componentName) return true
    f = f.return
  }
  return false
}

/**
 * Returns true if the element's React fiber debug source (or any ancestor's)
 * comes from the builder-app itself. Used to suppress highlighting and tree
 * display of builder UI elements when the preview canvas is empty.
 */
export function isBuilderAppElement(el: Element): boolean {
  const fiber = getReactFiber(el)
  if (!fiber) return false
  let f = fiber
  while (f) {
    const src: FiberDebugSource | undefined = f._debugSource
    if (src?.fileName && src.fileName.replace(/\\/g, '/').includes('builder-app/src/')) return true
    f = f.return
  }
  return false
}

/** Extract source location info from a DOM element via its React fiber. */
export function getElementSourceInfo(el: Element): ElementSourceInfo | null {
  const fiber = getReactFiber(el)
  if (!fiber) return null

  const source: FiberDebugSource | undefined = fiber._debugSource
  if (!source) return null

  const ownerFiber = findNearestComponentFiber(fiber)
  const ownerName = getComponentName(ownerFiber)
  const ownerSource: FiberDebugSource | undefined = ownerFiber?._debugSource

  return {
    file: source.fileName,
    line: source.lineNumber,
    column: source.columnNumber,
    ownerComponentName: ownerName,
    ownerFile: ownerSource?.fileName ?? null,
    ownerLine: ownerSource?.lineNumber ?? null,
  }
}

/**
 * Walk up from `el` (inclusive) and return the first element + source info
 * for which React fiber debug source is available.
 */
export function findNearestSourceElement(
  el: Element
): { element: Element; info: ElementSourceInfo } | null {
  let current: Element | null = el
  while (current) {
    const info = getElementSourceInfo(current)
    if (info) return { element: current, info }
    current = current.parentElement
  }
  return null
}

// ── Expression instance collection ───────────────────────────────────────────

export interface ExpressionInstance {
  name: string
  /** True when the expression's fiber has child output (renders something). */
  active: boolean
  props: Record<string, unknown>
  source: FiberDebugSource | null
  /** Nearest DOM ancestor of this expression fiber (used for tree positioning). */
  parentDomEl: Element | null
  /** First DOM child of parentDomEl that comes AFTER this expression in fiber order. Used to insert ghost nodes at the correct position. */
  nextDomSiblingEl: Element | null
}

/**
 * Walk down a fiber's child chain to find the first _debugSource entry,
 * without crossing into siblings. Used to find where a component renders
 * its own JSX (i.e., the component's definition file), as opposed to where
 * the component is *called from* (fiber._debugSource of a component fiber).
 */
function getFirstChildSource(fiber: any, maxDepth = 8): FiberDebugSource | null {
  if (!fiber || maxDepth <= 0) return null
  if (fiber._debugSource) return fiber._debugSource as FiberDebugSource
  return getFirstChildSource(fiber.child, maxDepth - 1)
}

/**
 * Walk the fiber.return chain from `el` upward and return the name of the
 * topmost component that is defined (not just called) outside builder-app/src/.
 *
 * KEY INSIGHT: a component fiber's own `_debugSource` points to where that
 * component is *used* (its JSX call site). So AlSignIn's fiber._debugSource
 * = ComponentLoader.tsx (builder-app). To find where AlSignIn is *defined*,
 * we look at fiber.child._debugSource — the first child's source reveals the
 * file where AlSignIn's own JSX body is written (SignInPage.tsx).
 */
export function findTopmostProjectComponentName(el: Element): string | null {
  const fiber = getReactFiber(el)
  if (!fiber) return null
  let f = fiber
  let topmost: string | null = null
  while (f) {
    const name = getComponentName(f)
    if (name) {
      const childSrc = getFirstChildSource(f.child)
      if (childSrc) {
        const file = childSrc.fileName.replace(/\\/g, '/')
        if (!file.includes('builder-app/src/')) {
          topmost = name // keep updating — last seen = topmost in tree
        }
      }
    }
    f = f.return
  }
  return topmost
}

function findParentDomEl(fiber: any): Element | null {
  let cur = fiber?.return
  while (cur) {
    if (typeof cur.type === 'string' && cur.stateNode instanceof Element) {
      return cur.stateNode as Element
    }
    cur = cur.return
  }
  return null
}

/**
 * DFS into a fiber subtree looking for the first DOM element whose
 * parentElement === parentDomEl. Stops at DOM host fibers to avoid
 * returning elements from deeper nesting levels.
 */
function findFirstDomChildInSubtree(fiber: any, parentDomEl: Element): Element | null {
  if (!fiber) return null
  if (typeof fiber.type === 'string' && fiber.stateNode instanceof Element) {
    if ((fiber.stateNode as Element).parentElement === parentDomEl) {
      return fiber.stateNode as Element
    }
    // Different DOM host — its children won’t be direct children of parentDomEl.
    return null
  }
  let child = fiber.child
  while (child) {
    const el = findFirstDomChildInSubtree(child, parentDomEl)
    if (el) return el
    child = child.sibling
  }
  return null
}

/**
 * Walk the fiber sibling chain starting AFTER `expressionFiber`, climbing up
 * through non-DOM intermediate fibers as needed, until we find the first DOM
 * child of `parentDomEl` that appears after the expression in render order.
 * Stops as soon as we reach the host fiber for parentDomEl.
 */
function findNextDomSiblingEl(expressionFiber: any, parentDomEl: Element): Element | null {
  let cur = expressionFiber
  while (cur) {
    let sib = cur.sibling
    while (sib) {
      const el = findFirstDomChildInSubtree(sib, parentDomEl)
      if (el) return el
      sib = sib.sibling
    }
    const parent = cur.return
    if (!parent) return null
    // Stop once we reach the host fiber that owns parentDomEl.
    if (typeof parent.type === 'string' && parent.stateNode === parentDomEl) return null
    cur = parent
  }
  return null
}

/**
 * Walk the React fiber tree rooted at `canvasEl` and return all instances of
 * expression components whose name is in `expressionNames`.
 */
export function collectExpressionInstances(
  canvasEl: Element,
): ExpressionInstance[] {
  const rootFiber = getReactFiber(canvasEl)
  if (!rootFiber) return []
  const results: ExpressionInstance[] = []

  function walk(fiber: any): void {
    if (!fiber) return
    const name = isComponentType(fiber.type) ? getComponentName(fiber) : null

    // Only track user-land components (PascalCase). Skip anonymous, lowercase,
    // and React internals (e.g. Context.Provider / Context.Consumer whose name
    // may be an empty string or contain dots).
    if (name && /^[A-Z]/.test(name) && !name.includes('.')) {
      const parentDomEl = findParentDomEl(fiber)
      results.push({
        name,
        active: fiber.child !== null,
        props: fiber.memoizedProps ?? {},
        source: fiber._debugSource ?? null,
        parentDomEl,
        nextDomSiblingEl: parentDomEl ? findNextDomSiblingEl(fiber, parentDomEl) : null,
      })
    }
    walk(fiber.child)
    walk(fiber.sibling)
  }

  walk(rootFiber.child ?? rootFiber)
  return results
}
