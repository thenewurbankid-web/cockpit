import { useEffect, useMemo, useRef, useState } from 'react'
import { setPreviewIframeWindow, notifyPropsChange, notifyLayoutPropsChange } from './preview/ComponentLoader'
import { ExpressionTester } from './preview/ExpressionTester'
import { InspectorPanel } from './inspector/InspectorPanel'
import type { SelectedNodeContext } from './inspector/InspectorPanel'
import { useLocator } from './locator/useLocator'
import { DOMTreePanel } from './tree/DOMTreePanel'
import type { ExpressionMeta } from './tree/DOMTreePanel'
import { ExpressionAssignPanel } from './preview/ExpressionAssignPanel'
import type { WrapIntentNode } from './preview/ExpressionAssignPanel'
import { AddPageModal, AddComponentModal, AddExpressionModal, AddLayoutModal } from './modals'
import { ProjectPickerModal } from './ProjectPickerModal'
import { SettingsPanel } from './SettingsPanel'
import { DocsPanel } from './DocsPanel'
import { TerminalPanel } from './TerminalPanel'
import { appStyles as styles } from './appStyles'
// Side-effect: imports CSS/Tailwind files listed in cockpit.settings.json cssFiles.
// Still needed for the expressions section which renders components inline.
import 'virtual:cockpit-css'

export type PreviewPage = string

interface ProjectInfo {
  name: string
  root: string
  pagesDir: string | null
  componentsDir: string | null
  expressionsDir: string | null
  hasPackageJson: boolean
  isReactProject: boolean
  valid: boolean
}

async function fetchPages(projectRoot: string): Promise<{ id: string; label: string; root: string; file?: string }[]> {
  try {
    const res = await fetch(`/__source/list-pages?projectRoot=${encodeURIComponent(projectRoot)}`)
    console.log('[fetchPages] status', res.status, 'for', projectRoot)
    if (!res.ok) { console.warn('[fetchPages] non-ok response'); return [] }
    const data = await res.json()
    console.log('[fetchPages] pages:', data.pages)
    return data.pages ?? []
  } catch (e) {
    console.error('[fetchPages] error:', e)
    return []
  }
}

async function fetchRoutes(projectRoot: string): Promise<{ pageId: string; route: string; layoutId?: string | null }[]> {
  try {
    const res = await fetch(`/__source/list-routes?projectRoot=${encodeURIComponent(projectRoot)}`)
    if (!res.ok) return []
    return (await res.json()).routes ?? []
  } catch {
    return []
  }
}

async function fetchLayouts(projectRoot: string): Promise<{ id: string; label: string; name: string; file?: string }[]> {
  try {
    const res = await fetch(`/__source/list-layouts?projectRoot=${encodeURIComponent(projectRoot)}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.layouts ?? []
  } catch {
    return []
  }
}

async function fetchComponents(projectRoot: string): Promise<{ id: string; label: string; name: string; file?: string }[]> {
  try {
    const res = await fetch(`/__source/list-components?projectRoot=${encodeURIComponent(projectRoot)}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.components ?? []
  } catch {
    return []
  }
}

async function fetchExpressions(projectRoot: string): Promise<ExpressionMeta[]> {
  try {
    const res = await fetch(`/__source/list-expressions?projectRoot=${encodeURIComponent(projectRoot)}`)
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
  inspectMode?: 'node' | 'component' | 'file' | 'expression' | 'component-usage'
  componentName?: string
}

const DEFAULT_PANEL_WIDTH = 480

/** Read the three routable params from the current URL search string. */
function readUrlState() {
  const p = new URLSearchParams(window.location.search)
  return {
    section: (p.get('section') ?? 'pages') as 'pages' | 'components' | 'expressions' | 'layouts',
    page: p.get('page') ?? 'login',
    component: p.get('component') ?? null,
  }
}

/** Push updated params to the URL without triggering a navigation / reload. */
function pushUrlState(section: 'pages' | 'components' | 'expressions' | 'layouts', page: string, component: string | null) {
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

// ── Section empty states ──────────────────────────────────────────────────────

const emptyLinkBtn: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0,
  color: '#89b4fa', cursor: 'pointer', fontSize: 'inherit',
  fontFamily: 'inherit', textDecoration: 'underline',
}

const emptyCode: React.CSSProperties = {
  fontFamily: 'monospace', background: 'rgba(137,180,250,0.12)',
  padding: '1px 5px', borderRadius: 3, color: '#89b4fa',
}

function SectionEmptyState({ icon, title, message, action }: {
  icon: string
  title: string
  message: React.ReactNode
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', gap: 12, padding: '40px 32px', textAlign: 'center',
    }}>
      <span style={{ fontSize: 36, lineHeight: 1 }}>{icon}</span>
      <span style={{ fontSize: 15, fontWeight: 600, color: '#cdd6f4', fontFamily: 'system-ui, sans-serif' }}>{title}</span>
      <span style={{ fontSize: 12, color: '#6c7086', fontFamily: 'system-ui, sans-serif', maxWidth: 320, lineHeight: 1.6 }}>{message}</span>
      {action && (
        <button
          style={{
            marginTop: 4, padding: '7px 20px', borderRadius: 7,
            background: 'rgba(137,180,250,0.12)', border: '1px solid rgba(137,180,250,0.25)',
            color: '#89b4fa', fontSize: 12, fontWeight: 600,
            fontFamily: 'system-ui, sans-serif', cursor: 'pointer',
          }}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

function coerceStateData(data: Record<string, string>): Record<string, unknown> {
  const coerced: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (v === 'true') coerced[k] = true
    else if (v === 'false') coerced[k] = false
    else if (v !== '' && !isNaN(Number(v))) coerced[k] = Number(v)
    else { try { coerced[k] = JSON.parse(v) } catch { coerced[k] = v } }
  }
  return coerced
}

function LayoutAssignDropdown({
  layouts,
  activeLayoutId,
  onChange,
}: {
  layouts: { id: string; label: string; name: string }[]
  activeLayoutId: string | null
  onChange: (layoutId: string | null) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ color: '#6c7086', fontSize: '0.7rem' }}>Layout:</span>
      <select
        value={activeLayoutId ?? ''}
        onChange={e => onChange(e.target.value || null)}
        style={{
          background: '#1e1e2e',
          color: '#cdd6f4',
          border: '1px solid #313244',
          borderRadius: 4,
          fontSize: '0.7rem',
          padding: '2px 6px',
          cursor: 'pointer',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <option value="">— none —</option>
        {layouts.map(l => (
          <option key={l.id} value={l.id}>{l.label}</option>
        ))}
      </select>
    </div>
  )
}

interface BreadcrumbStateMeta { key: string; label: string }

function BreadcrumbLayoutStatesDropdown({ layoutId, projectRoot }: { layoutId: string; projectRoot: string }) {
  const [states, setStates] = useState<BreadcrumbStateMeta[]>([])
  const [activeKey, setActiveKey] = useState('')

  useEffect(() => {
    if (!layoutId || !projectRoot) return
    const qs = `projectRoot=${encodeURIComponent(projectRoot)}&layout=${encodeURIComponent(layoutId)}`
    let cancelled = false
    fetch(`/__source/list-layout-states?${qs}`)
      .then(r => r.json())
      .then(async (json) => {
        if (cancelled) return
        const list: BreadcrumbStateMeta[] = json.states ?? []
        setStates(list)
        if (list.length > 0) {
          const first = list[0].key
          setActiveKey(first)
          const dr = await fetch(`/__source/layout-state-data?${qs}&state=${encodeURIComponent(first)}`)
          if (cancelled) return
          const dj = await dr.json()
          notifyLayoutPropsChange(coerceStateData(dj.data ?? {}), true)
        }
      })
      .catch(() => { if (!cancelled) setStates([]) })
    return () => { cancelled = true }
  }, [layoutId, projectRoot])

  if (states.length === 0) return null

  const activeIdx = states.findIndex(s => s.key === activeKey)

  async function handleChange(key: string) {
    setActiveKey(key)
    const qs = `projectRoot=${encodeURIComponent(projectRoot)}&layout=${encodeURIComponent(layoutId)}`
    try {
      const r = await fetch(`/__source/layout-state-data?${qs}&state=${encodeURIComponent(key)}`)
      const j = await r.json()
      notifyLayoutPropsChange(coerceStateData(j.data ?? {}), true)
    } catch { /* ignore */ }
  }

  const navBtnStyle: React.CSSProperties = {
    background: '#1e1e2e',
    border: '1px solid #313244',
    borderRadius: 4,
    color: '#cdd6f4',
    cursor: 'pointer',
    fontSize: '1rem',
    lineHeight: 1,
    padding: '2px 8px',
    fontFamily: 'system-ui, sans-serif',
    display: 'flex',
    alignItems: 'center',
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ color: '#6c7086', fontSize: '0.7rem' }}>Layout:</span>
      <select
        value={activeKey}
        onChange={e => void handleChange(e.target.value)}
        style={{
          background: '#1e1e2e',
          color: '#cdd6f4',
          border: '1px solid #313244',
          borderRadius: 4,
          fontSize: '0.7rem',
          padding: '2px 6px',
          cursor: 'pointer',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        {states.map(s => (
          <option key={s.key} value={s.key}>{s.label}</option>
        ))}
      </select>
      <button
        style={{ ...navBtnStyle, opacity: activeIdx <= 0 ? 0.3 : 1 }}
        disabled={activeIdx <= 0}
        title="Previous layout state"
        onClick={() => { if (activeIdx > 0) void handleChange(states[activeIdx - 1].key) }}
      >&#8249;</button>
      <button
        style={{ ...navBtnStyle, opacity: activeIdx >= states.length - 1 ? 0.3 : 1 }}
        disabled={activeIdx >= states.length - 1}
        title="Next layout state"
        onClick={() => { if (activeIdx < states.length - 1) void handleChange(states[activeIdx + 1].key) }}
      >&#8250;</button>
    </div>
  )
}

function BreadcrumbStatesDropdown({ pageName, projectRoot }: { pageName: string; projectRoot: string }) {
  const [states, setStates] = useState<BreadcrumbStateMeta[]>([])
  const [activeKey, setActiveKey] = useState('')

  useEffect(() => {
    if (!pageName || !projectRoot) return
    const qs = `projectRoot=${encodeURIComponent(projectRoot)}&page=${encodeURIComponent(pageName)}`
    let cancelled = false
    fetch(`/__source/list-states?${qs}`)
      .then(r => r.json())
      .then(async (json) => {
        if (cancelled) return
        const list: BreadcrumbStateMeta[] = json.states ?? []
        setStates(list)
        if (list.length > 0) {
          const first = list[0].key
          setActiveKey(first)
          const dr = await fetch(`/__source/state-data?${qs}&state=${encodeURIComponent(first)}`)
          if (cancelled) return
          const dj = await dr.json()
          notifyPropsChange(coerceStateData(dj.data ?? {}), true)
        }
      })
      .catch(() => { if (!cancelled) setStates([]) })
    return () => { cancelled = true }
  }, [pageName, projectRoot])

  if (states.length === 0) return null

  const activeIdx = states.findIndex(s => s.key === activeKey)

  async function handleChange(key: string) {
    setActiveKey(key)
    const qs = `projectRoot=${encodeURIComponent(projectRoot)}&page=${encodeURIComponent(pageName)}`
    try {
      const r = await fetch(`/__source/state-data?${qs}&state=${encodeURIComponent(key)}`)
      const j = await r.json()
      notifyPropsChange(coerceStateData(j.data ?? {}), true)
    } catch { /* ignore */ }
  }

  const navBtnStyle: React.CSSProperties = {
    background: '#1e1e2e',
    border: '1px solid #313244',
    borderRadius: 4,
    color: '#cdd6f4',
    cursor: 'pointer',
    fontSize: '1rem',
    lineHeight: 1,
    padding: '2px 8px',
    fontFamily: 'system-ui, sans-serif',
    display: 'flex',
    alignItems: 'center',
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ color: '#6c7086', fontSize: '0.7rem' }}>State:</span>
      <select
        value={activeKey}
        onChange={e => void handleChange(e.target.value)}
        style={{
          background: '#1e1e2e',
          color: '#cdd6f4',
          border: '1px solid #313244',
          borderRadius: 4,
          fontSize: '0.7rem',
          padding: '2px 6px',
          cursor: 'pointer',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        {states.map(s => (
          <option key={s.key} value={s.key}>{s.label}</option>
        ))}
      </select>
      <button
        style={{ ...navBtnStyle, opacity: activeIdx <= 0 ? 0.3 : 1 }}
        disabled={activeIdx <= 0}
        title="Previous state"
        onClick={() => { if (activeIdx > 0) void handleChange(states[activeIdx - 1].key) }}
      >&#8249;</button>
      <button
        style={{ ...navBtnStyle, opacity: activeIdx >= states.length - 1 ? 0.3 : 1 }}
        disabled={activeIdx >= states.length - 1}
        title="Next state"
        onClick={() => { if (activeIdx < states.length - 1) void handleChange(states[activeIdx + 1].key) }}
      >&#8250;</button>
    </div>
  )
}

export default function App() {
  const initial = readUrlState()
  const [location, setLocation] = useState<SourceLocation | null>(null)
  const [panelOpen, setPanelOpen] = useState(true)
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false)
  const [selectedNode, setSelectedNode] = useState<SelectedNodeContext | null>(null)
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH)
  const [activeSection, setActiveSection] = useState<'pages' | 'components' | 'expressions' | 'layouts'>(initial.section)
  const [previewPage, setPreviewPage] = useState<string>(initial.page)
  const [previewComponent, setPreviewComponent] = useState<string | null>(initial.component)
  const [pages, setPages] = useState<{ id: string; label: string; root: string; file?: string }[]>([])
  const [addPageOpen, setAddPageOpen] = useState(false)
  const [components, setComponents] = useState<{ id: string; label: string; name: string; file?: string }[]>([])
  const [addComponentOpen, setAddComponentOpen] = useState(false)
  const [expressions, setExpressions] = useState<ExpressionMeta[]>([])
  const [addExpressionOpen, setAddExpressionOpen] = useState(false)
  const [activeExpression, setActiveExpression] = useState<string | null>(null)
  const [wrapIntent, setWrapIntent] = useState<{ nodes: WrapIntentNode[] } | null>(null)
  const [wrapChosenExpr, setWrapChosenExpr] = useState<ExpressionMeta | null>(null)
  const [hoveredWrapKey, setHoveredWrapKey] = useState<string | null>(null)
  const [wrapCenterTab, setWrapCenterTab] = useState<'nodes' | 'preview'>('nodes')
  // The actual resolved component name from fiber (e.g. 'AlSignIn' for SignInPage.tsx).
  // Overrides activePage?.root / previewComponent for isReadOnly checks when they differ.
  const [resolvedRootName, setResolvedRootName] = useState<string | null>(null)

  // Layouts
  const [layouts, setLayouts] = useState<{ id: string; label: string; name: string; file?: string }[]>([])
  const [activeLayout, setActiveLayout] = useState<{ id: string; name: string; file?: string } | null>(null)
  const [addLayoutOpen, setAddLayoutOpen] = useState(false)
  const [routes, setRoutes] = useState<{ pageId: string; route: string; layoutId?: string | null }[]>([])

  // Project selection
  const [projectRoot, setProjectRoot] = useState<string | null>(null)
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showDocs, setShowDocs] = useState(false)
  const [showTerminal, setShowTerminal] = useState(false)
  const [pendingInstallPackages, setPendingInstallPackages] = useState<string[]>([])
  const [aliasesNeedReload, setAliasesNeedReload] = useState(false)
  const [aliasesWereNew, setAliasesWereNew] = useState(false)
  const [detectedPackages, setDetectedPackages] = useState<string[]>([])
  const [previewHasError, setPreviewHasError] = useState(false)

  // Packages that are commonly needed by non-Vite projects but are not
  // bundled with Node.js / browser environments.
  const FRAMEWORK_PACKAGES = ['next', 'react-router-dom', '@remix-run/react', 'gatsby', 'nuxt']

  async function autoPopulateSettings(root: string) {
    try {
      const [pathsRes, depsRes, settingsRes] = await Promise.all([
        fetch(`/__source/tsconfig-paths?root=${encodeURIComponent(root)}`),
        fetch(`/__source/project-deps?root=${encodeURIComponent(root)}`),
        fetch(`/__source/settings?root=${encodeURIComponent(root)}`),
      ])
      const [pathsData, depsData, currentSettings] = await Promise.all([
        pathsRes.json(),
        depsRes.json(),
        settingsRes.json(),
      ])

      const detectedAliases: Record<string, string> = pathsData.aliases ?? {}
      const nodeModulesDir: string | null = pathsData.nodeModulesDir ?? null
      const currentAliases: Record<string, string> = currentSettings.aliases ?? {}
      const currentPackages: string[] = currentSettings.packages ?? []
      const currentNodeModulesDirs: string[] = currentSettings.nodeModulesDirs ?? []

      // Merge: add/update aliases from project tsconfig, keep any user-added extras
      const merged: Record<string, string> = { ...currentAliases, ...detectedAliases }
      const hasNewAliases = Object.entries(detectedAliases).some(
        ([k, v]) => currentAliases[k] !== v,
      )

      // Merge nodeModulesDirs
      const mergedNodeModulesDirs = nodeModulesDir && !currentNodeModulesDirs.includes(nodeModulesDir)
        ? [...currentNodeModulesDirs, nodeModulesDir]
        : currentNodeModulesDirs
      const hasNewNodeModules = mergedNodeModulesDirs.length !== currentNodeModulesDirs.length

      // Detect framework packages present in project but not yet installed in builder
      const projectDeps: string[] = depsData.deps ?? []
      const needed = FRAMEWORK_PACKAGES.filter(
        pkg => projectDeps.includes(pkg) && !currentPackages.includes(pkg),
      )
      setDetectedPackages(needed)

      if (hasNewAliases || hasNewNodeModules) {
        await fetch('/__source/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root, aliases: merged, packages: currentPackages, nodeModulesDirs: mergedNodeModulesDirs }),
        })
      }
    } catch {
      // best-effort
    }
  }

  async function loadProject(root: string) {
    // Notify server so isSafeFile allows files within this project
    await fetch('/__source/set-active-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root }),
    })
    // Fetch project dirs
    const infoRes = await fetch(`/__source/project-info?root=${encodeURIComponent(root)}`)
    const info: ProjectInfo = await infoRes.json()
    setProjectInfo(info)
    // Load pages/components/expressions
    const [loadedPages, loadedComponents, loadedExpressions, loadedLayouts, loadedRoutes] = await Promise.all([
      fetchPages(root),
      fetchComponents(root),
      fetchExpressions(root),
      fetchLayouts(root),
      fetchRoutes(root),
    ])
    console.log('[loadProject] pages:', loadedPages.length, loadedPages.map(p => p.id))
    console.log('[loadProject] components:', loadedComponents.length, loadedComponents.map(c => c.id))
    setPages(loadedPages)
    setComponents(loadedComponents)
    setExpressions(loadedExpressions)
    setLayouts(loadedLayouts)
    setRoutes(loadedRoutes)
    setPreviewPage(loadedPages[0]?.id ?? '')
    setPreviewComponent(null)
    setSelectedNode(null)
    setPanelOpen(false)
    setProjectRoot(root)
    localStorage.setItem('cockpit:projectRoot', root)
    setShowPicker(false)
    // Force settings open if project has no package.json or no React/Next dependency
    if (!info.hasPackageJson || !info.isReactProject) {
      setShowSettings(true)
    }
    // Auto-populate path aliases and detect framework packages
    autoPopulateSettings(root)
  }
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

  // Clear runtime error flag when the user navigates to a different page/component.
  useEffect(() => {
    setPreviewHasError(false)
  }, [activeSection, previewPage, previewComponent])

  useEffect(() => {
    if (activeSection !== 'expressions') setActiveExpression(null)
  }, [activeSection])

  // When switching to layouts section, open the selected layout in inspector
  useEffect(() => {
    if (activeSection === 'layouts') {
      setCanvasEl(null)
    }
  }, [activeSection])

  // Auto-load project from localStorage, or show project picker
  useEffect(() => {
    const saved = localStorage.getItem('cockpit:projectRoot')
    if (saved) {
      loadProject(saved).catch(() => {
        // If the saved project no longer exists, show the picker
        localStorage.removeItem('cockpit:projectRoot')
        setProjectRoot(null)
      })
    }
  }, [])
  const iframeRef = useRef<HTMLIFrameElement>(null)
  /** The live DOM element that the DOMTreePanel uses as its canvas root.
   *  For pages/components: points to the preview iframe's body (set after iframe loads).
   *  For expressions: points to the expression tester container div. */
  const [canvasEl, setCanvasEl] = useState<HTMLElement | null>(null)
  /** The iframe's contentWindow — forwarded to useLocator so Alt+Click works inside the iframe. */
  const [iframeWindow, setIframeWindow] = useState<Window | null>(null)
  const [canvasHasError, setCanvasHasError] = useState(false)

  // Reset canvas error and canvas refs when navigating to a new preview target.
  useEffect(() => {
    setCanvasHasError(false)
    setResolvedRootName(null)
  }, [activeSection, previewPage, previewComponent])

  // Poll the canvas element for load-error state so DOMTreePanel can show a stub node.
  useEffect(() => {
    if (!canvasEl) { setCanvasHasError(false); return }
    let raf = 0
    function check() {
      const hasErr = !!(canvasEl?.querySelector('[data-load-error]'))
      setCanvasHasError(prev => prev !== hasErr ? hasErr : prev)
      raf = requestAnimationFrame(check)
    }
    raf = requestAnimationFrame(check)
    return () => cancelAnimationFrame(raf)
  }, [canvasEl])
  // Callback bridge: InspectorPanel picker → ExpressionTester insert
  const insertTagRef = useRef<((tag: string) => void) | null>(null)

  const activePage = pages.find(p => p.id === previewPage) ?? pages[0]

  // When the user switches pages or components via the nav, update the inspector
  // location so it loads the new file — otherwise it stays stuck on the previous one.
  // page.file / comp.file are relative paths from the server (e.g. "SetNewPassword" or
  // "Auth/SetNewPassword") — we must join them with pagesDir/componentsDir to get the
  // absolute path the inspector needs (the server resolves relative paths from cwd,
  // which is builder-app, not the project root).
  useEffect(() => {
    if (activeSection === 'pages') {
      const page = pages.find(p => p.id === previewPage)
      if (page?.file && pagesDir) {
        setLocation({ file: `${pagesDir}/${page.file}.tsx`, line: 1, inspectMode: 'file', componentName: page.root })
        setPanelOpen(true)
      }
    } else if (activeSection === 'components') {
      const comp = components.find(c => c.name === previewComponent)
      if (comp?.file && componentsDir) {
        setLocation({ file: `${componentsDir}/${comp.file}.tsx`, line: 1, inspectMode: 'file', componentName: comp.name })
        setPanelOpen(true)
      }
    } else if (activeSection === 'layouts') {
      if (activeLayout && layoutsDir) {
        const filePath = `${layoutsDir}/${activeLayout.id}/layout.tsx`
        setLocation({ file: filePath, line: 1, inspectMode: 'file', componentName: activeLayout.name })
        setPanelOpen(true)
      }
    }
  }, [previewPage, previewComponent, activeSection, activeLayout]) // eslint-disable-line react-hooks/exhaustive-deps

  function openInspector(
    file: string,
    line: number,
    inspectMode: 'node' | 'component' | 'file' | 'expression' | 'component-usage' = 'node',
    componentName?: string
  ) {
    // Never expose builder-app source files in the inspector.
    if (file.toLowerCase().replace(/\\/g, '/').includes('builder-app/src/')) return
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

  useLocator((loc) => openInspector(loc.file, loc.line), iframeWindow)

  async function deletePage(id: string, root: string) {
    try {
      const qs = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : ''
      await fetch(`/__source/page/${encodeURIComponent(root)}${qs}`, { method: 'DELETE' })
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
      const qs = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : ''
      await fetch(`/__source/component/${encodeURIComponent(name)}${qs}`, { method: 'DELETE' })
    } catch {
      // best-effort
    }
    setComponents((prev) => prev.filter((c) => c.id !== id))
  }

  async function deleteExpression(name: string) {
    try {
      const qs = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : ''
      await fetch(`/__source/expression/${encodeURIComponent(name)}${qs}`, { method: 'DELETE' })
    } catch {
      // best-effort
    }
    setExpressions((prev) => prev.filter((e) => e.name !== name))
  }

  async function deleteLayout(id: string) {
    try {
      const qs = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : ''
      await fetch(`/__source/layout/${encodeURIComponent(id)}${qs}`, { method: 'DELETE' })
    } catch {
      // best-effort
    }
    setLayouts((prev) => prev.filter((l) => l.id !== id))
    if (activeLayout?.id === id) setActiveLayout(null)
  }

  const pagesDir = projectInfo?.pagesDir ?? ''
  const componentsDir = projectInfo?.componentsDir ?? ''

  // Load the page's assigned layout whenever the active page changes
  useEffect(() => {
    if (!projectRoot || !activePage) { setActiveLayout(null); return }
    const qs = `projectRoot=${encodeURIComponent(projectRoot)}&page=${encodeURIComponent(activePage.id)}`
    fetch(`/__source/page-layout?${qs}`)
      .then(r => r.json())
      .then(data => {
        const layoutId: string | null = data.layout ?? null
        if (layoutId) {
          const found = layouts.find(l => l.id === layoutId)
          setActiveLayout(found ? { id: found.id, name: found.name, file: found.file } : null)
        } else {
          setActiveLayout(null)
        }
      })
      .catch(() => setActiveLayout(null))
  }, [activePage?.id, projectRoot, layouts]) // eslint-disable-line react-hooks/exhaustive-deps

  // layoutsDir from project info (fallback to src/layouts)
  const layoutsDir = useMemo(() => {
    if (!projectRoot) return ''
    // We don't store layoutsDir in ProjectInfo yet — infer from projectRoot
    // (server default is src/layouts)
    return `${projectRoot}/src/layouts`
  }, [projectRoot])

  // Build the URL for the preview iframe. Empty string = no iframe (show empty state instead).
  const previewSrc = useMemo(() => {
    if (activeSection === 'pages' && activePage && pagesDir) {
      const p = new URLSearchParams({
        page: activePage.root,
        componentPath: activePage.file ?? activePage.root,
        pagesDir,
        componentsDir: componentsDir || '',
        section: 'pages',
      })
      if (activeLayout && layoutsDir) {
        p.set('layoutComponent', activeLayout.name)
        p.set('layoutComponentPath', activeLayout.file ?? activeLayout.name)
        p.set('layoutsDir', layoutsDir)
      }
      return `/preview.html?${p.toString()}`
    }
    if (activeSection === 'components' && previewComponent && componentsDir) {
      const comp = components.find(c => c.name === previewComponent)
      const p = new URLSearchParams({
        page: previewComponent,
        componentPath: comp?.file ?? previewComponent,
        pagesDir: pagesDir || '',
        componentsDir,
        section: 'components',
      })
      return `/preview.html?${p.toString()}`
    }
    if (activeSection === 'layouts' && activeLayout && layoutsDir) {
      const p = new URLSearchParams({
        page: activeLayout.name,
        componentPath: `${activeLayout.id}/layout`,
        pagesDir: pagesDir || '',
        componentsDir: layoutsDir,
        section: 'components',
      })
      p.set('layoutsDir', layoutsDir)
      return `/preview.html?${p.toString()}`
    }
    return ''
  }, [activeSection, activePage, previewComponent, pagesDir, componentsDir, components, activeLayout, layoutsDir])

  // Clear canvas state while the iframe transitions to a new src.
  useEffect(() => {
    setCanvasEl(null)
    setIframeWindow(null)
    setPreviewIframeWindow(null)
  }, [previewSrc])

  function handleIframeLoad() {
    try {
      const doc = iframeRef.current?.contentDocument
      // Use the #root container (not body) so that root.firstElementChild is the
      // actual component output — fiberTreeContainsComponent walks .return upward
      // from firstElementChild, which must be a JSX-rendered element, not the
      // React mount container itself.
      const root = doc?.getElementById('root') ?? doc?.body ?? null
      const win = iframeRef.current?.contentWindow ?? null
      setCanvasEl(root)
      setIframeWindow(win)
      setPreviewIframeWindow(win)
    } catch {
      // Cross-origin safety (should not happen — preview.html is same-origin)
    }
  }

  // Show project picker if no project is loaded yet, or the user clicked "Change"
  if (!projectRoot || showPicker) {
    const isLocked = !!projectInfo && (!projectInfo.hasPackageJson || !projectInfo.isReactProject)
    return (
      <ProjectPickerModal
        onProjectSelected={loadProject}
        onCancel={projectRoot ? () => {
          setShowPicker(false)
          if (isLocked) setShowSettings(true)
        } : undefined}
      />
    )
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
          <button
            style={{ ...styles.tab, ...(activeSection === 'layouts' ? styles.tabActive : {}), ...(activeSection === 'layouts' ? { borderBottomColor: '#94e2d2', color: '#94e2d2' } : {}) }}
            onClick={() => setActiveSection('layouts')}
          >
            Layouts
          </button>
        </div>

        {/* Project indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          <span style={{ fontSize: 12, color: '#6c7086', fontFamily: 'monospace' }}>
            📁 {projectInfo?.name ?? '…'}
          </span>
          <button
            style={{
              padding: '3px 10px', fontSize: 11, borderRadius: 5,
              background: 'rgba(203,214,244,0.08)', border: '1px solid rgba(203,214,244,0.14)',
              color: '#a6adc8', cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
            }}
            onClick={() => setShowPicker(true)}
          >
            Change
          </button>
          <button
            style={{
              padding: '3px 10px', fontSize: 11, borderRadius: 5,
              background: 'rgba(203,214,244,0.08)', border: '1px solid rgba(203,214,244,0.14)',
              color: '#a6adc8', cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
            }}
            title="Open documentation"
            onClick={() => setShowDocs(true)}
          >
            Docs
          </button>
          <button
            style={{
              padding: '3px 10px', fontSize: 11, borderRadius: 5,
              background: showTerminal ? 'rgba(166,227,161,0.15)' : 'rgba(203,214,244,0.08)',
              border: showTerminal ? '1px solid rgba(166,227,161,0.3)' : '1px solid rgba(203,214,244,0.14)',
              color: showTerminal ? '#a6e3a1' : '#a6adc8', cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
            }}
            title="Open integrated terminal in project root"
            onClick={() => setShowTerminal(v => !v)}
          >
            &gt;_
          </button>
          <button
            style={{
              padding: '3px 8px', fontSize: 13, borderRadius: 5,
              background: 'rgba(203,214,244,0.08)', border: '1px solid rgba(203,214,244,0.14)',
              color: '#a6adc8', cursor: 'pointer', lineHeight: 1,
            }}
            title="Project settings"
            onClick={() => setShowSettings(true)}
          >
            ⚙
          </button>
        </div>
      </header>

      {/* Reload banner — shown when path aliases were auto-updated */}
      {aliasesNeedReload && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
          background: '#1c2a1c', borderBottom: '1px solid #2a5c2a',
          padding: '6px 16px', fontSize: 12, fontFamily: 'system-ui, sans-serif',
          color: '#a6e3a1', flexShrink: 0,
        }}>
          <span>
            {aliasesWereNew
              ? <>✓ Path aliases auto-detected from <strong>{projectInfo?.name}</strong> tsconfig.json. Reload to apply.</>
              : <>✓ Path aliases already configured for <strong>{projectInfo?.name}</strong>.</>
            }
          </span>
          {detectedPackages.length > 0 && (
            <span style={{ color: '#f9e2af' }}>
              Also detected: <strong>{detectedPackages.join(', ')}</strong> — install via ⚙ Settings.
            </span>
          )}
          <button
            onClick={() => window.location.reload()}
            style={{
              background: '#a6e3a1', color: '#1e1e2e', border: 'none', borderRadius: 5,
              fontSize: 11, fontWeight: 700, padding: '3px 12px', cursor: 'pointer',
            }}
          >
            Reload now
          </button>
          <button
            onClick={() => setAliasesNeedReload(false)}
            style={{ background: 'none', border: 'none', color: '#6c7086', fontSize: 16, cursor: 'pointer', padding: '0 2px' }}
          >×</button>
        </div>
      )}

      {/* Main area */}
      <div style={styles.main}>
        {/* Left: DOM tree */}
        <div style={{ display: leftPanelCollapsed ? 'none' : 'flex', flexShrink: 0 }}>
        <DOMTreePanel
          canvasEl={canvasEl}
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
          preferredRootComponentName={activeSection === 'components' ? (previewComponent ?? undefined) : activeSection === 'layouts' ? (activeLayout?.name ?? undefined) : activePage?.root}
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
            // Track the actual resolved component name from fiber (may differ from page ID / file stem).
            if (componentName) setResolvedRootName(componentName)
            // If fiber couldn't determine the file (new/empty page), look it up from the pages/components list.
            let resolvedFile = file
            if (!resolvedFile && componentName) {
              const page = pages.find(p => p.root === componentName)
              if (page?.file && pagesDir) resolvedFile = `${pagesDir}/${page.file}.tsx`
            }
            if (!resolvedFile && componentName) {
              const comp = components.find(c => c.name === componentName)
              if (comp?.file && componentsDir) resolvedFile = `${componentsDir}/${comp.file}.tsx`
            }
            if (resolvedFile) setLocation({ file: resolvedFile, line, inspectMode: 'file', componentName })
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
          hasLoadError={canvasHasError}
          loadErrorComponentName={
            activeSection === 'components' ? (previewComponent ?? undefined)
            : activeSection === 'layouts' ? (activeLayout?.name ?? undefined)
            : activePage?.root
          }
          pagesDir={pagesDir || undefined}
          componentsDir={componentsDir || undefined}
          layouts={layouts}
          activeLayoutId={activeLayout?.id ?? null}
          onLayoutClick={(layout) => {
            setActiveLayout({ id: layout.id, name: layout.name, file: layout.file })
            if (layoutsDir) {
              const filePath = `${layoutsDir}/${layout.id}/layout.tsx`
              openInspector(filePath, 1, 'file')
            }
            setPanelOpen(true)
          }}
          onAddLayout={() => setAddLayoutOpen(true)}
          onDeleteLayout={(id) => void deleteLayout(id)}
          projectRoot={projectRoot ?? undefined}
          pageId={activePage?.id}
          routeLayouts={layouts.map(l => ({ id: l.id, name: l.name }))}
          onRouteChange={(routePath, lid) => {
            void fetchRoutes(projectRoot ?? '').then(setRoutes)
            if (lid) {
              const found = layouts.find(l => l.id === lid)
              if (found) setActiveLayout({ id: found.id, name: found.name, file: found.file })
            } else {
              setActiveLayout(null)
            }
          }}
        />
        </div>
        {leftPanelCollapsed && (
          <div
            style={{
              width: 18,
              background: '#1e1e2e',
              borderRight: '1px solid #313244',
              flexShrink: 0,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            title="Show left panel"
            onClick={() => setLeftPanelCollapsed(false)}
          >
            <span style={{ color: '#6c7086', fontSize: 11 }}>›</span>
          </div>
        )}

        {/* Center: preview canvas */}
        <div
          style={{ ...styles.canvasColumn, marginRight: panelOpen ? panelWidth : 0 }}
        >
          {/* Breadcrumb sub-header */}
          <div style={styles.breadcrumb}>
            <button
              title={leftPanelCollapsed ? 'Show left panel' : 'Hide left panel'}
              style={{ background: 'transparent', border: 'none', color: '#6c7086', cursor: 'pointer', padding: '3px 2px', flexShrink: 0, display: 'flex', alignItems: 'center', marginRight: 4 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#cdd6f4' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#6c7086' }}
              onClick={() => setLeftPanelCollapsed(v => !v)}
            ><svg width="14" height="12" viewBox="0 0 14 12" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
                <rect x="0.6" y="0.6" width="12.8" height="10.8" rx="1.4" stroke="currentColor" strokeWidth="1.1"/>
                <line x1="4.5" y1="0.6" x2="4.5" y2="11.4" stroke={leftPanelCollapsed ? 'currentColor' : '#45475a'} strokeWidth="1.1"/>
                <rect x="1.1" y="1.1" width="3" height="9.8" rx="0.6" fill={leftPanelCollapsed ? 'transparent' : 'currentColor'} opacity="0.25"/>
              </svg></button>
            <span style={styles.breadcrumbItem}>
              {activeSection === 'pages' ? 'Pages' : activeSection === 'components' ? 'Components' : activeSection === 'layouts' ? 'Layouts' : 'Expressions'}
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
            {activeSection === 'layouts' && activeLayout && (
              <>
                <span style={styles.breadcrumbSep}>›</span>
                <span style={{ ...styles.breadcrumbCurrent, color: '#94e2d2' }}>{activeLayout.name}</span>
              </>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              {activeSection === 'pages' && activePage && projectRoot && (
                <BreadcrumbStatesDropdown pageName={activePage.id} projectRoot={projectRoot} />
              )}
              <button
                title={panelOpen ? 'Hide right panel' : 'Show right panel'}
                style={{ background: 'transparent', border: 'none', color: '#6c7086', cursor: 'pointer', padding: '3px 2px', flexShrink: 0, display: 'flex', alignItems: 'center' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#cdd6f4' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#6c7086' }}
                onClick={() => setPanelOpen(v => !v)}
              ><svg width="14" height="12" viewBox="0 0 14 12" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
                  <rect x="0.6" y="0.6" width="12.8" height="10.8" rx="1.4" stroke="currentColor" strokeWidth="1.1"/>
                  <line x1="9.5" y1="0.6" x2="9.5" y2="11.4" stroke={panelOpen ? 'currentColor' : '#45475a'} strokeWidth="1.1"/>
                  <rect x="9.9" y="1.1" width="3" height="9.8" rx="0.6" fill={panelOpen ? 'currentColor' : 'transparent'} opacity="0.25"/>
                </svg></button>
            </div>
          </div>

          {/* Wrap intent tab bar */}
          {wrapIntent && (
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
          )}

          {/* Wrap intent node-assignment panel (shown over the preview) */}
          {wrapIntent && wrapCenterTab === 'nodes' && (
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

          {/* Preview iframe — pages & components section */}
          {activeSection !== 'expressions' && previewSrc && (
            <iframe
              ref={iframeRef}
              src={previewSrc}
              title="Preview"
              style={{
                flex: 1,
                border: 'none',
                display: (wrapIntent && wrapCenterTab === 'nodes') ? 'none' : 'block',
                background: '#ffffff',
              }}
              onLoad={handleIframeLoad}
            />
          )}

          {/* Empty states — pages section, no active page */}
          {activeSection === 'pages' && !activePage && (
            <div style={{ flex: 1, background: '#11111b' }}>
              {!projectInfo?.pagesDir && (
                <SectionEmptyState
                  icon="📄"
                  title="Pages directory not configured"
                  message={<>No pages directory found in this project. Configure it in <button style={emptyLinkBtn} onClick={() => setShowSettings(true)}>Settings</button> or create a <code style={emptyCode}>src/pages/</code> folder.</>}
                  action={{ label: '⚙ Open Settings', onClick: () => setShowSettings(true) }}
                />
              )}
              {!!projectInfo?.pagesDir && pages.length === 0 && (
                <SectionEmptyState
                  icon="📄"
                  title="No pages yet"
                  message="Create your first page to see it here."
                  action={{ label: '+ New Page', onClick: () => setAddPageOpen(true) }}
                />
              )}
            </div>
          )}

          {/* Empty states — components section, no active component */}
          {activeSection === 'components' && !previewComponent && (
            <div style={{ flex: 1, background: '#11111b' }}>
              {!projectInfo?.componentsDir && (
                <SectionEmptyState
                  icon="🧩"
                  title="Components directory not configured"
                  message={<>No components directory found in this project. Configure it in <button style={emptyLinkBtn} onClick={() => setShowSettings(true)}>Settings</button> or create a <code style={emptyCode}>src/components/</code> folder.</>}
                  action={{ label: '⚙ Open Settings', onClick: () => setShowSettings(true) }}
                />
              )}
              {!!projectInfo?.componentsDir && components.length === 0 && (
                <SectionEmptyState
                  icon="🧩"
                  title="No components yet"
                  message="Create your first component to see it here."
                  action={{ label: '+ New Component', onClick: () => setAddComponentOpen(true) }}
                />
              )}
              {!!projectInfo?.componentsDir && components.length > 0 && (
                <div style={{ ...styles.emptyState, color: '#6c7086' }}>Select a component to preview it here.</div>
              )}
            </div>
          )}

          {/* Layouts section — no canvas, inspector-driven (or standalone preview) */}
          {activeSection === 'layouts' && !previewSrc && (
            <div style={{ flex: 1, background: '#11111b' }}>
              {layouts.length === 0 && (
                <SectionEmptyState
                  icon="⬜"
                  title="No layouts yet"
                  message="Layouts wrap your pages with shared structure like navbars and sidebars. Create your first one to get started."
                  action={{ label: '+ New Layout', onClick: () => setAddLayoutOpen(true) }}
                />
              )}
              {layouts.length > 0 && !activeLayout && (
                <div style={{ ...styles.emptyState, color: '#6c7086' }}>Select a layout from the panel to preview it.</div>
              )}
            </div>
          )}

          {/* Expressions section — inline rendering (ExpressionTester needs fiber access in same doc) */}
          {activeSection === 'expressions' && (
            <div
              ref={(el) => setCanvasEl(el)}
              style={{ flex: 1, overflow: 'auto', background: '#11111b' }}
            >
              {expressions.length === 0 && (
                <SectionEmptyState
                  icon="🔀"
                  title="No expressions yet"
                  message="Expressions let you wrap nodes in conditional or loop logic. Create your first one to get started."
                  action={{ label: '+ New Expression', onClick: () => setAddExpressionOpen(true) }}
                />
              )}
              {expressions.length > 0 && (
                <ExpressionTester
                  expr={expressions.find((e) => e.name === activeExpression) ?? null}
                  pages={pages}
                  components={components}
                  pagesDir={pagesDir}
                  componentsDir={componentsDir}
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
            rootComponentName={resolvedRootName ?? (activeSection === 'components' ? (previewComponent ?? activePage?.root) : activeSection === 'layouts' ? (activeLayout?.name ?? activePage?.root) : activePage?.root)}
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
            hasRuntimeError={previewHasError}
            activeSection={activeSection}
            activePage={activePage?.id ?? ''}
            projectRoot={projectRoot ?? ''}
            layoutComponentName={activeLayout?.name}
            layoutId={activeLayout?.id}
            pageId={activePage?.id}
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
          projectRoot={projectRoot ?? ''}
          onClose={() => setAddPageOpen(false)}
          onAdd={(page) => {
            setPages((prev) => [...prev, page])
            setPreviewPage(page.id)
            setAddPageOpen(false)
            if (pagesDir) {
              setLocation({ file: `${pagesDir}/${page.root}.tsx`, line: 1, inspectMode: 'file', componentName: page.root })
              setPanelOpen(true)
            }
          }}
        />
      )}

      {addComponentOpen && (
        <AddComponentModal
          projectRoot={projectRoot ?? ''}
          onClose={() => setAddComponentOpen(false)}
          onAdd={(comp) => {
            setComponents((prev) => [...prev, comp])
            setAddComponentOpen(false)
          }}
        />
      )}

      {addExpressionOpen && (
        <AddExpressionModal
          projectRoot={projectRoot ?? ''}
          onClose={() => setAddExpressionOpen(false)}
          onAdd={(expr) => {
            setExpressions((prev) => [...prev, expr])
            setAddExpressionOpen(false)
          }}
        />
      )}

      {addLayoutOpen && (
        <AddLayoutModal
          projectRoot={projectRoot ?? ''}
          onClose={() => setAddLayoutOpen(false)}
          onAdd={(layout) => {
            setLayouts((prev) => [...prev, layout])
            setAddLayoutOpen(false)
          }}
        />
      )}

      {showSettings && (
        <SettingsPanel
          projectRoot={projectRoot}
          detectedPackages={detectedPackages}
          pendingInstallPackages={pendingInstallPackages}
          locked={!!projectInfo && (!projectInfo.hasPackageJson || !projectInfo.isReactProject)}
          onClose={() => { setShowSettings(false); setPendingInstallPackages([]) }}
          onChangeProject={() => { setShowSettings(false); setShowPicker(true) }}
          onProjectDirsChanged={() => { if (projectRoot) void loadProject(projectRoot) }}
        />
      )}

      {showDocs && (
        <DocsPanel onClose={() => setShowDocs(false)} />
      )}

      {showTerminal && projectRoot && (
        <TerminalPanel projectRoot={projectRoot} onClose={() => setShowTerminal(false)} />
      )}
    </div>
  )
}

