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

// Receive explicit refresh signals from the parent builder frame (fired by
// notifyPreviewRefresh in ComponentLoader when InspectorPanel saves a file).
window.addEventListener('message', (e: MessageEvent) => {
  if (e.data?.type === 'cockpit:refresh') notifyPreviewRefresh()
})

// When the active project's CSS settings change (e.g. project switch or
// Settings panel save), the Vite cockpitCssInjector sends this HMR event.
// Reloading the iframe re-imports virtual:cockpit-css with fresh content.
if (import.meta.hot) {
  import.meta.hot.on('cockpit:css-changed', () => {
    location.reload()
  })
}

const rootEl = document.getElementById('root')!
createRoot(rootEl).render(
  <ComponentLoader
    page={page}
    componentName={page}
    componentPath={componentPath}
    folder={section}
    pagesDir={pagesDir}
    componentsDir={componentsDir}
  />
)
