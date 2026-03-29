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
    if (typeof current.type === 'function') return current
    current = current.return
  }
  return null
}

function getComponentName(fiber: any): string | null {
  if (!fiber?.type) return null
  if (typeof fiber.type === 'string') return null // host / DOM element
  return fiber.type.displayName || fiber.type.name || null
}

// ── public API ───────────────────────────────────────────────────────────────

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
    const name =
      typeof fiber.type === 'function'
        ? (fiber.type.displayName || fiber.type.name || null)
        : null

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
