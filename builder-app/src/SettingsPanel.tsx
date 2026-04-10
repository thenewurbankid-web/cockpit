import { useEffect, useRef, useState } from 'react'
import { modalStyles } from './appStyles'

interface SettingsPanelProps {
  projectRoot: string | null
  detectedPackages?: string[]
  pendingInstallPackages?: string[]
  locked?: boolean
  onClose: () => void
  onChangeProject?: () => void
  onProjectDirsChanged?: () => void
}

interface Settings {
  name?: string
  aliases: Record<string, string>
  packages: string[]
  nodeModulesDirs: string[]
  pagesDir?: string
  componentsDir?: string
  expressionsDir?: string
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
  label, value, projectRoot, onChange,
}: {
  label: string
  value: string
  projectRoot: string | null
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
    // Start browser at absolute path if value looks absolute; otherwise fall back to project root or default
    const startAt = value && (value.startsWith('/') || /^[A-Za-z]:/.test(value))
      ? value
      : projectRoot
        ? (value ? projectRoot.replace(/[/\\]$/, '') + '/' + value : projectRoot)
        : undefined
    browse(startAt)
  }

  function pickDir(name: string) {
    const sep = browsePath.endsWith('/') || browsePath.endsWith('\\') ? '' : '/'
    browse(browsePath + sep + name)
  }

  /** Convert absolute browsePath to a relative path if inside projectRoot. */
  function confirm() {
    let absPath = browsePath.replace(/\\/g, '/')
    if (projectRoot) {
      const rootNorm = projectRoot.replace(/\\/g, '/').replace(/\/$/, '')
      if (absPath.toLowerCase().startsWith(rootNorm.toLowerCase() + '/')) {
        absPath = absPath.slice(rootNorm.length + 1)
      } else if (absPath.toLowerCase() === rootNorm.toLowerCase()) {
        absPath = ''
      }
    }
    onChange(absPath)
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

export function SettingsPanel({ projectRoot, detectedPackages = [], pendingInstallPackages = [], locked = false, onClose, onChangeProject, onProjectDirsChanged }: SettingsPanelProps) {
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
  const [detectCssLoading, setDetectCssLoading] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'typescript' | 'packages' | 'css' | 'builder'>('typescript')
  const [addingDefaultExprs, setAddingDefaultExprs] = useState(false)
  const [addDefaultExprsResult, setAddDefaultExprsResult] = useState<Record<string, string> | null>(null)
  const logEndRef = useRef<HTMLDivElement>(null)

  // Project dependencies (from projectRoot/package.json)
  const [projectDeps, setProjectDeps] = useState<Record<string, string>>({})
  const [projectDevDeps, setProjectDevDeps] = useState<Record<string, string>>({})
  const [depsLoading, setDepsLoading] = useState(false)
  const [addDepInput, setAddDepInput] = useState('')
  const [addDepDev, setAddDepDev] = useState(true)
  const [addingDep, setAddingDep] = useState(false)
  const [addDepLog, setAddDepLog] = useState('')
  const [addDepOk, setAddDepOk] = useState<boolean | null>(null)
  const addDepLogEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!projectRoot) return
    fetch(`/__source/settings?root=${encodeURIComponent(projectRoot)}`)
      .then(r => r.json())
      .then((data: Settings) => {
        setAliases(settingsToEntries(data.aliases ?? {}))
        setPackages(data.packages ?? [])
        setNodeModulesDirs(data.nodeModulesDirs ?? [])
        setCssFiles(data.cssFiles ?? [])
        setPublicDirs(data.publicDirs ?? [])
        setFontLinks(data.fontLinks ?? [])
        setProjectDirs({
          pagesDir: data.pagesDir ?? '',
          componentsDir: data.componentsDir ?? '',
          expressionsDir: data.expressionsDir ?? '',
        })
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

  async function detectCssFiles() {
    if (!projectRoot) return
    setDetectCssLoading(true)
    setError(null)
    try {
      const res = await fetch(`/__source/detect-css?root=${encodeURIComponent(projectRoot)}`)
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Detection failed'); return }
      const detected: string[] = data.cssFiles ?? []
      if (detected.length === 0) { setError('No CSS files found in common locations'); return }
      // Merge: keep existing non-empty entries, add detected ones not already included
      setCssFiles(prev => {
        const existing = prev.filter(f => f.trim())
        const existingSet = new Set(existing.map(f => f.replace(/\\/g, '/')))
        const toAdd = detected.filter(f => !existingSet.has(f.replace(/\\/g, '/')))
        return [...existing, ...toAdd]
      })
    } finally {
      setDetectCssLoading(false)
    }
  }

  async function save(andReload = false) {
    if (!projectRoot) return
    setSaving(true)
    setSaveMsg(null)
    setError(null)
    try {
      const res = await fetch('/__source/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          root: projectRoot,
          aliases: entriesToAliases(aliases),
          packages,
          nodeModulesDirs,
          pagesDir: projectDirs.pagesDir,
          componentsDir: projectDirs.componentsDir,
          expressionsDir: projectDirs.expressionsDir,
          cssFiles,
          publicDirs,
          fontLinks,
        }),
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

  useEffect(() => {
    addDepLogEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [addDepLog])

  function fetchProjectDeps() {
    if (!projectRoot) return
    setDepsLoading(true)
    fetch(`/__source/project-deps-full?root=${encodeURIComponent(projectRoot)}`)
      .then(r => r.json())
      .then(data => {
        setProjectDeps(data.dependencies ?? {})
        setProjectDevDeps(data.devDependencies ?? {})
      })
      .catch(() => {})
      .finally(() => setDepsLoading(false))
  }

  useEffect(() => {
    if (activeTab === 'packages') fetchProjectDeps()
  }, [activeTab, projectRoot])

  function addDep() {
    const pkg = addDepInput.trim()
    if (!pkg || !projectRoot) return
    setAddingDep(true)
    setAddDepLog('')
    setAddDepOk(null)

    fetch('/__source/install-project-package', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageName: pkg, root: projectRoot, dev: addDepDev }),
    }).then(res => {
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      function pump(): Promise<void> {
        return reader.read().then(({ done, value }) => {
          if (value) buf += decoder.decode(value, { stream: !done })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            try {
              const msg = JSON.parse(line.slice(6)) as { type: string; data: string }
              if (msg.type === 'stdout' || msg.type === 'stderr' || msg.type === 'start') {
                setAddDepLog(prev => prev + msg.data)
              } else if (msg.type === 'done') {
                setAddDepLog(prev => prev + msg.data)
                setAddDepOk(true)
                setAddDepInput('')
                setAddingDep(false)
                fetchProjectDeps()
              } else if (msg.type === 'error') {
                setAddDepLog(prev => prev + msg.data)
                setAddDepOk(false)
                setAddingDep(false)
              }
            } catch { /* ignore */ }
          }
          if (done) { setAddingDep(false); return }
          return pump()
        })
      }
      return pump()
    }).catch(err => {
      setAddDepLog(`✗ ${err.message}`)
      setAddDepOk(false)
      setAddingDep(false)
    })
  }

  function updateAlias(idx: number, field: 'key' | 'value', val: string) {
    setAliases(prev => prev.map((e, i) => i === idx ? { ...e, [field]: val } : e))
  }

  function removeAlias(idx: number) {
    setAliases(prev => prev.filter((_, i) => i !== idx))
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: '#181825', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ ...modalStyles.header, padding: '0.85rem 1.5rem' }}>
          <span style={modalStyles.title}>⚙ Project Settings</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              style={{ ...modalStyles.cancelBtn, fontSize: 11, padding: '4px 12px' }}
              onClick={onChangeProject}
            >
              ⇄ Change project
            </button>
            {!locked && <button style={modalStyles.closeBtn} onClick={onClose}>×</button>}
          </div>
        </div>
        {locked && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            background: 'rgba(243,139,168,0.10)', borderBottom: '1px solid rgba(243,139,168,0.25)',
            padding: '10px 1.5rem', fontFamily: 'system-ui, sans-serif',
          }}>
            <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>⚠️</span>
            <span style={{ fontSize: 12, color: '#f38ba8', lineHeight: 1.6 }}>
              <strong>React or Next.js not detected in this project.</strong>{' '}
              Install React/Next.js in your project (<code style={{ fontFamily: 'monospace', background: 'rgba(243,139,168,0.12)', padding: '1px 4px', borderRadius: 3 }}>npm install react react-dom</code>),
              then configure the source directories below and click <strong>Save &amp; Reload</strong>.
            </span>
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #313244', background: '#181825', flexShrink: 0 }}>
          {(['typescript', 'packages', 'css', 'builder'] as const).map(tab => (
            <button
              key={tab}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: activeTab === tab ? '2px solid #89b4fa' : '2px solid transparent',
                color: activeTab === tab ? '#cdd6f4' : '#6c7086',
                cursor: 'pointer',
                fontFamily: 'system-ui, sans-serif',
                fontSize: 12,
                padding: '8px 18px',
                textTransform: 'capitalize',
                transition: 'color 0.1s',
              }}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ ...modalStyles.body, gap: 20, maxWidth: 720, margin: '0 auto', padding: '1.5rem' }}>

          {/* TypeScript tab */}
          {activeTab === 'typescript' && <>

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

          </>}

          {/* Packages tab */}
          {activeTab === 'packages' && <>

          {/* Project Dependencies */}
          <section>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ ...modalStyles.title, fontSize: 12 }}>Project Dependencies</span>
              <button style={{ ...s.smallBtn, opacity: depsLoading ? 0.6 : 1 }} disabled={depsLoading} onClick={fetchProjectDeps}>
                {depsLoading ? 'Loading…' : '↻ Refresh'}
              </button>
            </div>

            {/* Add dependency row */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center' }}>
              <input
                style={{ ...modalStyles.input, flex: 1, fontFamily: 'monospace', fontSize: 11 }}
                value={addDepInput}
                onChange={e => setAddDepInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !addingDep && addDep()}
                placeholder="package-name or package@version"
                spellCheck={false}
                disabled={addingDep}
              />
              <button
                style={{
                  ...s.smallBtn,
                  background: addDepDev ? 'rgba(203,214,244,0.07)' : 'rgba(166,227,161,0.12)',
                  color: addDepDev ? '#a6adc8' : '#a6e3a1',
                  border: `1px solid ${addDepDev ? 'rgba(203,214,244,0.12)' : 'rgba(166,227,161,0.25)'}`,
                  minWidth: 60,
                }}
                onClick={() => setAddDepDev(v => !v)}
                title="Toggle between devDependency and dependency"
              >
                {addDepDev ? 'dev' : 'dep'}
              </button>
              <button
                style={{ ...modalStyles.submitBtn, opacity: addingDep || !addDepInput.trim() ? 0.6 : 1, minWidth: 70 }}
                disabled={addingDep || !addDepInput.trim()}
                onClick={addDep}
              >
                {addingDep ? 'Adding…' : '+ Add'}
              </button>
            </div>

            {addDepLog && (
              <div style={{ ...s.logBox, marginBottom: 12 }}>
                <pre style={s.logPre}>{addDepLog}</pre>
                <div ref={addDepLogEndRef} />
                {!addingDep && addDepOk !== null && (
                  <div style={{ borderTop: '1px solid #313244', padding: '4px 8px', fontSize: 11, color: addDepOk ? '#a6e3a1' : '#f38ba8' }}>
                    {addDepOk ? '✓ Installed' : '✗ Failed'}
                  </div>
                )}
              </div>
            )}

            {depsLoading && Object.keys(projectDeps).length === 0 && Object.keys(projectDevDeps).length === 0 && (
              <div style={{ color: '#45475a', fontSize: 12, fontStyle: 'italic', fontFamily: 'system-ui, sans-serif' }}>Loading…</div>
            )}

            {/* dependencies */}
            {Object.keys(projectDeps).length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: '#a6adc8', fontFamily: 'system-ui, sans-serif', marginBottom: 4 }}>
                  dependencies ({Object.keys(projectDeps).length})
                </div>
                <div style={s.depTable}>
                  {Object.entries(projectDeps).map(([name, version]) => (
                    <div key={name} style={s.depRow}>
                      <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#cdd6f4', flex: 1 }}>{name}</span>
                      <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#6c7086' }}>{version}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* devDependencies */}
            {Object.keys(projectDevDeps).length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: '#a6adc8', fontFamily: 'system-ui, sans-serif', marginBottom: 4 }}>
                  devDependencies ({Object.keys(projectDevDeps).length})
                </div>
                <div style={s.depTable}>
                  {Object.entries(projectDevDeps).map(([name, version]) => (
                    <div key={name} style={s.depRow}>
                      <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#cdd6f4', flex: 1 }}>{name}</span>
                      <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#6c7086' }}>{version}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!depsLoading && Object.keys(projectDeps).length === 0 && Object.keys(projectDevDeps).length === 0 && (
              <div style={s.empty}>No dependencies found in package.json.</div>
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

          </>}

          {/* CSS tab */}
          {activeTab === 'css' && <>

          {/* CSS / Style Sheets */}
          <section>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ ...modalStyles.title, fontSize: 12 }}>CSS / Style Sheets</span>
              <button
                style={{ ...s.smallBtn, opacity: detectCssLoading ? 0.6 : 1 }}
                disabled={detectCssLoading}
                onClick={detectCssFiles}
              >
                {detectCssLoading ? 'Detecting…' : 'Auto-detect'}
              </button>
            </div>
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

          </>}

          {/* Builder tab */}
          {activeTab === 'builder' && <>

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
                projectRoot={projectRoot}
                onChange={v => setProjectDirs(p => ({ ...p, pagesDir: v }))}
              />
              <DirPickerField
                label="Components directory"
                value={projectDirs.componentsDir}
                projectRoot={projectRoot}
                onChange={v => setProjectDirs(p => ({ ...p, componentsDir: v }))}
              />
              <DirPickerField
                label="Expressions directory"
                value={projectDirs.expressionsDir}
                projectRoot={projectRoot}
                onChange={v => setProjectDirs(p => ({ ...p, expressionsDir: v }))}
              />
            </section>
          )}

          {/* Default Expressions */}
          {projectRoot && (
            <section>
              <span style={{ ...modalStyles.title, fontSize: 12, display: 'block', marginBottom: 4 }}>Default Expressions</span>
              <p style={s.hint}>
                Add the built-in expression components to this project's expressions directory:
                <code style={s.code}>IfExpression</code>, <code style={s.code}>ElseExpression</code>, <code style={s.code}>IfElseExpression</code>, <code style={s.code}>LoopExpression</code>, <code style={s.code}>SwitchExpression</code>.
                Files that already exist are skipped.
              </p>
              {addDefaultExprsResult && (
                <div style={{ marginBottom: 8 }}>
                  {Object.entries(addDefaultExprsResult).map(([name, status]) => (
                    <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontFamily: 'monospace', color: status === 'created' ? '#a6e3a1' : status === 'exists' ? '#6c7086' : '#f38ba8', marginBottom: 2 }}>
                      <span>{status === 'created' ? '✓' : status === 'exists' ? '–' : '✗'}</span>
                      <span>{name}</span>
                      <span style={{ color: '#585b70' }}>{status === 'created' ? 'created' : status === 'exists' ? 'already exists' : 'denied'}</span>
                    </div>
                  ))}
                </div>
              )}
              <button
                style={{ ...modalStyles.submitBtn, opacity: addingDefaultExprs ? 0.6 : 1, cursor: addingDefaultExprs ? 'not-allowed' : 'pointer' }}
                disabled={addingDefaultExprs}
                onClick={async () => {
                  setAddingDefaultExprs(true)
                  setAddDefaultExprsResult(null)
                  try {
                    const res = await fetch('/__source/add-default-expressions', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ projectRoot }),
                    })
                    const data = await res.json()
                    if (data.results) setAddDefaultExprsResult(data.results)
                  } catch { /* ignore */ } finally {
                    setAddingDefaultExprs(false)
                  }
                }}
              >
                {addingDefaultExprs ? 'Adding…' : 'Add default expressions'}
              </button>
            </section>
          )}

          </>}
        </div>
        </div>

        {/* Footer */}
        <div style={{ ...modalStyles.actions, padding: '0.75rem 1.5rem', borderTop: '1px solid #313244', flexShrink: 0 }}>
          {!locked && <button style={modalStyles.cancelBtn} onClick={onClose}>Cancel</button>}
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
  depTable: {
    background: '#11111b',
    border: '1px solid #313244',
    borderRadius: 6,
    overflow: 'hidden',
  },
  depRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 10px',
    borderBottom: '1px solid #1e1e2e',
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
