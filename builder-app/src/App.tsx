import { useEffect, useMemo, useRef, useState } from 'react'
import { setPreviewIframeWindow } from './preview/ComponentLoader'
import { ExpressionTester } from './preview/ExpressionTester'
import { InspectorPanel } from './inspector/InspectorPanel'
import type { SelectedNodeContext } from './inspector/InspectorPanel'
import { useLocator } from './locator/useLocator'
import { DOMTreePanel } from './tree/DOMTreePanel'
import type { ExpressionMeta } from './tree/DOMTreePanel'
import { ExpressionAssignPanel } from './preview/ExpressionAssignPanel'
import type { WrapIntentNode } from './preview/ExpressionAssignPanel'
import { AddPageModal, AddComponentModal, AddExpressionModal } from './modals'
import { ProjectPickerModal } from './ProjectPickerModal'
import { SettingsPanel } from './SettingsPanel'
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

export default function App() {
  const initial = readUrlState()
  const [location, setLocation] = useState<SourceLocation | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [selectedNode, setSelectedNode] = useState<SelectedNodeContext | null>(null)
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH)
  const [activeSection, setActiveSection] = useState<'pages' | 'components' | 'expressions'>(initial.section)
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

  // Project selection
  const [projectRoot, setProjectRoot] = useState<string | null>(null)
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
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
    const [loadedPages, loadedComponents, loadedExpressions] = await Promise.all([
      fetchPages(root),
      fetchComponents(root),
      fetchExpressions(root),
    ])
    console.log('[loadProject] pages:', loadedPages.length, loadedPages.map(p => p.id))
    console.log('[loadProject] components:', loadedComponents.length, loadedComponents.map(c => c.id))
    setPages(loadedPages)
    setComponents(loadedComponents)
    setExpressions(loadedExpressions)
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
    }
  }, [previewPage, previewComponent, activeSection]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const pagesDir = projectInfo?.pagesDir ?? ''
  const componentsDir = projectInfo?.componentsDir ?? ''

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
    return ''
  }, [activeSection, activePage, previewComponent, pagesDir, componentsDir, components])

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
            : activePage?.root
          }
          pagesDir={pagesDir || undefined}
          componentsDir={componentsDir || undefined}
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
            rootComponentName={resolvedRootName ?? (activeSection === 'components' ? (previewComponent ?? activePage?.root) : activePage?.root)}
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
    </div>
  )
}

