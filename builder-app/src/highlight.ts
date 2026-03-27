// Shared DOM highlight utility for the builder dev-tool.
// All three panels (tree, scope pills, canvas hover) call into this module
// so they can highlight/unhighlight DOM elements without prop-drilling.

let currentEl: Element | null = null

const OUTLINE = '2px solid #fab387'
const OUTLINE_OFFSET = '2px'

function applyTo(el: Element) {
  const h = el as HTMLElement
  h.style.outline = OUTLINE
  h.style.outlineOffset = OUTLINE_OFFSET
}

function clearFrom(el: Element) {
  const h = el as HTMLElement
  h.style.outline = ''
  h.style.outlineOffset = ''
}

/** Highlight a specific Element reference directly. */
export function highlightElement(el: Element | null): void {
  if (currentEl && currentEl !== el) clearFrom(currentEl)
  currentEl = el
  if (el) applyTo(el)
}

/** Find an element by data-locatorjs-id and highlight it. */
export function highlightByLocatorId(locatorId: string | null): void {
  if (!locatorId) { highlightElement(null); return }
  const el = document.querySelector(`[data-locatorjs-id="${CSS.escape(locatorId)}"]`)
  highlightElement(el)
}

/** Remove any active highlight. */
export function clearHighlight(): void {
  highlightElement(null)
}
