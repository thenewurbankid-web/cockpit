import { useEffect, useRef, useState } from 'react'

interface BrowseEntry { name: string; isDir: boolean }
interface BrowseResult { path: string; parent: string | null; entries: BrowseEntry[] }
interface ProjectInfo {
  name: string
  root: string
  pagesDir: string | null
  componentsDir: string | null
  expressionsDir: string | null
  hasSrc: boolean
  hasConfig: boolean
  valid: boolean
}

export interface ProjectPickerModalProps {
  onProjectSelected: (root: string) => Promise<void>
  onCancel?: () => void
}

// ── Shared browser hook ───────────────────────────────────────────────────────

function useBrowser(initialPath?: string) {
  const [currentPath, setCurrentPath] = useState<string>(initialPath ?? '')
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [browsing, setBrowsing] = useState(false)
  const [pathInput, setPathInput] = useState(initialPath ?? '')
  const [pathInputActive, setPathInputActive] = useState(false)

  async function browseDir(targetPath: string | undefined) {
    setBrowsing(true)
    try {
      const url = targetPath
        ? `/__source/browse?path=${encodeURIComponent(targetPath)}`
        : '/__source/browse'
      const res = await fetch(url)
      if (!res.ok) return
      const data: BrowseResult = await res.json()
      setCurrentPath(data.path)
      setParent(data.parent)
      setEntries(data.entries)
      setPathInput(data.path)
    } finally {
      setBrowsing(false)
    }
  }

  return { currentPath, parent, entries, browsing, pathInput, setPathInput, pathInputActive, setPathInputActive, browseDir }
}

// ── Breadcrumb + path bar (shared) ────────────────────────────────────────────

function PathBar({ currentPath, parent, browsing, pathInput, setPathInput, pathInputActive, setPathInputActive, browseDir }: {
  currentPath: string
  parent: string | null
  browsing: boolean
  pathInput: string
  setPathInput: (v: string) => void
  pathInputActive: boolean
  setPathInputActive: (v: boolean) => void
  browseDir: (path: string | undefined) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const segments = currentPath ? currentPath.replace(/\\/g, '/').split('/').filter(Boolean) : []

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setPathInputActive(false)
    browseDir(pathInput)
  }

  return (
    <div style={s.pathBar}>
      {pathInputActive ? (
        <form onSubmit={handleSubmit} style={{ flex: 1, display: 'flex', gap: 6 }}>
          <input
            ref={inputRef}
            style={s.pathInput}
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onBlur={() => setPathInputActive(false)}
            onKeyDown={(e) => { if (e.key === 'Escape') setPathInputActive(false) }}
            autoFocus
          />
          <button type="submit" style={s.navBtn}>Go</button>
        </form>
      ) : (
        <>
          <div style={s.breadcrumb} onClick={() => setPathInputActive(true)} title="Click to type a path">
            {segments.map((seg, i) => {
              const winPath = /^[A-Za-z]$/.test(segments[0] ?? '')
                ? segments.slice(0, i + 1).join('/').replace(/^([A-Za-z])/, '$1:')
                : null
              const segPath = (currentPath.startsWith('/')
                ? '/' + segments.slice(0, i + 1).join('/')
                : segments.slice(0, i + 1).join('/')) || '/'
              const targetPath = winPath ?? segPath
              return (
                <span key={i} style={{ display: 'flex', alignItems: 'center' }}>
                  {i > 0 && <span style={{ color: '#45475a', margin: '0 2px' }}>/</span>}
                  <button style={s.breadcrumbBtn} onClick={(e) => { e.stopPropagation(); browseDir(targetPath) }}>{seg}</button>
                </span>
              )
            })}
          </div>
          {parent && <button style={s.navBtn} onClick={() => browseDir(parent)}>↑ Up</button>}
          {browsing && <span style={{ color: '#585b70', fontSize: 11 }}>Loading…</span>}
        </>
      )}
    </div>
  )
}

// ── Relative-dir input fields ─────────────────────────────────────────────────

function DirConfigFields({ pagesDir, componentsDir, expressionsDir, onChange }: {
  pagesDir: string
  componentsDir: string
  expressionsDir: string
  onChange: (field: 'pagesDir' | 'componentsDir' | 'expressionsDir', value: string) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={s.dirConfigNote}>
        Paths are relative to the project root. Leave blank to use defaults (<code style={{ color: '#89b4fa' }}>src/pages</code>, etc.)
      </div>
      {(['pagesDir', 'componentsDir', 'expressionsDir'] as const).map((field) => {
        const labels = { pagesDir: 'Pages directory', componentsDir: 'Components directory', expressionsDir: 'Expressions directory' }
        const placeholders = { pagesDir: 'src/pages', componentsDir: 'src/components', expressionsDir: 'src/expressions' }
        const value = field === 'pagesDir' ? pagesDir : field === 'componentsDir' ? componentsDir : expressionsDir
        return (
          <div key={field} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <label style={s.dirLabel}>{labels[field]}</label>
            <input
              style={s.dirInput}
              value={value}
              onChange={(e) => onChange(field, e.target.value)}
              placeholder={placeholders[field]}
              spellCheck={false}
            />
          </div>
        )
      })}
    </div>
  )
}

// ── Open-existing tab ─────────────────────────────────────────────────────────

function OpenExistingTab({ onProjectSelected }: { onProjectSelected: (root: string) => Promise<void> }) {
  const browser = useBrowser()
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [opening, setOpening] = useState(false)
  // Init flow state
  const [showInitDirs, setShowInitDirs] = useState(false)
  const [initPagesDir, setInitPagesDir] = useState('')
  const [initComponentsDir, setInitComponentsDir] = useState('')
  const [initExpressionsDir, setInitExpressionsDir] = useState('')
  const [initing, setIniting] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)

  useEffect(() => { browser.browseDir(undefined) }, [])

  async function selectDir(fullPath: string) {
    setSelectedDir(fullPath)
    setProjectInfo(null)
    setShowInitDirs(false)
    setInitError(null)
    setChecking(true)
    try {
      const res = await fetch(`/__source/project-info?root=${encodeURIComponent(fullPath)}`)
      if (!res.ok) return
      setProjectInfo(await res.json())
    } finally {
      setChecking(false)
    }
  }

  async function handleOpen() {
    if (!selectedDir || !projectInfo?.valid || !projectInfo?.hasConfig) return
    setOpening(true)
    try { await onProjectSelected(selectedDir) } finally { setOpening(false) }
  }

  async function handleInit() {
    if (!selectedDir) return
    setIniting(true)
    setInitError(null)
    try {
      const res = await fetch('/__source/init-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          root: selectedDir,
          pagesDir: initPagesDir,
          componentsDir: initComponentsDir,
          expressionsDir: initExpressionsDir,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setInitError(data.error ?? 'Failed to initialise project'); return }
      await onProjectSelected(selectedDir)
    } finally {
      setIniting(false)
    }
  }

  const joinPath = (base: string, name: string) =>
    base.replace(/[/\\]$/, '') + (base.includes('/') ? '/' : '\\') + name

  const needsInit = !!projectInfo?.valid && !projectInfo?.hasConfig
  const canOpen = !!selectedDir && !!projectInfo?.valid && !!projectInfo?.hasConfig && !opening

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <PathBar {...browser} />

      {/* Directory list */}
      <div style={s.listContainer}>
        {browser.browsing ? (
          <div style={s.placeholder}>Browsing…</div>
        ) : browser.entries.length === 0 ? (
          <div style={s.placeholder}>No subdirectories found.</div>
        ) : (
          browser.entries.map((entry) => {
            const fullPath = joinPath(browser.currentPath, entry.name)
            const isSelected = selectedDir === fullPath
            return (
              <button
                key={entry.name}
                style={{ ...s.dirRow, ...(isSelected ? s.dirRowSelected : {}) }}
                onClick={() => selectDir(fullPath)}
                onDoubleClick={() => browser.browseDir(fullPath)}
                title="Click to select — Double-click to navigate in"
              >
                <span style={s.folderIcon}>📁</span>
                <span style={s.dirName}>{entry.name}</span>
                {isSelected && projectInfo && (
                  <span style={projectInfo.valid ? s.validBadge : s.invalidBadge}>
                    {projectInfo.valid
                      ? (projectInfo.hasConfig ? '✓ Cockpit project' : '○ React app (not initialised)')
                      : 'No src/pages or src/components'}
                  </span>
                )}
                {isSelected && checking && (
                  <span style={{ ...s.invalidBadge, color: '#a6adc8' }}>Checking…</span>
                )}
              </button>
            )
          })
        )}
      </div>

      {/* Selected project summary */}
      {selectedDir && projectInfo && !checking && (
        <div style={s.summary}>
          <span style={{ color: '#cdd6f4', fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all' }}>
            {selectedDir}
          </span>
          {projectInfo.valid && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
              {projectInfo.pagesDir && <span style={s.dirTag}>📄 pages</span>}
              {projectInfo.componentsDir && <span style={s.dirTag}>🧩 components</span>}
              {projectInfo.expressionsDir && <span style={s.dirTag}>🔀 expressions</span>}
              {projectInfo.hasConfig && <span style={{ ...s.dirTag, color: '#a6e3a1', background: 'rgba(166,227,161,0.08)', borderColor: 'rgba(166,227,161,0.2)' }}>⚙ .cockpit config</span>}
            </div>
          )}
          {!projectInfo.valid && (
            <span style={{ color: '#f38ba8', fontSize: 11 }}>
              No <code>src/pages</code> or <code>src/components</code> found. Run{' '}
              <code style={{ color: '#89b4fa' }}>npm create vite@latest</code> or{' '}
              <code style={{ color: '#89b4fa' }}>npx create-next-app</code> in this folder first.
            </span>
          )}
          {/* Init flow (valid but no .cockpit config) */}
          {needsInit && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ color: '#f9e2af', fontSize: 11 }}>
                This React app has not been initialised as a Cockpit project yet. Configure directories to continue.
              </div>
              {!showInitDirs ? (
                <button style={s.secondaryBtn} onClick={() => setShowInitDirs(true)}>
                  Configure directories…
                </button>
              ) : (
                <DirConfigFields
                  pagesDir={initPagesDir}
                  componentsDir={initComponentsDir}
                  expressionsDir={initExpressionsDir}
                  onChange={(f, v) => {
                    if (f === 'pagesDir') setInitPagesDir(v)
                    else if (f === 'componentsDir') setInitComponentsDir(v)
                    else setInitExpressionsDir(v)
                  }}
                />
              )}
              {initError && <span style={{ color: '#f38ba8', fontSize: 11 }}>{initError}</span>}
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div style={s.actions}>
        {selectedDir && needsInit && showInitDirs && (
          <button
            style={{ ...s.openBtn, opacity: initing ? 0.6 : 1, cursor: initing ? 'not-allowed' : 'pointer' }}
            disabled={initing}
            onClick={handleInit}
          >
            {initing ? 'Initialising…' : 'Initialise & Open'}
          </button>
        )}
        {!needsInit && (
          <button
            style={{ ...s.openBtn, opacity: canOpen ? 1 : 0.45, cursor: canOpen ? 'pointer' : 'not-allowed' }}
            disabled={!canOpen}
            onClick={handleOpen}
          >
            {opening ? 'Opening…' : 'Open Project'}
          </button>
        )}
      </div>
    </div>
  )
}

// ── Create-new tab ────────────────────────────────────────────────────────────

function CreateNewTab({ onProjectSelected }: { onProjectSelected: (root: string) => Promise<void> }) {
  const browser = useBrowser()
  const [projectName, setProjectName] = useState('')
  const [pagesDir, setPagesDir] = useState('')
  const [componentsDir, setComponentsDir] = useState('')
  const [expressionsDir, setExpressionsDir] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { browser.browseDir(undefined) }, [])

  const canCreate = !!browser.currentPath && projectName.trim().length > 0 && !creating

  const previewRoot = browser.currentPath && projectName.trim()
    ? browser.currentPath.replace(/[/\\]$/, '') + (browser.currentPath.includes('/') ? '/' : '\\') + projectName.trim()
    : ''

  async function handleCreate() {
    if (!canCreate) return
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/__source/create-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: projectName.trim(),
          location: browser.currentPath,
          pagesDir,
          componentsDir,
          expressionsDir,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Failed to create project'); return }
      await onProjectSelected(data.root)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {/* Step 1: pick parent directory */}
      <div style={{ padding: '10px 20px 0', flexShrink: 0 }}>
        <div style={s.createSectionLabel}>1. Choose parent directory</div>
      </div>
      <PathBar {...browser} />

      {/* Step 2 + 3 — scrollable */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Step 2: project name */}
        <div style={s.createSection}>
          <div style={s.createSectionLabel}>2. Project name</div>
          <input
            style={{ ...s.dirInput, width: '100%', boxSizing: 'border-box' }}
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="my-app"
            spellCheck={false}
            autoFocus
          />
          {previewRoot && (
            <div style={{ color: '#585b70', fontSize: 11, fontFamily: 'monospace', marginTop: 2, wordBreak: 'break-all' }}>
              Will create: <span style={{ color: '#a6adc8' }}>{previewRoot}</span>
            </div>
          )}
        </div>

        {/* Step 3: directories */}
        <div style={s.createSection}>
          <div style={s.createSectionLabel}>3. Configure directories <span style={{ color: '#585b70', fontWeight: 400 }}>(optional)</span></div>
          <div style={{ color: '#585b70', fontSize: 11, marginBottom: 4 }}>
            You can set this up after creating your React/Next app. Leave blank to use defaults.
          </div>
          <DirConfigFields
            pagesDir={pagesDir}
            componentsDir={componentsDir}
            expressionsDir={expressionsDir}
            onChange={(f, v) => {
              if (f === 'pagesDir') setPagesDir(v)
              else if (f === 'componentsDir') setComponentsDir(v)
              else setExpressionsDir(v)
            }}
          />
        </div>
      </div>

      {/* Actions */}
      <div style={{ ...s.actions, flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        {error && <span style={{ color: '#f38ba8', fontSize: 11, alignSelf: 'flex-start' }}>{error}</span>}
        <button
          style={{ ...s.openBtn, opacity: canCreate ? 1 : 0.45, cursor: canCreate ? 'pointer' : 'not-allowed' }}
          disabled={!canCreate}
          onClick={handleCreate}
        >
          {creating ? 'Creating…' : 'Create Project'}
        </button>
      </div>
    </div>
  )
}

// ── Main modal ────────────────────────────────────────────────────────────────

export function ProjectPickerModal({ onProjectSelected, onCancel }: ProjectPickerModalProps) {
  const [mode, setMode] = useState<'open' | 'create'>('open')

  return (
    <div style={s.overlay}>
      <div style={s.dialog}>
        {/* Header */}
        <div style={s.header}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={s.title}>Projects</span>
            {onCancel && (
              <button style={s.closeBtn} onClick={onCancel} title="Close">✕</button>
            )}
          </div>
          {/* Mode tabs */}
          <div style={s.tabs}>
            <button
              style={{ ...s.tab, ...(mode === 'open' ? s.tabActive : {}) }}
              onClick={() => setMode('open')}
            >
              Open Existing
            </button>
            <button
              style={{ ...s.tab, ...(mode === 'create' ? s.tabActive : {}) }}
              onClick={() => setMode('create')}
            >
              + Create New
            </button>
          </div>
        </div>

        {/* Tab content */}
        {mode === 'open'
          ? <OpenExistingTab key="open" onProjectSelected={onProjectSelected} />
          : <CreateNewTab key="create" onProjectSelected={onProjectSelected} />
        }

        {/* Cancel button (open mode only) */}
        {mode === 'open' && onCancel && (
          <div style={{ padding: '0 20px 14px', display: 'flex' }}>
            <button style={s.cancelBtn} onClick={onCancel}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(17,17,27,0.85)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  dialog: {
    background: '#1e1e2e',
    border: '1px solid rgba(203,214,244,0.15)',
    borderRadius: 12,
    width: 640,
    maxWidth: '94vw',
    height: '80vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
  },
  header: {
    display: 'flex', flexDirection: 'column', gap: 0,
    padding: '18px 24px 0',
    borderBottom: '1px solid rgba(203,214,244,0.1)',
    flexShrink: 0,
  },
  title: {
    fontSize: 17, fontWeight: 700, color: '#cdd6f4',
    fontFamily: 'system-ui, sans-serif',
  },
  closeBtn: {
    background: 'none', border: 'none', color: '#585b70', fontSize: 16,
    cursor: 'pointer', padding: '2px 6px', borderRadius: 4,
    fontFamily: 'system-ui, sans-serif',
  },
  tabs: {
    display: 'flex', gap: 0, marginTop: 10,
  },
  tab: {
    padding: '7px 18px',
    background: 'none', border: 'none',
    borderBottom: '2px solid transparent',
    color: '#585b70', fontSize: 13,
    fontFamily: 'system-ui, sans-serif', cursor: 'pointer',
  },
  tabActive: {
    color: '#89b4fa',
    borderBottomColor: '#89b4fa',
  },
  pathBar: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 16px',
    background: '#181825',
    borderBottom: '1px solid rgba(203,214,244,0.08)',
    flexShrink: 0,
    minHeight: 38,
  },
  breadcrumb: {
    flex: 1, display: 'flex', alignItems: 'center', flexWrap: 'wrap',
    gap: 0, cursor: 'text', minWidth: 0,
  },
  breadcrumbBtn: {
    background: 'none', border: 'none', padding: '1px 4px', borderRadius: 3,
    color: '#89b4fa', fontSize: 12, fontFamily: 'monospace', cursor: 'pointer',
  },
  navBtn: {
    padding: '3px 10px', borderRadius: 5,
    background: 'rgba(203,214,244,0.08)',
    border: '1px solid rgba(203,214,244,0.14)',
    color: '#cdd6f4', fontSize: 11, cursor: 'pointer',
    fontFamily: 'system-ui, sans-serif', flexShrink: 0,
  },
  pathInput: {
    flex: 1, background: '#11111b', border: '1px solid rgba(137,180,250,0.4)',
    borderRadius: 5, padding: '3px 8px', color: '#cdd6f4',
    fontSize: 12, fontFamily: 'monospace', outline: 'none',
  },
  listContainer: {
    flex: 1, overflowY: 'auto', padding: '6px 0',
  },
  placeholder: {
    padding: '32px 24px', textAlign: 'center',
    color: '#585b70', fontSize: 13, fontFamily: 'system-ui, sans-serif',
  },
  dirRow: {
    width: '100%', display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 20px', background: 'none', border: 'none',
    cursor: 'pointer', textAlign: 'left',
  },
  dirRowSelected: {
    background: 'rgba(137,180,250,0.1)',
  },
  folderIcon: { fontSize: 15, flexShrink: 0 },
  dirName: {
    flex: 1, color: '#cdd6f4', fontSize: 13, fontFamily: 'monospace',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  validBadge: {
    fontSize: 11, color: '#a6e3a1',
    background: 'rgba(166,227,161,0.12)', border: '1px solid rgba(166,227,161,0.3)',
    borderRadius: 4, padding: '1px 7px', flexShrink: 0,
    fontFamily: 'system-ui, sans-serif',
  },
  invalidBadge: {
    fontSize: 11, color: '#f38ba8',
    background: 'rgba(243,139,168,0.1)', border: '1px solid rgba(243,139,168,0.2)',
    borderRadius: 4, padding: '1px 7px', flexShrink: 0,
    fontFamily: 'system-ui, sans-serif',
  },
  summary: {
    padding: '10px 20px',
    borderTop: '1px solid rgba(203,214,244,0.08)',
    display: 'flex', flexDirection: 'column', gap: 4,
    background: '#181825', flexShrink: 0,
    maxHeight: '40%', overflowY: 'auto',
  },
  dirTag: {
    fontSize: 11, color: '#89b4fa',
    background: 'rgba(137,180,250,0.1)', border: '1px solid rgba(137,180,250,0.2)',
    borderRadius: 4, padding: '2px 8px',
    fontFamily: 'system-ui, sans-serif',
  },
  actions: {
    padding: '12px 20px',
    borderTop: '1px solid rgba(203,214,244,0.08)',
    display: 'flex', justifyContent: 'flex-end', gap: 8,
    flexShrink: 0,
  },
  cancelBtn: {
    padding: '8px 18px', borderRadius: 7,
    background: 'transparent',
    border: '1px solid rgba(203,214,244,0.15)',
    color: '#a6adc8', fontSize: 13,
    fontFamily: 'system-ui, sans-serif', cursor: 'pointer',
  },
  openBtn: {
    padding: '8px 24px', borderRadius: 7,
    background: '#89b4fa', color: '#1e1e2e',
    border: 'none', fontSize: 13, fontWeight: 600,
    fontFamily: 'system-ui, sans-serif',
  },
  secondaryBtn: {
    padding: '6px 14px', borderRadius: 6,
    background: 'rgba(137,180,250,0.1)',
    border: '1px solid rgba(137,180,250,0.25)',
    color: '#89b4fa', fontSize: 12,
    fontFamily: 'system-ui, sans-serif', cursor: 'pointer',
    alignSelf: 'flex-start',
  },
  createSection: {
    display: 'flex', flexDirection: 'column', gap: 6,
  },
  createSectionLabel: {
    fontSize: 12, fontWeight: 600, color: '#a6adc8',
    fontFamily: 'system-ui, sans-serif', marginBottom: 2,
  },
  dirConfigNote: {
    fontSize: 11, color: '#585b70', fontFamily: 'system-ui, sans-serif',
    marginBottom: 4,
  },
  dirLabel: {
    fontSize: 11, color: '#a6adc8', fontFamily: 'system-ui, sans-serif',
  },
  dirInput: {
    background: '#11111b', border: '1px solid rgba(203,214,244,0.15)',
    borderRadius: 5, padding: '5px 9px', color: '#cdd6f4',
    fontSize: 12, fontFamily: 'monospace', outline: 'none',
  },
}
