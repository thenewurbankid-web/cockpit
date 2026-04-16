import { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { ComponentLoader, notifyPreviewRefresh } from './ComponentLoader'
// Load the target project's CSS (same virtual module as the builder uses).
import 'virtual:cockpit-css'

const params = new URLSearchParams(window.location.search)
const page = params.get('page') ?? ''
const pagesDir = params.get('pagesDir') ?? ''
const componentsDir = params.get('componentsDir') ?? ''
const componentPath = params.get('componentPath') ?? undefined
const section = (params.get('section') ?? 'pages') as 'pages' | 'components'
const layoutComponent = params.get('layoutComponent') ?? undefined
const layoutsDir = params.get('layoutsDir') ?? undefined
const layoutComponentPath = params.get('layoutComponentPath') ?? undefined

// When the active project's CSS settings change (e.g. project switch or
// Settings panel save), the Vite cockpitCssInjector sends this HMR event.
// Reloading the iframe re-imports virtual:cockpit-css with fresh content.
if (import.meta.hot) {
  import.meta.hot.on('cockpit:css-changed', () => {
    location.reload()
  })
}

/** After a component mounts/remounts with fixture props, scan DOM inputs and
 *  fill any whose type/name/id/placeholder matches a fixture key.
 *  This handles components that drive form fields via internal state rather
 *  than through the prop being rendered directly on the input's `value`. */
function fillInputsFromFixture(props: Record<string, unknown>) {
  const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set

  const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
  inputs.forEach(el => {
    const type = (el as HTMLInputElement).type?.toLowerCase() ?? 'text'
    const name = (el.name ?? el.id ?? '').toLowerCase()
    const placeholder = (el.getAttribute('placeholder') ?? '').toLowerCase()

    // Find the best-matching fixture key for this input.
    let matchKey: string | null = null
    for (const key of Object.keys(props)) {
      const k = key.toLowerCase()
      // Exact: name/id matches key, OR input type === key (e.g. type="email" → "email")
      if (name === k || type === k) { matchKey = key; break }
    }
    if (!matchKey) {
      // Fuzzy: name/id or placeholder contains key
      for (const key of Object.keys(props)) {
        const k = key.toLowerCase()
        if (name.includes(k) || placeholder.includes(k)) { matchKey = key; break }
      }
    }

    if (matchKey === null || props[matchKey] === undefined || props[matchKey] === null) return

    const value = String(props[matchKey])
    // Skip if the input already shows the correct value (prop-controlled path works).
    if (el.value === value) return

    // Use the native setter so React's synthetic event system picks it up.
    const setter = el instanceof HTMLTextAreaElement ? nativeTextareaSetter : nativeInputSetter
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function PreviewApp() {
  const [fixtureProps, setFixtureProps] = useState<Record<string, unknown> | null>(null)
  const [fixtureKey, setFixtureKey] = useState(0)
  const [layoutFixtureProps, setLayoutFixtureProps] = useState<Record<string, unknown> | null>(null)
  const [layoutFixtureKey, setLayoutFixtureKey] = useState(0)

  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === 'cockpit:refresh') notifyPreviewRefresh()
      if (e.data?.type === 'cockpit:set-props') {
        setFixtureProps(e.data.props as Record<string, unknown>)
        if (e.data.reset) setFixtureKey(k => k + 1)
      }
      if (e.data?.type === 'cockpit:set-layout-props') {
        setLayoutFixtureProps(e.data.props as Record<string, unknown>)
        if (e.data.reset) setLayoutFixtureKey(k => k + 1)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // Forward uncaught runtime errors to the parent builder window so it can
  // surface them in the inspector panel without requiring a DevTools open.
  useEffect(() => {
    function sendError(message: string, stack?: string) {
      try {
        window.parent.postMessage({ type: 'cockpit:runtime-error', message, stack }, '*')
      } catch { /* cross-origin guard — should never happen (same-origin preview) */ }
    }

    function handleError(event: ErrorEvent) {
      sendError(event.message, event.error?.stack)
    }
    function handleRejection(event: PromiseRejectionEvent) {
      const reason = event.reason
      const message = reason instanceof Error ? reason.message : String(reason)
      const stack = reason instanceof Error ? reason.stack : undefined
      sendError(message, stack)
    }

    window.addEventListener('error', handleError)
    window.addEventListener('unhandledrejection', handleRejection)

    return () => {
      window.removeEventListener('error', handleError)
      window.removeEventListener('unhandledrejection', handleRejection)
    }
  }, [])

  // After the component renders with new fixture props, fill any inputs whose
  // internal state wasn't driven by the prop (fallback DOM injection path).
  useEffect(() => {
    if (!fixtureProps || Object.keys(fixtureProps).length === 0) return
    // Wait two frames: one for React to commit, one for any async renders.
    let raf1 = 0, raf2 = 0
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        fillInputsFromFixture(fixtureProps)
      })
    })
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2) }
  }, [fixtureProps, fixtureKey])

  return (
    <ComponentLoader
      page={page}
      componentName={page}
      componentPath={componentPath}
      folder={section}
      pagesDir={pagesDir}
      componentsDir={componentsDir}
      layoutsDir={layoutsDir}
      layoutComponent={layoutComponent}
      layoutComponentPath={layoutComponentPath}
      fixtureProps={fixtureProps}
      fixtureKey={fixtureKey}
      layoutProps={layoutFixtureProps}
      layoutFixtureKey={layoutFixtureKey}
    />
  )
}

const rootEl = document.getElementById('root')!
createRoot(rootEl).render(<PreviewApp />)
