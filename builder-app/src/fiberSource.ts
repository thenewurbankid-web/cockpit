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
