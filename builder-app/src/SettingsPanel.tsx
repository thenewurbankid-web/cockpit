import { useEffect, useRef, useState } from 'react'
import { modalStyles } from './appStyles'

interface SettingsPanelProps {
  projectRoot: string | null
  detectedPackages?: string[]
  pendingInstallPackages?: string[]
  onClose: () => void
  onProjectDirsChanged?: () => void
}

interface Settings {
  aliases: Record<string, string>
  packages: string[]
  nodeModulesDirs: string[]
  projectDirs?: Record<string, { pagesDir?: string; componentsDir?: string; expressionsDir?: string }>
  cssFiles?: string[]
  publicDirs?: string[]
  fontLinks?: string[]
}

interface DirOverrides {
  pagesDir: string
  componentsDir: string
  expressionsDir: string
}

// Inline directory picker — a small popover with the /__source/browse endpoint.
interface BrowseEntry { name: string; isDir: boolean }
interface BrowseResult { path: string; parent: string | null; entries: BrowseEntry[] }

function DirPickerField({
  label, value, onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [browsePath, setBrowsePath] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [browsing, setBrowsing] = useState(false)

  async function browse(targetPath?: string) {
    setBrowsing(true)
    try {
      const url = targetPath
        ? `/__source/browse?path=${encodeURIComponent(targetPath)}`
        : '/__source/browse'
      const res = await fetch(url)
      if (!res.ok) return
      const data: BrowseResult = await res.json()
      setBrowsePath(data.path)
      setParent(data.parent)
      setEntries(data.entries.filter(e => e.isDir))
    } finally {
      setBrowsing(false)
    }
  }

  function openPicker() {
    setOpen(true)
    browse(value || undefined)
  }

  function pickDir(name: string) {
    const sep = browsePath.endsWith('/') || browsePath.endsWith('\\') ? '' : '/'
    browse(browsePath + sep + name)
  }

  function confirm() {
    onChange(browsePath.replace(/\\/g, '/'))
    setOpen(false)
  }

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: '#a6adc8', marginBottom: 4, fontFamily: 'system-ui, sans-serif' }}>{label}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          style={{ ...inputStyle, flex: 1, fontFamily: 'monospace', fontSize: 11 }}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="(uses default)" spellCheck={false}
        />
        <button style={s.smallBtn} onClick={openPicker}>Browse…</button>
        {value && <button style={s.removeBtn} title="Clear" onClick={() => onChange('')}>×</button>}
      </div>
      {open && (
        <div style={dpS.popover} onClick={e => e.stopPropagation()}>
          <div style={dpS.header}>
            <span style={{ fontFamily: 'monospace', fontSize: 10, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#cdd6f4' }}>
              {browsePath}
            </span>
            <button style={s.removeBtn} onClick={() => setOpen(false)}>×</button>
          </div>
          {parent && (
            <button style={dpS.entry} onClick={() => browse(parent)}>← ..</button>
          )}
          {browsing ? (
            <div style={{ padding: '6px 8px', color: '#6c7086', fontSize: 11 }}>Loading…</div>
          ) : entries.length === 0 ? (
            <div style={{ padding: '6px 8px', color: '#6c7086', fontSize: 11, fontStyle: 'italic' }}>No subdirectories</div>
          ) : entries.map(e => (
            <button key={e.name} style={dpS.entry} onClick={() => pickDir(e.name)}>📁 {e.name}</button>
          ))}
          <div style={dpS.footer}>
            <button style={{ ...s.smallBtn, fontSize: 11 }} onClick={confirm}>Select this folder</button>
          </div>
        </div>
      )}
    </div>
  )
}

type AliasEntry = { key: string; value: string }

function settingsToEntries(aliases: Record<string, string>): AliasEntry[] {
  return Object.entries(aliases).map(([key, value]) => ({ key, value }))
}

function entriesToAliases(entries: AliasEntry[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const { key, value } of entries) {
    if (key.trim()) result[key.trim()] = value.trim()
  }
  return result
}

export function SettingsPanel({ projectRoot, detectedPackages = [], pendingInstallPackages = [], onClose, onProjectDirsChanged }: SettingsPanelProps) {
  const [aliases, setAliases] = useState<AliasEntry[]>([])
  const [packages, setPackages] = useState<string[]>([])
  const [nodeModulesDirs, setNodeModulesDirs] = useState<string[]>([])
  const [projectDirs, setProjectDirs] = useState<DirOverrides>({ pagesDir: '', componentsDir: '', expressionsDir: '' })
  const [cssFiles, setCssFiles] = useState<string[]>([])
  const [publicDirs, setPublicDirs] = useState<string[]>([])
  const [fontLinks, setFontLinks] = useState<string[]>([])
  const [packageInput, setPackageInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installLog, setInstallLog] = useState<string>('')
  const [installOk, setInstallOk] = useState<boolean | null>(null)
  const [detectLoading, setDetectLoading] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const logEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/__source/settings')
      .then(r => r.json())
      .then((data: Settings) => {
        setAliases(settingsToEntries(data.aliases ?? {}))
        setPackages(data.packages ?? [])
        setNodeModulesDirs(data.nodeModulesDirs ?? [])
        setCssFiles(data.cssFiles ?? [])
        setPublicDirs(data.publicDirs ?? [])
        setFontLinks(data.fontLinks ?? [])
        if (projectRoot) {
          const overrides = (data.projectDirs ?? {})[projectRoot] ?? {}
          setProjectDirs({
            pagesDir: overrides.pagesDir ?? '',
            componentsDir: overrides.componentsDir ?? '',
            expressionsDir: overrides.expressionsDir ?? '',
          })
        }
      })
      .catch(() => setError('Could not load settings'))
  }, [])

  async function detectFromTsconfig() {
    if (!projectRoot) return
    setDetectLoading(true)
    setError(null)
    try {
      const res = await fetch(`/__source/tsconfig-paths?root=${encodeURIComponent(projectRoot)}`)
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Failed to read tsconfig'); return }
      const detected = settingsToEntries(data.aliases ?? {})
      if (detected.length === 0) {
        setError('No path aliases found in tsconfig.json')
        return
      }
      // Merge: keep existing entries not covered by detected, add/update detected
      setAliases(prev => {
        const merged = [...prev]
        for (const d of detected) {
          const idx = merged.findIndex(e => e.key === d.key)
          if (idx >= 0) merged[idx] = d
          else merged.push(d)
        }
        return merged
      })
    } finally {
      setDetectLoading(false)
    }
  }

  async function save(andReload = false) {
    setSaving(true)
    setSaveMsg(null)
    setError(null)
    try {
      // Read current settings to preserve projectDirs for other projects.
      const current = await fetch('/__source/settings').then(r => r.json()).catch(() => ({}))
      const currentProjectDirs: Record<string, object> = (current as Settings).projectDirs ?? {}
      const updatedProjectDirs = projectRoot
        ? {
            ...currentProjectDirs,
            [projectRoot]: {
              ...(projectDirs.pagesDir ? { pagesDir: projectDirs.pagesDir } : {}),
              ...(projectDirs.componentsDir ? { componentsDir: projectDirs.componentsDir } : {}),
              ...(projectDirs.expressionsDir ? { expressionsDir: projectDirs.expressionsDir } : {}),
            },
          }
        : currentProjectDirs
      const res = await fetch('/__source/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aliases: entriesToAliases(aliases), packages, nodeModulesDirs, projectDirs: updatedProjectDirs, cssFiles, publicDirs, fontLinks }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Save failed'); return }
      onProjectDirsChanged?.()
      if (andReload) {
        window.location.reload()
      } else {
        setSaveMsg('Saved. Reload the page for alias changes to take effect.')
      }
    } finally {
      setSaving(false)
    }
  }

  function installPackage() {
    const pkg = packageInput.trim()
    if (!pkg) return
    setInstalling(true)
    setInstallLog('')
    setInstallOk(null)
    setError(null)

    fetch('/__source/install-package', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageName: pkg }),
    }).then(res => {
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      function pump(): Promise<void> {
        return reader.read().then(({ done, value }) => {
          if (value) buf += decoder.decode(value, { stream: !done })
          // Parse SSE lines
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            try {
              const msg = JSON.parse(line.slice(6)) as { type: string; data: string }
              if (msg.type === 'stdout' || msg.type === 'stderr' || msg.type === 'start') {
                setInstallLog(prev => prev + msg.data)
              } else if (msg.type === 'done') {
                setInstallLog(prev => prev + msg.data)
                setInstallOk(true)
                setPackages(prev => prev.includes(pkg) ? prev : [...prev, pkg])
                setPackageInput('')
                setInstalling(false)
              } else if (msg.type === 'error') {
                setInstallLog(prev => prev + msg.data)
                setInstallOk(false)
                setInstalling(false)
              }
            } catch { /* ignore malformed */ }
          }
          if (done) { setInstalling(false); return }
          return pump()
        })
      }
      return pump()
    }).catch(err => {
      setInstallLog(`✗ ${err.message}`)
      setInstallOk(false)
      setInstalling(false)
    })
  }

  // Auto-scroll log to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [installLog])

  function updateAlias(idx: number, field: 'key' | 'value', val: string) {
    setAliases(prev => prev.map((e, i) => i === idx ? { ...e, [field]: val } : e))
  }

  function removeAlias(idx: number) {
    setAliases(prev => prev.filter((_, i) => i !== idx))
  }

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div
        style={{ ...modalStyles.dialog, width: 520, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>⚙ Project Settings</span>
          <button style={modalStyles.closeBtn} onClick={onClose}>×</button>
        </div>

        {/* Body */}
        <div style={{ ...modalStyles.body, overflowY: 'auto', gap: 20 }}>

          {/* Path Aliases */}
          <section>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ ...modalStyles.title, fontSize: 12 }}>Path Aliases</span>
              {projectRoot && (
                <button
                  style={{ ...s.smallBtn, opacity: detectLoading ? 0.6 : 1 }}
                  disabled={detectLoading}
                  onClick={detectFromTsconfig}
                >
                  {detectLoading ? 'Detecting…' : '↙ Auto-detect from tsconfig.json'}
                </button>
              )}
            </div>
            <p style={s.hint}>
              Map import prefixes (e.g. <code style={s.code}>@</code>) to absolute paths in your project.
              Changes require a page reload.
            </p>

            {aliases.length === 0 && (
              <div style={s.empty}>No aliases configured.</div>
            )}

            {aliases.map((entry, idx) => (
              <div key={idx} style={s.aliasRow}>
                <input
                  style={{ ...modalStyles.input, width: 90, fontFamily: 'monospace', fontSize: 12 }}
                  value={entry.key}
                  onChange={e => updateAlias(idx, 'key', e.target.value)}
                  placeholder="@"
                  spellCheck={false}
                />
                <span style={{ color: '#6c7086', fontSize: 13 }}>→</span>
                <input
                  style={{ ...modalStyles.input, flex: 1, fontFamily: 'monospace', fontSize: 11 }}
                  value={entry.value}
                  onChange={e => updateAlias(idx, 'value', e.target.value)}
                  placeholder="/absolute/path/to/src"
                  spellCheck={false}
                />
                <button style={s.removeBtn} onClick={() => removeAlias(idx)}>×</button>
              </div>
            ))}

            <button
              style={{ ...s.smallBtn, marginTop: 6 }}
              onClick={() => setAliases(prev => [...prev, { key: '', value: '' }])}
            >
              + Add alias
            </button>
          </section>

          {/* Packages */}
          <section>
            <span style={{ ...modalStyles.title, fontSize: 12, display: 'block', marginBottom: 8 }}>
              Install Dev Packages
            </span>
            <p style={s.hint}>
              Install packages (e.g. <code style={s.code}>next</code>) into the builder so framework
              imports resolve correctly. Requires a page reload after installing.
            </p>

            {pendingInstallPackages.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ ...s.hint, color: '#f38ba8', marginBottom: 6 }}>
                  Missing imports — click to install:
                </div>
                <div style={s.packageList}>
                  {pendingInstallPackages.map(pkg => (
                    <button
                      key={pkg}
                      style={{ ...s.packageChip, background: '#2a1010', color: '#f38ba8', border: '1px solid #4a1010', cursor: 'pointer' }}
                      onClick={() => setPackageInput(pkg)}
                      title={`Click to queue ${pkg} for install`}
                    >
                      + {pkg}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {detectedPackages.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ ...s.hint, color: '#f9e2af', marginBottom: 6 }}>
                  Detected in project — click to install:
                </div>
                <div style={s.packageList}>
                  {detectedPackages.map(pkg => (
                    <button
                      key={pkg}
                      style={{ ...s.packageChip, background: '#2a2210', color: '#f9e2af', border: '1px solid #4a3a10', cursor: 'pointer' }}
                      onClick={() => setPackageInput(pkg)}
                      title={`Click to queue ${pkg} for install`}
                    >
                      + {pkg}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {packages.length > 0 && (
              <div style={s.packageList}>
                {packages.map(p => (
                  <span key={p} style={s.packageChip}>{p}</span>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input
                style={{ ...modalStyles.input, flex: 1 }}
                value={packageInput}
                onChange={e => setPackageInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !installing && installPackage()}
                placeholder="package-name"
                spellCheck={false}
                disabled={installing}
              />
              <button
                style={{ ...modalStyles.submitBtn, opacity: installing || !packageInput.trim() ? 0.6 : 1, minWidth: 90 }}
                disabled={installing || !packageInput.trim()}
                onClick={installPackage}
              >
                {installing ? 'Installing…' : 'Install'}
              </button>
            </div>

            {installLog && (
              <div style={s.logBox}>
                <pre style={s.logPre}>{installLog}</pre>
                <div ref={logEndRef} />
                {!installing && installOk !== null && (
                  <div style={{ borderTop: '1px solid #313244', padding: '4px 8px', fontSize: 11, color: installOk ? '#a6e3a1' : '#f38ba8' }}>
                    {installOk ? '✓ Done — click Save & Reload to apply' : '✗ Install failed'}
                  </div>
                )}
              </div>
            )}
          </section>

          {error && <div style={modalStyles.error}>{error}</div>}
          {saveMsg && <div style={{ ...s.msg, background: '#1a2420', color: '#a6e3a1' }}>{saveMsg}</div>}

          {/* Node modules dirs (read-only info) */}
          {nodeModulesDirs.length > 0 && (
            <section>
              <span style={{ ...modalStyles.title, fontSize: 12, display: 'block', marginBottom: 6 }}>
                Package Resolution Paths
              </span>
              <p style={s.hint}>These node_modules directories are searched when resolving package imports (e.g. <code style={s.code}>next/navigation</code>).</p>
              {nodeModulesDirs.map(d => (
                <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ ...s.hint, fontFamily: 'monospace', fontSize: 10, color: '#a6adc8', margin: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d}</span>
                  <button style={s.removeBtn} onClick={() => setNodeModulesDirs(prev => prev.filter(x => x !== d))}>×</button>
                </div>
              ))}
            </section>
          )}

          {/* CSS / Style Sheets */}
          <section>
            <span style={{ ...modalStyles.title, fontSize: 12, display: 'block', marginBottom: 4 }}>CSS / Style Sheets</span>
            <p style={s.hint}>
              Load CSS or Tailwind stylesheet files from the child app into the preview
              (e.g. <code style={s.code}>globals.css</code>, <code style={s.code}>tailwind.css</code>).
              Changes require a page reload.
            </p>
            {cssFiles.map((f, idx) => (
              <div key={idx} style={s.aliasRow}>
                <input
                  style={{ ...modalStyles.input, flex: 1, fontFamily: 'monospace', fontSize: 11 }}
                  value={f}
                  onChange={e => setCssFiles(prev => prev.map((x, i) => i === idx ? e.target.value : x))}
                  placeholder="/absolute/path/to/globals.css"
                  spellCheck={false}
                />
                <button style={s.removeBtn} onClick={() => setCssFiles(prev => prev.filter((_, i) => i !== idx))}>×</button>
              </div>
            ))}
            <button
              style={{ ...s.smallBtn, marginTop: 6 }}
              onClick={() => setCssFiles(prev => [...prev, ''])}
            >
              + Add CSS file
            </button>
          </section>

          {/* Public / Static Assets */}
          <section>
            <span style={{ ...modalStyles.title, fontSize: 12, display: 'block', marginBottom: 4 }}>Public / Static Assets</span>
            <p style={s.hint}>
              Directories served as additional static roots (like Next.js <code style={s.code}>public/</code>).
              Requests like <code style={s.code}>/assets/images/logo.png</code> will be resolved from these folders.
              Changes require a page reload.
            </p>
            {publicDirs.map((d, idx) => (
              <div key={idx} style={s.aliasRow}>
                <input
                  style={{ ...modalStyles.input, flex: 1, fontFamily: 'monospace', fontSize: 11 }}
                  value={d}
                  onChange={e => setPublicDirs(prev => prev.map((x, i) => i === idx ? e.target.value : x))}
                  placeholder="/absolute/path/to/public"
                  spellCheck={false}
                />
                <button style={s.removeBtn} onClick={() => setPublicDirs(prev => prev.filter((_, i) => i !== idx))}>×</button>
              </div>
            ))}
            <button
              style={{ ...s.smallBtn, marginTop: 6 }}
              onClick={() => setPublicDirs(prev => [...prev, ''])}
            >
              + Add public directory
            </button>
          </section>

          {/* Fonts */}
          <section>
            <span style={{ ...modalStyles.title, fontSize: 12, display: 'block', marginBottom: 4 }}>Fonts</span>
            <p style={s.hint}>
              Stylesheet URLs (e.g. Google Fonts <code style={s.code}>fonts.googleapis.com/css2?family=…</code>)
              injected as <code style={s.code}>&lt;link rel="stylesheet"&gt;</code> tags into the preview page.
              Changes require a page reload.
            </p>
            {fontLinks.map((f, idx) => (
              <div key={idx} style={s.aliasRow}>
                <input
                  style={{ ...modalStyles.input, flex: 1, fontFamily: 'monospace', fontSize: 11 }}
                  value={f}
                  onChange={e => setFontLinks(prev => prev.map((x, i) => i === idx ? e.target.value : x))}
                  placeholder="https://fonts.googleapis.com/css2?family=…"
                  spellCheck={false}
                />
                <button style={s.removeBtn} onClick={() => setFontLinks(prev => prev.filter((_, i) => i !== idx))}>×</button>
              </div>
            ))}
            <button
              style={{ ...s.smallBtn, marginTop: 6 }}
              onClick={() => setFontLinks(prev => [...prev, ''])}
            >
              + Add font link
            </button>
          </section>

          {/* Source Directories */}
          {projectRoot && (
            <section>
              <span style={{ ...modalStyles.title, fontSize: 12, display: 'block', marginBottom: 4 }}>Source Directories</span>
              <p style={s.hint}>
                Override where Cockpit looks for pages, components, and expressions.
                Leave blank to use the defaults (<code style={s.code}>src/pages</code>, <code style={s.code}>src/components</code>, <code style={s.code}>src/expressions</code>).
              </p>
              <DirPickerField
                label="Pages directory"
                value={projectDirs.pagesDir}
                onChange={v => setProjectDirs(p => ({ ...p, pagesDir: v }))}
              />
              <DirPickerField
                label="Components directory"
                value={projectDirs.componentsDir}
                onChange={v => setProjectDirs(p => ({ ...p, componentsDir: v }))}
              />
              <DirPickerField
                label="Expressions directory"
                value={projectDirs.expressionsDir}
                onChange={v => setProjectDirs(p => ({ ...p, expressionsDir: v }))}
              />
            </section>
          )}
        </div>

        {/* Footer */}
        <div style={{ ...modalStyles.actions, padding: '0.75rem 1rem', borderTop: '1px solid #313244', flexShrink: 0 }}>
          <button style={modalStyles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            style={{ ...modalStyles.submitBtn, opacity: saving ? 0.6 : 1 }}
            disabled={saving}
            onClick={() => save(false)}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            style={{ ...modalStyles.submitBtn, background: '#89b4fa', opacity: saving ? 0.6 : 1 }}
            disabled={saving}
            onClick={() => save(true)}
          >
            Save & Reload
          </button>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  hint: {
    margin: '0 0 8px',
    fontSize: 11,
    color: '#6c7086',
    fontFamily: 'system-ui, sans-serif',
    lineHeight: 1.5,
  },
  code: {
    fontFamily: 'monospace',
    background: '#313244',
    padding: '1px 4px',
    borderRadius: 3,
    color: '#cdd6f4',
  },
  aliasRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  removeBtn: {
    background: 'none',
    border: 'none',
    color: '#6c7086',
    fontSize: 16,
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: 1,
    flexShrink: 0,
  },
  smallBtn: {
    background: 'rgba(203,214,244,0.07)',
    border: '1px solid rgba(203,214,244,0.12)',
    borderRadius: 5,
    color: '#a6adc8',
    fontSize: 11,
    fontFamily: 'system-ui, sans-serif',
    padding: '3px 10px',
    cursor: 'pointer',
  },
  empty: {
    color: '#45475a',
    fontSize: 12,
    fontFamily: 'system-ui, sans-serif',
    fontStyle: 'italic',
    marginBottom: 8,
  },
  packageList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 4,
  },
  packageChip: {
    background: '#313244',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#a6e3a1',
  },
  msg: {
    borderRadius: 6,
    padding: '0.4rem 0.6rem',
    fontSize: 11,
    fontFamily: 'system-ui, sans-serif',
  },
  logBox: {
    marginTop: 8,
    background: '#11111b',
    border: '1px solid #313244',
    borderRadius: 6,
    maxHeight: 220,
    overflowY: 'auto' as const,
    display: 'flex',
    flexDirection: 'column' as const,
  },
  logPre: {
    margin: 0,
    padding: '8px 10px',
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#cdd6f4',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
    flex: 1,
  },
}

const inputStyle: React.CSSProperties = {
  background: '#1e1e2e',
  border: '1px solid #313244',
  borderRadius: 5,
  color: '#cdd6f4',
  padding: '4px 8px',
  fontSize: 12,
  outline: 'none',
  fontFamily: 'system-ui, sans-serif',
}

const dpS: Record<string, React.CSSProperties> = {
  popover: {
    marginTop: 4,
    background: '#1e1e2e',
    border: '1px solid #45475a',
    borderRadius: 6,
    maxHeight: 220,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 8px',
    borderBottom: '1px solid #313244',
    position: 'sticky',
    top: 0,
    background: '#1e1e2e',
  },
  entry: {
    background: 'none',
    border: 'none',
    borderBottom: '1px solid #181825',
    color: '#cdd6f4',
    textAlign: 'left',
    padding: '4px 10px',
    fontSize: 11,
    fontFamily: 'monospace',
    cursor: 'pointer',
  },
  footer: {
    padding: '6px 8px',
    borderTop: '1px solid #313244',
    position: 'sticky',
    bottom: 0,
    background: '#1e1e2e',
  },
}
