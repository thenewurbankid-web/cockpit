import { useEffect, useRef, useState } from 'react'
import { ComponentLoader } from './preview/ComponentLoader'
import { ExpressionTester } from './preview/ExpressionTester'
import { InspectorPanel } from './inspector/InspectorPanel'
import type { SelectedNodeContext } from './inspector/InspectorPanel'
import { useLocator } from './locator/useLocator'
import { DOMTreePanel } from './tree/DOMTreePanel'
import type { ExpressionMeta } from './tree/DOMTreePanel'
import { ExpressionAssignPanel } from './preview/ExpressionAssignPanel'
import type { WrapIntentNode } from './preview/ExpressionAssignPanel'
import { AddPageModal, AddComponentModal, AddExpressionModal } from './modals'
import { appStyles as styles } from './appStyles'

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

async function fetchExpressions(): Promise<ExpressionMeta[]> {
  try {
    const res = await fetch('/__source/list-expressions')
    if (!res.ok) return []
    const data = await res.json()
    return data.expressions ?? []
  } catch {
    return []
  }
}

export interface SourceLocation {
  file: string
  line: number
  inspectMode?: 'node' | 'component' | 'file' | 'expression'
  componentName?: string
}

const DEFAULT_PANEL_WIDTH = 480

/** Read the three routable params from the current URL search string. */
function readUrlState() {
  const p = new URLSearchParams(window.location.search)
  return {
    section: (p.get('section') ?? 'pages') as 'pages' | 'components' | 'expressions',
    page: p.get('page') ?? 'login',
    component: p.get('component') ?? null,
  }
}

/** Push updated params to the URL without triggering a navigation / reload. */
function pushUrlState(section: 'pages' | 'components' | 'expressions', page: string, component: string | null) {
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
  const [panelOpen, setPanelOpen] = useState(() => readSessionJson('cockpit:panelOpen', true))
  const [selectedNode, setSelectedNode] = useState<SelectedNodeContext | null>(() => readSessionJson('cockpit:selectedNode', null))
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH)
  const [activeSection, setActiveSection] = useState<'pages' | 'components' | 'expressions'>(initial.section)
  const [previewPage, setPreviewPage] = useState<string>(initial.page)
  const [previewComponent, setPreviewComponent] = useState<string | null>(initial.component)
  const [pages, setPages] = useState(INITIAL_PAGES)
  const [addPageOpen, setAddPageOpen] = useState(false)
  const [components, setComponents] = useState<{ id: string; label: string; name: string }[]>([])
  const [addComponentOpen, setAddComponentOpen] = useState(false)
  const [expressions, setExpressions] = useState<ExpressionMeta[]>([])
  const [addExpressionOpen, setAddExpressionOpen] = useState(false)
  const [activeExpression, setActiveExpression] = useState<string | null>(null)
  const [wrapIntent, setWrapIntent] = useState<{ nodes: WrapIntentNode[] } | null>(null)
  const [wrapChosenExpr, setWrapChosenExpr] = useState<ExpressionMeta | null>(null)
  const [hoveredWrapKey, setHoveredWrapKey] = useState<string | null>(null)
  const [wrapCenterTab, setWrapCenterTab] = useState<'nodes' | 'preview'>('nodes')

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
    if (activeSection !== 'expressions') setActiveExpression(null)
  }, [activeSection])

  useEffect(() => {
    fetchPages().then((loaded) => {
      setPages(loaded)
      setPreviewPage((cur) => loaded.some((p) => p.id === cur) ? cur : (loaded[0]?.id ?? cur))
    })
    fetchComponents().then(setComponents)
    fetchExpressions().then(setExpressions)
  }, [])
  const canvasRef = useRef<HTMLDivElement>(null)
  // Callback bridge: InspectorPanel picker → ExpressionTester insert
  const insertTagRef = useRef<((tag: string) => void) | null>(null)

  const activePage = pages.find(p => p.id === previewPage) ?? pages[0]

  function openInspector(
    file: string,
    line: number,
    inspectMode: 'node' | 'component' | 'file' | 'expression' = 'node',
    componentName?: string
  ) {
    setLocation({ file, line, inspectMode, componentName })
    setPanelOpen(true)
    if (inspectMode === 'expression') {
      setWrapIntent(null)
      setWrapChosenExpr(null)
      setHoveredWrapKey(null)
    }
  }

  function handleExpressionSelect(expr: ExpressionMeta) {
    setActiveExpression(expr.name)
    openInspector(expr.file, 1, 'file', expr.name)
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

  async function deleteExpression(name: string) {
    try {
      await fetch(`/__source/expression/${encodeURIComponent(name)}`, { method: 'DELETE' })
    } catch {
      // best-effort
    }
    setExpressions((prev) => prev.filter((e) => e.name !== name))
  }

  return (
    <div style={styles.root}>
      {/* Top bar */}
      <header style={styles.header}>
        <span style={styles.logo}>✦ Cockpit</span>

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
          <button
            style={{ ...styles.tab, ...(activeSection === 'expressions' ? styles.tabActive : {}), ...(activeSection === 'expressions' ? { borderBottomColor: '#94e2d5', color: '#94e2d5' } : {}) }}
            onClick={() => setActiveSection('expressions')}
          >
            Expressions
          </button>
        </div>
      </header>

      {/* Main area */}
      <div style={styles.main}>
        {/* Left: DOM tree */}
        <DOMTreePanel
          canvasRef={canvasRef}
          onLocate={openInspector}
          onNodeSelect={(snapshot) => {
            setSelectedNode(snapshot)
            if (snapshot) {
              setWrapIntent(null)
              setWrapChosenExpr(null)
              setHoveredWrapKey(null)
            }
          }}
          hoveredWrapNodeKey={hoveredWrapKey}
          preferredRootComponentName={activeSection === 'components' ? (previewComponent ?? undefined) : activePage?.root}
          activeSection={activeSection}
          pages={pages}
          activePage={previewPage}
          onPageChange={(id) => {
            setPreviewPage(id)
            setActiveSection('pages')
            setSelectedNode(null)
          }}
          onAddPage={() => setAddPageOpen(true)}
          onDeletePage={deletePage}
          components={components}
          activeComponent={previewComponent ?? undefined}
          onComponentClick={(_id, name) => {
            setPreviewComponent(name)
            setActiveSection('components')
            setSelectedNode(null)
          }}
          onAddComponent={() => setAddComponentOpen(true)}
          onDeleteComponent={deleteComponent}
          expressions={expressions}
          onAddExpression={() => setAddExpressionOpen(true)}
          onDeleteExpression={deleteExpression}
          activeExpression={activeExpression ?? undefined}
          onExpressionSelect={handleExpressionSelect}
          onWrapIntent={(nodes) => {
            setWrapIntent({ nodes })
            setWrapChosenExpr(null)
            // open the right panel pointing at the first node's file
            setLocation({ file: nodes[0].file, line: 1, inspectMode: 'file' })
            setPanelOpen(true)
          }}
          onAutoSelect={(snapshot, file, line, componentName) => {
            setSelectedNode(snapshot)
            setLocation({ file, line, inspectMode: 'file', componentName })
            setPanelOpen(true)
          }}
          onExpressionNodeClick={(nodes, exprName) => {
            const matchedExpr = expressions.find(e => e.name === exprName) ?? null
            setWrapIntent({ nodes })
            setWrapChosenExpr(matchedExpr)
            if (nodes[0]?.file) {
              setLocation({ file: nodes[0].file, line: nodes[0].line, inspectMode: 'file', componentName: exprName })
            }
            setPanelOpen(true)
          }}
        />

        {/* Center: preview canvas */}
        <div
          style={{ ...styles.canvasColumn, marginRight: panelOpen ? panelWidth : 0 }}
        >
          {/* Breadcrumb sub-header */}
          <div style={styles.breadcrumb}>
            <span style={styles.breadcrumbItem}>
              {activeSection === 'pages' ? '📄 Pages' : activeSection === 'components' ? '🧩 Components' : '🔀 Expressions'}
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
            {activeSection === 'expressions' && activeExpression && (
              <>
                <span style={styles.breadcrumbSep}>›</span>
                <span style={{ ...styles.breadcrumbCurrent, color: '#94e2d5' }}>{activeExpression}</span>
              </>
            )}
          </div>

          {/* Scrollable canvas */}
          {wrapIntent ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
              {/* Tab bar */}
              <div style={{ display: 'flex', background: '#181825', borderBottom: '1px solid #313244', flexShrink: 0 }}>
                {(['nodes', 'preview'] as const).map(tab => (
                  <button
                    key={tab}
                    onClick={() => setWrapCenterTab(tab)}
                    style={{
                      padding: '6px 16px', fontSize: 12, fontFamily: 'system-ui, sans-serif',
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      color: wrapCenterTab === tab ? '#cdd6f4' : '#6c7086',
                      borderBottom: wrapCenterTab === tab ? '2px solid #89b4fa' : '2px solid transparent',
                      fontWeight: wrapCenterTab === tab ? 600 : 400,
                    }}
                  >
                    {tab === 'nodes' ? 'Selected Nodes' : 'Page Preview'}
                  </button>
                ))}
              </div>
              {/* Tab content */}
              {wrapCenterTab === 'nodes' && (
                <ExpressionAssignPanel
                  nodes={wrapIntent.nodes}
                  expressions={expressions}
                  selectedNode={selectedNode}
                  chosenExpr={wrapChosenExpr}
                  onChooseExpr={setWrapChosenExpr}
                  onHoverNode={(node) => setHoveredWrapKey(node.key)}
                  onLeaveNode={() => setHoveredWrapKey(null)}
                  onCancel={() => { setWrapIntent(null); setWrapChosenExpr(null); setHoveredWrapKey(null) }}
                  onDone={() => { setWrapIntent(null); setWrapChosenExpr(null); setHoveredWrapKey(null) }}
                />
              )}
              {wrapCenterTab === 'preview' && (
                <div
                  ref={canvasRef}
                  style={{ flex: 1, overflow: 'auto', background: '#f5f5f5' }}
                >
                  {activeSection === 'pages' && activePage && (
                    <ComponentLoader page={previewPage} componentName={activePage.root} folder="pages" />
                  )}
                  {activeSection === 'components' && previewComponent && (
                    <ComponentLoader page={previewComponent} componentName={previewComponent} folder="components" />
                  )}
                </div>
              )}
            </div>
          ) : (
          <div
            ref={canvasRef}
            style={{ ...styles.canvas, background: activeSection === 'expressions' ? '#24273a' : '#f5f5f5' }}
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
          {activeSection === 'expressions' && (
            <ExpressionTester
              expr={expressions.find((e) => e.name === activeExpression) ?? null}
              pages={pages}
              components={components}
              registerInsert={(fn) => { insertTagRef.current = fn }}
            />
          )}
          </div>
          )}
        </div>

        {/* Right: inspector */}
        {(panelOpen || !!wrapIntent) && (location || wrapIntent) && (
          <InspectorPanel
            file={location?.file ?? wrapIntent!.nodes[0].file}
            line={location?.line ?? 1}
            inspectMode={location?.inspectMode ?? 'file'}
            componentName={location?.componentName}
            selectedNode={selectedNode}
            rootComponentName={activeSection === 'components' ? (previewComponent ?? activePage.root) : activePage.root}
            onClose={() => setPanelOpen(false)}
            onWidthChange={setPanelWidth}
            expressionMode={activeSection === 'expressions'}
            expressionPages={activeSection === 'expressions' ? pages : []}
            expressionComponents={activeSection === 'expressions' ? components : []}
            onInsertComponent={(tag) => insertTagRef.current?.(tag)}
            wrapMode={!!wrapIntent}
            wrapExpressions={wrapIntent ? expressions : []}
            wrapChosenExpr={wrapChosenExpr}
            onWrapChooseExpr={setWrapChosenExpr}
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

      {addExpressionOpen && (
        <AddExpressionModal
          onClose={() => setAddExpressionOpen(false)}
          onAdd={(expr) => {
            setExpressions((prev) => [...prev, expr])
            setAddExpressionOpen(false)
          }}
        />
      )}
    </div>
  )
}

