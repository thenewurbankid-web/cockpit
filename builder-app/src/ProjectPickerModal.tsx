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
  valid: boolean
}

export interface ProjectPickerModalProps {
  onProjectSelected: (root: string) => Promise<void>
  onCancel?: () => void
}

export function ProjectPickerModal({ onProjectSelected, onCancel }: ProjectPickerModalProps) {
  const [currentPath, setCurrentPath] = useState<string>('')
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [checking, setChecking] = useState(false)
  const [opening, setOpening] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const [pathInputActive, setPathInputActive] = useState(false)
  const pathInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    browseDir(undefined)
  }, [])

  async function browseDir(targetPath: string | undefined) {
    setBrowsing(true)
    setSelectedDir(null)
    setProjectInfo(null)
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

  async function selectDir(fullPath: string) {
    setSelectedDir(fullPath)
    setProjectInfo(null)
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
    if (!selectedDir || !projectInfo?.valid) return
    setOpening(true)
    try {
      await onProjectSelected(selectedDir)
    } finally {
      setOpening(false)
    }
  }

  function handlePathInputSubmit(e: React.FormEvent) {
    e.preventDefault()
    setPathInputActive(false)
    browseDir(pathInput)
  }

  const canOpen = !!selectedDir && !!projectInfo?.valid && !opening

  // Build breadcrumb segments from currentPath
  const segments = currentPath
    ? currentPath.replace(/\\/g, '/').split('/').filter(Boolean)
    : []

  return (
    <div style={s.overlay}>
      <div style={s.dialog}>
        {/* Header */}
        <div style={s.header}>
          <span style={s.title}>Open Project</span>
          <span style={{ color: '#6c7086', fontSize: 12, fontFamily: 'monospace' }}>
            Select a folder with <code style={{ color: '#89b4fa' }}>src/pages/</code> or <code style={{ color: '#89b4fa' }}>src/components/</code>
          </span>
        </div>

        {/* Path bar */}
        <div style={s.pathBar}>
          {pathInputActive ? (
            <form onSubmit={handlePathInputSubmit} style={{ flex: 1, display: 'flex', gap: 6 }}>
              <input
                ref={pathInputRef}
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
                  const segPath = (currentPath.startsWith('/')
                    ? '/' + segments.slice(0, i + 1).join('/')
                    : segments.slice(0, i + 1).join('/'))
                    // Handle Windows drive letter
                    || '/'
                  // Reconstruct proper Windows path if needed
                  const winPath = /^[A-Za-z]$/.test(segments[0] ?? '')
                    ? segments.slice(0, i + 1).join('/').replace(/^([A-Za-z])/, '$1:')
                    : null
                  const targetPath = winPath ?? segPath
                  return (
                    <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                      {i > 0 && <span style={{ color: '#45475a', margin: '0 2px' }}>/</span>}
                      <button
                        style={s.breadcrumbBtn}
                        onClick={(e) => { e.stopPropagation(); browseDir(targetPath) }}
                      >
                        {seg}
                      </button>
                    </span>
                  )
                })}
              </div>
              {parent && (
                <button style={s.navBtn} onClick={() => browseDir(parent)}>↑ Up</button>
              )}
            </>
          )}
        </div>

        {/* Directory list */}
        <div style={s.listContainer}>
          {browsing ? (
            <div style={s.placeholder}>Browsing…</div>
          ) : entries.length === 0 ? (
            <div style={s.placeholder}>No subdirectories found.</div>
          ) : (
            entries.map((entry) => {
              const fullPath = currentPath.replace(/[/\\]$/, '') + (currentPath.includes('/') ? '/' : '\\') + entry.name
              const isSelected = selectedDir === fullPath
              return (
                <button
                  key={entry.name}
                  style={{ ...s.dirRow, ...(isSelected ? s.dirRowSelected : {}) }}
                  onClick={() => selectDir(fullPath)}
                  onDoubleClick={() => browseDir(fullPath)}
                  title="Click to select — Double-click to navigate in"
                >
                  <span style={s.folderIcon}>📁</span>
                  <span style={s.dirName}>{entry.name}</span>
                  {isSelected && projectInfo && (
                    <span style={projectInfo.valid ? s.validBadge : s.invalidBadge}>
                      {projectInfo.valid ? '✓ Valid project' : 'No src/pages or src/components'}
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
            <span style={{ color: '#a6adc8', fontSize: 12 }}>Selected:</span>
            <span style={{ color: '#cdd6f4', fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {selectedDir}
            </span>
            {projectInfo.valid && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
                {projectInfo.pagesDir && <span style={s.dirTag}>📄 pages</span>}
                {projectInfo.componentsDir && <span style={s.dirTag}>🧩 components</span>}
                {projectInfo.expressionsDir && <span style={s.dirTag}>🔀 expressions</span>}
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div style={s.actions}>
          {onCancel && (
            <button style={s.cancelBtn} onClick={onCancel}>
              Cancel
            </button>
          )}
          <button
            style={{ ...s.openBtn, opacity: canOpen ? 1 : 0.45, cursor: canOpen ? 'pointer' : 'not-allowed' }}
            disabled={!canOpen}
            onClick={handleOpen}
          >
            {opening ? 'Opening…' : 'Open Project'}
          </button>
        </div>
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
    width: 620,
    maxWidth: '94vw',
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
  },
  header: {
    display: 'flex', flexDirection: 'column', gap: 4,
    padding: '20px 24px 14px',
    borderBottom: '1px solid rgba(203,214,244,0.1)',
    flexShrink: 0,
  },
  title: {
    fontSize: 17, fontWeight: 700, color: '#cdd6f4',
    fontFamily: 'system-ui, sans-serif',
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
    gap: 0, cursor: 'text',
    minWidth: 0,
  },
  breadcrumbBtn: {
    background: 'none', border: 'none', padding: '1px 4px', borderRadius: 3,
    color: '#89b4fa', fontSize: 12, fontFamily: 'monospace', cursor: 'pointer',
    transition: 'background 0.1s',
  },
  navBtn: {
    padding: '3px 10px', borderRadius: 5,
    background: 'rgba(203,214,244,0.08)',
    border: '1px solid rgba(203,214,244,0.14)',
    color: '#cdd6f4', fontSize: 11, cursor: 'pointer',
    fontFamily: 'system-ui, sans-serif',
    flexShrink: 0,
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
    transition: 'background 0.1s',
  },
  dirRowSelected: {
    background: 'rgba(137,180,250,0.1)',
  },
  folderIcon: {
    fontSize: 15, flexShrink: 0,
  },
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
  },
  dirTag: {
    fontSize: 11, color: '#89b4fa',
    background: 'rgba(137,180,250,0.1)', border: '1px solid rgba(137,180,250,0.2)',
    borderRadius: 4, padding: '2px 8px',
    fontFamily: 'system-ui, sans-serif',
  },
  actions: {
    padding: '14px 20px',
    borderTop: '1px solid rgba(203,214,244,0.08)',
    display: 'flex', justifyContent: 'flex-end', gap: 8,
    flexShrink: 0,
  },
  cancelBtn: {
    padding: '8px 18px', borderRadius: 7,
    background: 'transparent',
    border: '1px solid rgba(203,214,244,0.15)',
    color: '#a6adc8', fontSize: 13,
    fontFamily: 'system-ui, sans-serif',
    cursor: 'pointer',
  },
  openBtn: {
    padding: '8px 24px', borderRadius: 7,
    background: '#89b4fa', color: '#1e1e2e',
    border: 'none', fontSize: 13, fontWeight: 600,
    fontFamily: 'system-ui, sans-serif',
    transition: 'opacity 0.15s',
  },
}
