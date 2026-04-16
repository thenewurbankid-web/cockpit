// Shared DOM highlight utility for the builder dev-tool.
// All three panels (tree, scope pills, canvas hover) call into this module
// so they can highlight/unhighlight DOM elements without prop-drilling.
//
// Implementation: an absolutely-positioned overlay <div> is appended to
// document.body in the target document, OUTSIDE the #root element that the
// RAF loop monitors via innerHTML.  This means hovering nodes never mutates
// canvasEl.innerHTML and never triggers a spurious tree rebuild / flicker.

let currentEl: Element | null = null
let overlayEl: HTMLElement | null = null

const OVERLAY_STYLE = [
  'position:fixed',
  'pointer-events:none',
  'z-index:2147483647',
  'box-sizing:border-box',
  'outline:2px solid #fab387',
  'outline-offset:2px',
  'display:none',
].join(';')

function getOverlay(doc: Document): HTMLElement {
  if (!overlayEl || overlayEl.ownerDocument !== doc) {
    overlayEl?.remove()
    overlayEl = doc.createElement('div')
    overlayEl.setAttribute('data-cockpit-hl', '1')
    overlayEl.style.cssText = OVERLAY_STYLE
    doc.body.appendChild(overlayEl)
  }
  return overlayEl
}

/** Highlight a specific Element reference directly. */
export function highlightElement(el: Element | null): void {
  if (!el) {
    if (overlayEl) overlayEl.style.display = 'none'
    currentEl = null
    return
  }
  currentEl = el
  const doc = el.ownerDocument
  if (!doc?.body) return
  const overlay = getOverlay(doc)
  const rect = el.getBoundingClientRect()
  overlay.style.top = `${rect.top}px`
  overlay.style.left = `${rect.left}px`
  overlay.style.width = `${rect.width}px`
  overlay.style.height = `${rect.height}px`
  overlay.style.display = 'block'
}

/** Remove any active highlight. */
export function clearHighlight(): void {
  if (overlayEl) overlayEl.style.display = 'none'
  currentEl = null
}
