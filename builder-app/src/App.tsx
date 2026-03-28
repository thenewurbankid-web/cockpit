import { useEffect, useRef, useState } from 'react'
import { ComponentLoader } from './preview/ComponentLoader'
import { InspectorPanel } from './inspector/InspectorPanel'
import type { SelectedNodeContext } from './inspector/InspectorPanel'
import { useLocator } from './locator/useLocator'
import { DOMTreePanel } from './tree/DOMTreePanel'

export type PreviewPage = string

const INITIAL_PAGES: { id: string; label: string; root: string }[] = [
  { id: 'login',            label: '🔐 Login',          root: 'LoginPage' },
  { id: 'forgot-password',  label: '🔑 Forgot Password', root: 'ForgotPasswordPage' },
  { id: 'home',             label: '🏠 Home',            root: 'HomePage' },
]

async function fetchPages(): Promise<{ id: string; label: string; root: string }[]> {
  try {
    const res = await fetch('/__source/list-pages')
    if (!res.ok) return INITIAL_PAGES
    const data = await res.json()
    return data.pages?.length ? data.pages : INITIAL_PAGES
  } catch {
    return INITIAL_PAGES
  }
}

async function fetchComponents(): Promise<{ id: string; label: string; name: string }[]> {
  try {
    const res = await fetch('/__source/list-components')
    if (!res.ok) return []
    const data = await res.json()
    return data.components ?? []
  } catch {
    return []
  }
}

export interface SourceLocation {
  file: string
  line: number
  inspectMode?: 'node' | 'component' | 'file'
  componentName?: string
}

const DEFAULT_PANEL_WIDTH = 480

/** Read the three routable params from the current URL search string. */
function readUrlState() {
  const p = new URLSearchParams(window.location.search)
  return {
    section: (p.get('section') ?? 'pages') as 'pages' | 'components',
    page: p.get('page') ?? 'login',
    component: p.get('component') ?? null,
  }
}

/** Push updated params to the URL without triggering a navigation / reload. */
function pushUrlState(section: 'pages' | 'components', page: string, component: string | null) {
  const p = new URLSearchParams()
  p.set('section', section)
  if (page) p.set('page', page)
  if (component) p.set('component', component)
  const next = `${window.location.pathname}?${p.toString()}`
  window.history.replaceState(null, '', next)
}

function readSessionJson<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch { return fallback }
}

export default function App() {
  const initial = readUrlState()
  const [location, setLocation] = useState<SourceLocation | null>(() => readSessionJson('cockpit:location', null))
  const [panelOpen, setPanelOpen] = useState(() => readSessionJson('cockpit:panelOpen', false))
  const [selectedNode, setSelectedNode] = useState<SelectedNodeContext | null>(() => readSessionJson('cockpit:selectedNode', null))
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH)
  const [activeSection, setActiveSection] = useState<'pages' | 'components'>(initial.section)
  const [previewPage, setPreviewPage] = useState<string>(initial.page)
  const [previewComponent, setPreviewComponent] = useState<string | null>(initial.component)
  const [pages, setPages] = useState(INITIAL_PAGES)
  const [addPageOpen, setAddPageOpen] = useState(false)
  const [components, setComponents] = useState<{ id: string; label: string; name: string }[]>([])
  const [addComponentOpen, setAddComponentOpen] = useState(false)

  // Persist inspector state to sessionStorage so it survives reload.
  useEffect(() => {
    sessionStorage.setItem('cockpit:location', JSON.stringify(location))
  }, [location])
  useEffect(() => {
    sessionStorage.setItem('cockpit:panelOpen', JSON.stringify(panelOpen))
  }, [panelOpen])
  useEffect(() => {
    sessionStorage.setItem('cockpit:selectedNode', JSON.stringify(selectedNode))
  }, [selectedNode])

  // Sync URL whenever the routable state changes.
  useEffect(() => {
    pushUrlState(activeSection, previewPage, previewComponent)
  }, [activeSection, previewPage, previewComponent])

  useEffect(() => {
    fetchPages().then((loaded) => {
      setPages(loaded)
      setPreviewPage((cur) => loaded.some((p) => p.id === cur) ? cur : (loaded[0]?.id ?? cur))
    })
    fetchComponents().then(setComponents)
  }, [])
  const canvasRef = useRef<HTMLDivElement>(null)

  const activePage = pages.find(p => p.id === previewPage) ?? pages[0]

  function openInspector(
    file: string,
    line: number,
    inspectMode: 'node' | 'component' | 'file' = 'node',
    componentName?: string
  ) {
    setLocation({ file, line, inspectMode, componentName })
    setPanelOpen(true)
  }

  useLocator((loc) => openInspector(loc.file, loc.line))

  async function deletePage(id: string, root: string) {
    try {
      await fetch(`/__source/page/${encodeURIComponent(root)}`, { method: 'DELETE' })
    } catch {
      // best-effort
    }
    setPages((prev) => prev.filter((p) => p.id !== id))
    if (previewPage === id) {
      const next = pages.find((p) => p.id !== id)
      setPreviewPage(next?.id ?? '')
    }
    setSelectedNode(null)
    setPanelOpen(false)
  }

  async function deleteComponent(id: string, name: string) {
    try {
      await fetch(`/__source/component/${encodeURIComponent(name)}`, { method: 'DELETE' })
    } catch {
      // best-effort
    }
    setComponents((prev) => prev.filter((c) => c.id !== id))
  }

  return (
    <div style={styles.root}>
      {/* Top bar */}
      <header style={styles.header}>
        <span style={styles.logo}>⚙ Cockpit</span>

        <div style={styles.tabs}>
          <button
            style={{ ...styles.tab, ...(activeSection === 'pages' ? styles.tabActive : {}) }}
            onClick={() => {
              setActiveSection('pages')
              if (!previewPage && pages.length > 0) setPreviewPage(pages[0].id)
            }}
          >
            Pages
          </button>
          <button
            style={{ ...styles.tab, ...(activeSection === 'components' ? styles.tabActive : {}) }}
            onClick={() => {
              setActiveSection('components')
              if (!previewComponent && components.length > 0) setPreviewComponent(components[0].name)
            }}
          >
            Components
          </button>
        </div>

        <span style={styles.hint}>Alt+Click any element — or click a node in the tree</span>
      </header>

      {/* Main area */}
      <div style={styles.main}>
        {/* Left: DOM tree */}
        <DOMTreePanel
          canvasRef={canvasRef}
          onLocate={openInspector}
          onNodeSelect={setSelectedNode}
          preferredRootComponentName={activeSection === 'components' ? (previewComponent ?? undefined) : activePage?.root}
          activeSection={activeSection}
          pages={pages}
          activePage={previewPage}
          onPageChange={(id) => {
            setPreviewPage(id)
            setActiveSection('pages')
            setSelectedNode(null)
            setPanelOpen(false)
          }}
          onAddPage={() => setAddPageOpen(true)}
          onDeletePage={deletePage}
          components={components}
          activeComponent={previewComponent ?? undefined}
          onComponentClick={(_id, name) => {
            setPreviewComponent(name)
            setActiveSection('components')
            setSelectedNode(null)
            setPanelOpen(false)
          }}
          onAddComponent={() => setAddComponentOpen(true)}
          onDeleteComponent={deleteComponent}
        />

        {/* Center: preview canvas */}
        <div
          style={{ ...styles.canvasColumn, marginRight: panelOpen ? panelWidth : 0 }}
        >
          {/* Breadcrumb sub-header */}
          <div style={styles.breadcrumb}>
            <span style={styles.breadcrumbItem}>
              {activeSection === 'pages' ? '📄 Pages' : '🧩 Components'}
            </span>
            {activeSection === 'pages' && activePage && (
              <>
                <span style={styles.breadcrumbSep}>›</span>
                <span style={styles.breadcrumbCurrent}>{activePage.root}</span>
              </>
            )}
            {activeSection === 'components' && previewComponent && (
              <>
                <span style={styles.breadcrumbSep}>›</span>
                <span style={{ ...styles.breadcrumbCurrent, color: '#cba6f7' }}>{previewComponent}</span>
              </>
            )}
          </div>

          {/* Scrollable canvas */}
          <div
            ref={canvasRef}
            style={styles.canvas}
          >
          {activeSection === 'pages' && activePage && (
            <ComponentLoader page={previewPage} componentName={activePage.root} folder="pages" />
          )}
          {activeSection === 'components' && previewComponent && (
            <ComponentLoader page={previewComponent} componentName={previewComponent} folder="components" />
          )}
          {activeSection === 'components' && !previewComponent && (
            <div style={styles.emptyState}>Select a component to preview it here.</div>
          )}
          </div>
        </div>

        {/* Right: inspector */}
        {panelOpen && location && (
          <InspectorPanel
            file={location.file}
            line={location.line}
            inspectMode={location.inspectMode}
            componentName={location.componentName}
            selectedNode={selectedNode}
            rootComponentName={activeSection === 'components' ? (previewComponent ?? activePage.root) : activePage.root}
            onClose={() => setPanelOpen(false)}
            onWidthChange={setPanelWidth}
            onNavigateToComponent={(name) => {
              setPreviewComponent(name)
              setActiveSection('components')
              setSelectedNode(null)
              setPanelOpen(false)
            }}
          />
        )}
      </div>

      {addPageOpen && (
        <AddPageModal
          onClose={() => setAddPageOpen(false)}
          onAdd={(page) => {
            setPages((prev) => [...prev, page])
            setPreviewPage(page.id)
            setAddPageOpen(false)
          }}
        />
      )}

      {addComponentOpen && (
        <AddComponentModal
          onClose={() => setAddComponentOpen(false)}
          onAdd={(comp) => {
            setComponents((prev) => [...prev, comp])
            setAddComponentOpen(false)
          }}
        />
      )}
    </div>
  )
}

// ─── Add Component Modal ─────────────────────────────────────────────────────

function toComponentNameNoSuffix(name: string): string {
  return name.trim()
    .replace(/(?:^|\s+)\w/g, (c) => c.trim().toUpperCase())
    .replace(/\s+/g, '')
}
function toCompId(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}

function AddComponentModal({
  onClose,
  onAdd,
}: {
  onClose: () => void
  onAdd: (comp: { id: string; label: string; name: string }) => void
}) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const componentName = name.trim() ? toComponentNameNoSuffix(name) : ''
  const id = name.trim() ? toCompId(name) : ''

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/__source/create-component', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create component')
      onAdd({ id: data.id, label: name.trim(), name: data.componentName })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div style={modalStyles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>New component</span>
          <button style={modalStyles.closeBtn} onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={modalStyles.body}>
          <label style={modalStyles.label}>Component name</label>
          <input
            autoFocus
            style={modalStyles.input}
            placeholder="e.g. Button"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null) }}
          />

          {name.trim() && (
            <div style={modalStyles.preview}>
              <span style={modalStyles.previewKey}>Component</span>
              <span style={modalStyles.previewVal}>{componentName}</span>
              <span style={modalStyles.previewKey}>File</span>
              <span style={modalStyles.previewVal}>{componentName}.tsx</span>
            </div>
          )}

          {error && <div style={modalStyles.error}>{error}</div>}

          <div style={modalStyles.actions}>
            <button type="button" style={modalStyles.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              style={{ ...modalStyles.submitBtn, opacity: !name.trim() || loading ? 0.5 : 1 }}
              disabled={!name.trim() || loading}
            >
              {loading ? 'Creating…' : 'Create component'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Add Page Modal ───────────────────────────────────────────────────────────

function toComponentName(name: string): string {
  return name.trim()
    .replace(/(?:^|\s+)\w/g, (c) => c.trim().toUpperCase())
    .replace(/\s+/g, '') + 'Page'
}
function toPageId(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}

function AddPageModal({
  onClose,
  onAdd,
}: {
  onClose: () => void
  onAdd: (page: { id: string; label: string; root: string }) => void
}) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const componentName = name.trim() ? toComponentName(name) : ''
  const id = name.trim() ? toPageId(name) : ''

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/__source/create-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create page')
      onAdd({ id: data.id, label: name.trim(), root: data.componentName })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div style={modalStyles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>New page</span>
          <button style={modalStyles.closeBtn} onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={modalStyles.body}>
          <label style={modalStyles.label}>Page name</label>
          <input
            autoFocus
            style={modalStyles.input}
            placeholder="e.g. Settings"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null) }}
          />

          {name.trim() && (
            <div style={modalStyles.preview}>
              <span style={modalStyles.previewKey}>Component</span>
              <span style={modalStyles.previewVal}>{componentName}</span>
              <span style={modalStyles.previewKey}>Route id</span>
              <span style={modalStyles.previewVal}>{id}</span>
            </div>
          )}

          {error && <div style={modalStyles.error}>{error}</div>}

          <div style={modalStyles.actions}>
            <button type="button" style={modalStyles.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              style={{ ...modalStyles.submitBtn, opacity: !name.trim() || loading ? 0.5 : 1 }}
              disabled={!name.trim() || loading}
            >
              {loading ? 'Creating…' : 'Create page'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

const modalStyles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  dialog: {
    background: '#1e1e2e',
    border: '1px solid #313244',
    borderRadius: 10,
    width: 360,
    boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.75rem 1rem',
    borderBottom: '1px solid #313244',
    background: '#181825',
  },
  title: { color: '#cdd6f4', fontWeight: 600, fontSize: 13, fontFamily: 'system-ui, sans-serif' },
  closeBtn: {
    background: 'none', border: 'none', color: '#6c7086', fontSize: 18,
    cursor: 'pointer', lineHeight: 1, padding: '0 2px',
  },
  body: { padding: '1rem', display: 'flex', flexDirection: 'column', gap: 10 },
  label: { color: '#9ca3af', fontSize: 11, fontFamily: 'system-ui, sans-serif' },
  input: {
    background: '#181825', border: '1px solid #45475a', borderRadius: 6,
    color: '#cdd6f4', fontSize: 13, fontFamily: 'system-ui, sans-serif',
    padding: '0.45rem 0.6rem', outline: 'none',
  },
  preview: {
    display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px',
    background: '#181825', border: '1px solid #313244', borderRadius: 6,
    padding: '0.5rem 0.6rem',
  },
  previewKey: { color: '#6c7086', fontSize: 11, fontFamily: 'system-ui, sans-serif' },
  previewVal: { color: '#a6e3a1', fontSize: 11, fontFamily: 'monospace' },
  error: {
    background: '#3b1f2e', border: '1px solid #f38ba8', borderRadius: 6,
    color: '#f38ba8', fontSize: 11, fontFamily: 'system-ui, sans-serif',
    padding: '0.4rem 0.6rem',
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  cancelBtn: {
    background: 'transparent', border: '1px solid #45475a', borderRadius: 6,
    color: '#9ca3af', fontSize: 12, fontFamily: 'system-ui, sans-serif',
    padding: '0.35rem 0.9rem', cursor: 'pointer',
  },
  submitBtn: {
    background: '#a6e3a1', border: 'none', borderRadius: 6,
    color: '#1e1e2e', fontSize: 12, fontFamily: 'system-ui, sans-serif',
    fontWeight: 700, padding: '0.35rem 0.9rem', cursor: 'pointer',
  },
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '1.5rem',
    padding: '0.6rem 1.2rem',
    background: '#16213e',
    borderBottom: '1px solid #0f3460',
    flexShrink: 0,
  },
  logo: { fontWeight: 700, fontSize: '1rem', color: '#e94560', letterSpacing: 0.5 },
  hint: { fontSize: '0.78rem', color: '#9ca3af', marginLeft: 'auto' },
  breadcrumb: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0.3rem 1.2rem',
    background: '#0d1b2e',
    borderBottom: '1px solid #0f3460',
    flexShrink: 0,
    fontFamily: 'system-ui, sans-serif',
    fontSize: '0.72rem',
  },
  breadcrumbItem: {
    color: '#6c7086',
    cursor: 'default',
  },
  breadcrumbSep: {
    color: '#45475a',
    fontSize: '0.8rem',
  },
  breadcrumbCurrent: {
    color: '#89b4fa',
    fontWeight: 600,
    fontFamily: 'monospace',
  },
  tabs: { display: 'flex', gap: 4 },
  tab: {
    background: 'transparent', border: '1px solid #1e3a5f', borderRadius: 6,
    color: '#9ca3af', fontSize: '0.75rem', fontFamily: 'system-ui, sans-serif',
    padding: '0.25rem 0.85rem', cursor: 'pointer', transition: 'all 0.15s',
  },
  tabActive: {
    background: '#1e3a5f', border: '1px solid #4a90d9',
    color: '#cdd6f4', fontWeight: 600,
  },
  emptyState: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: '100%', color: '#9ca3af', fontSize: '0.85rem',
    fontFamily: 'system-ui, sans-serif',
  },
  main: { flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' },
  canvasColumn: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    transition: 'margin-right 0.2s ease',
  },
  canvas: {
    flex: 1,
    overflow: 'auto',
    background: '#f5f5f5',
  },
}
