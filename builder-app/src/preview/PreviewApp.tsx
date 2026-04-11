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

// When the active project's CSS settings change (e.g. project switch or
// Settings panel save), the Vite cockpitCssInjector sends this HMR event.
// Reloading the iframe re-imports virtual:cockpit-css with fresh content.
if (import.meta.hot) {
  import.meta.hot.on('cockpit:css-changed', () => {
    location.reload()
  })
}

function PreviewApp() {
  const [fixtureProps, setFixtureProps] = useState<Record<string, unknown> | null>(null)
  const [fixtureKey, setFixtureKey] = useState(0)

  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === 'cockpit:refresh') notifyPreviewRefresh()
      if (e.data?.type === 'cockpit:set-props') {
        setFixtureProps(e.data.props as Record<string, unknown>)
        if (e.data.reset) setFixtureKey(k => k + 1)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  return (
    <ComponentLoader
      page={page}
      componentName={page}
      componentPath={componentPath}
      folder={section}
      pagesDir={pagesDir}
      componentsDir={componentsDir}
      fixtureProps={fixtureProps}
      fixtureKey={fixtureKey}

    />
  )
}

const rootEl = document.getElementById('root')!
createRoot(rootEl).render(<PreviewApp />)
