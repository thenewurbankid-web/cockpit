import { useCallback, useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import { scopeStyles } from './styles'
import type { ScopeLayer } from './types'

interface StateEntry {
  key: string
  label: string
}

function defaultForType(typeStr: string): string {
  const t = typeStr.trim().toLowerCase()
  if (t === 'boolean') return 'false'
  if (t === 'number') return '0'
  if (t.endsWith('[]') || t.startsWith('array<')) return '[]'
  if (t === 'object' || t.startsWith('{')) return '{}'
  return ''
}

/** Return true if a default value string looks like an expression rather than a plain literal.
 * States only hold plain values — bindings/expressions belong in source code, not state data. */
function isExpression(val: string): boolean {
  if (!val) return false
  const v = val.trim()
  // string literal — plain value
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return false
  // numeric / boolean literal
  if (v === 'true' || v === 'false' || /^-?\d+(\.\d+)?$/.test(v)) return false
  // everything else: operators, function calls, ternaries, identifiers → treat as expression
  return true
}

interface StatesPanelProps {
  pageName: string
  projectRoot: string
  onStateChange: (props: Record<string, string>, switched?: boolean) => void
  scopeLayers?: ScopeLayer[]
}

export function StatesPanel({ pageName, projectRoot, onStateChange, scopeLayers = [] }: StatesPanelProps) {
  const [states, setStates] = useState<StateEntry[]>([])
  const [activeKey, setActiveKey] = useState<string>('')
  const [data, setData] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [addingState, setAddingState] = useState(false)
  const [newStateName, setNewStateName] = useState('')
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [newFieldKey, setNewFieldKey] = useState('')
  const [newFieldValue, setNewFieldValue] = useState('')
  const [expanded, setExpanded] = useState(true)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dataRef = useRef<Record<string, string>>({})
  const activeKeyRef = useRef<string>('')
  const loadingRef = useRef(false)
  const onStateChangeRef = useRef(onStateChange)
  useEffect(() => { onStateChangeRef.current = onStateChange }, [onStateChange])

  const qs = `projectRoot=${encodeURIComponent(projectRoot)}&page=${encodeURIComponent(pageName)}`

  const loadStates = useCallback(async () => {
    if (!projectRoot || !pageName) return
    setLoading(true)
    try {
      const res = await fetch(`/__source/list-states?${qs}`)
      const json = await res.json()
      const list: StateEntry[] = json.states ?? []
      setStates(list)
      if (list.length > 0) {
        const current = activeKeyRef.current
        const next = list.some(s => s.key === current) ? current : list[0].key
        setActiveKey(next)
        // Eagerly load data for the first state so the preview updates on mount
        if (next !== current) {
          void loadDataRef.current(next)
        }
      } else {
        setActiveKey('')
        setData({})
        dataRef.current = {}
      }
    } catch (e) {
      console.error('[StatesPanel] loadStates error', e)
      setStates([])
    } finally {
      setLoading(false)
    }
  }, [projectRoot, pageName])

  const scheduleSave = useCallback((nextData: Record<string, string>, key: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try {
        await fetch('/__source/state-data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectRoot, page: pageName, state: key, data: nextData }),
        })
      } catch { /* best-effort */ }
    }, 400)
  }, [projectRoot, pageName])

  const flushSave = useCallback((key: string) => {
    if (!saveTimer.current) return
    clearTimeout(saveTimer.current)
    saveTimer.current = null
    const snapshot = { ...dataRef.current }
    void fetch('/__source/state-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot, page: pageName, state: key, data: snapshot }),
    }).catch(() => { /* best-effort */ })
  }, [projectRoot, pageName])

  const flushSaveRef = useRef(flushSave)
  useEffect(() => { flushSaveRef.current = flushSave }, [flushSave])

  const loadDataRef = useRef<(key: string) => Promise<void>>(async () => {})

  const loadData = useCallback(async (key: string) => {
    if (!key) return
    flushSaveRef.current(activeKeyRef.current)
    activeKeyRef.current = key
    loadingRef.current = true
    try {
      const res = await fetch(`/__source/state-data?${qs}&state=${encodeURIComponent(key)}`)
      const json = await res.json()
      const d = json.data ?? {}
      if (activeKeyRef.current !== key) return
      dataRef.current = d
      setData(d)
      onStateChangeRef.current(d, true)
    } catch {
      if (activeKeyRef.current !== key) return
      dataRef.current = {}
      setData({})
    } finally {
      if (activeKeyRef.current === key) loadingRef.current = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs])
  useEffect(() => { loadDataRef.current = loadData }, [loadData])

  useEffect(() => { loadStates() }, [loadStates])
  useEffect(() => { if (activeKey) loadData(activeKey) }, [activeKey, loadData])

  const updateData = useCallback((nextData: Record<string, string>) => {
    dataRef.current = nextData
    setData(nextData)
    onStateChangeRef.current(nextData)
    scheduleSave(nextData, activeKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, scheduleSave])

  const handleFieldValueChange = (fieldKey: string, value: string) => {
    updateData({ ...data, [fieldKey]: value })
  }

  const handleDeleteField = (fieldKey: string) => {
    const next = { ...data }
    delete next[fieldKey]
    updateData(next)
  }

  const handleAddField = () => {
    const k = newFieldKey.trim()
    if (!k || k in data) return
    const next = { ...data, [k]: newFieldValue }
    updateData(next)
    setNewFieldKey('')
    setNewFieldValue('')
  }

  const handleCreateState = async () => {
    const name = newStateName.trim().replace(/\s+/g, '_').toLowerCase()
    if (!name) return
    try {
      const res = await fetch('/__source/create-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRoot, page: pageName, stateName: name }),
      })
      if (!res.ok) return
      // Auto-populate: copy current state data (if any), then fill in any missing props/state with defaults
      const rootLayer = scopeLayers[0]
      const rootFields = rootLayer ? [...rootLayer.props, ...rootLayer.state] : []
      const scopeData: Record<string, string> = rootLayer
        ? Object.fromEntries(rootFields.map(item => [
            item.name,
            item.name in dataRef.current ? dataRef.current[item.name] : ((item.defaultValue && !isExpression(item.defaultValue)) ? item.defaultValue : defaultForType(item.typeStr))
          ]))
        : {}
      if (Object.keys(scopeData).length > 0) {
        await fetch('/__source/state-data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectRoot, page: pageName, state: name, data: scopeData }),
        })
      }
      setNewStateName('')
      setAddingState(false)
      await loadStates()
      setActiveKey(name)
    } catch { /* best-effort */ }
  }

  const handleDeleteState = async () => {
    if (!activeKey) return
    try {
      await fetch(`/__source/state?${qs}&state=${encodeURIComponent(activeKey)}`, { method: 'DELETE' })
      await loadStates()
    } catch { /* best-effort */ }
  }

  const handleRenameState = async (oldKey: string, newKey: string) => {
    const trimmed = newKey.trim().replace(/\s+/g, '_').toLowerCase()
    if (!trimmed || trimmed === oldKey) { setRenamingKey(null); return }
    try {
      const res = await fetch('/__source/rename-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRoot, page: pageName, oldName: oldKey, newName: trimmed }),
      })
      if (!res.ok) return
      setRenamingKey(null)
      await loadStates()
      setActiveKey(trimmed)
    } catch { /* best-effort */ }
  }

  const handleMoveState = async (direction: 'up' | 'down') => {
    const idx = states.findIndex(s => s.key === activeKey)
    if (idx < 0) return
    const newIdx = direction === 'up' ? idx - 1 : idx + 1
    if (newIdx < 0 || newIdx >= states.length) return
    const next = [...states]
    ;[next[idx], next[newIdx]] = [next[newIdx], next[idx]]
    setStates(next)
    try {
      await fetch('/__source/reorder-states', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRoot, page: pageName, order: next.map(s => s.key) }),
      })
    } catch { /* best-effort */ }
  }

  const inputStyle: React.CSSProperties = {
    background: '#181825',
    border: '1px solid #313244',
    borderRadius: 3,
    color: '#cdd6f4',
    padding: '2px 5px',
    fontSize: 11,
    fontFamily: 'monospace',
    outline: 'none',
    minWidth: 0,
  }

  const btnStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    color: '#6c7086',
    cursor: 'pointer',
    fontSize: 13,
    padding: '0 3px',
    lineHeight: 1,
    flexShrink: 0,
  }

  if (!pageName || !projectRoot) return null

  return (
    <div style={{ borderTop: '1px solid #1e1e2e', background: '#13131f' }}>
      {/* Header */}
      <div
        style={{ ...scopeStyles.header, cursor: 'pointer' }}
        onClick={() => setExpanded(v => !v)}
      >
        <span style={scopeStyles.chevron}>{expanded ? '▾' : '▸'}</span>
        <span>States</span>
        {loading && <span style={{ color: '#45475a', fontSize: '0.6rem', fontWeight: 400 }}>…</span>}
        <button
          style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#89b4fa', fontSize: 14, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
          title="Add state"
          onClick={(e) => { e.stopPropagation(); setAddingState(true); setNewStateName('') }}
        >+</button>
      </div>

      {expanded && (
        <div style={{ padding: '6px 10px 8px', display: 'flex', flexDirection: 'column', gap: 5 }}>

          {/* New state name input */}
          {addingState && (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                autoFocus
                style={{ ...inputStyle, flex: 1 }}
                placeholder="state name (e.g. loading)"
                value={newStateName}
                onChange={e => setNewStateName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void handleCreateState()
                  if (e.key === 'Escape') setAddingState(false)
                }}
              />
              <button
                style={{ ...btnStyle, color: '#a6e3a1', fontSize: 11 }}
                onClick={() => void handleCreateState()}
              >✓</button>
              <button
                style={{ ...btnStyle, fontSize: 11 }}
                onClick={() => setAddingState(false)}
              >✕</button>
            </div>
          )}

          {/* State dropdown + rename + delete */}
          {states.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {renamingKey === activeKey ? (
                <input
                  autoFocus
                  style={{ ...inputStyle, flex: 1 }}
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void handleRenameState(activeKey, renameValue)
                    if (e.key === 'Escape') setRenamingKey(null)
                  }}
                  onBlur={() => void handleRenameState(activeKey, renameValue)}
                />
              ) : (
                <select
                  value={activeKey}
                  onChange={e => setActiveKey(e.target.value)}
                  style={{
                    ...inputStyle,
                    flex: 1,
                    cursor: 'pointer',
                    padding: '3px 5px',
                  }}
                >
                  {states.map(s => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>
              )}
              <button
                style={{ ...btnStyle, fontSize: 15, padding: '2px 4px', color: '#6c7086', opacity: states.findIndex(s => s.key === activeKey) === 0 ? 0.25 : 1 }}
                title="Move up"
                disabled={states.findIndex(s => s.key === activeKey) === 0}
                onClick={() => void handleMoveState('up')}
              >▲</button>
              <button
                style={{ ...btnStyle, fontSize: 15, padding: '2px 4px', color: '#6c7086', opacity: states.findIndex(s => s.key === activeKey) === states.length - 1 ? 0.25 : 1 }}
                title="Move down"
                disabled={states.findIndex(s => s.key === activeKey) === states.length - 1}
                onClick={() => void handleMoveState('down')}
              >▼</button>
              <button
                style={{ ...btnStyle, color: renamingKey === activeKey ? '#a6e3a1' : '#89b4fa' }}
                title={renamingKey === activeKey ? 'Confirm rename' : 'Rename state'}
                onClick={() => {
                  if (renamingKey === activeKey) { void handleRenameState(activeKey, renameValue) }
                  else { setRenamingKey(activeKey); setRenameValue(activeKey) }
                }}
              >{renamingKey === activeKey ? '✓' : '✎'}</button>
              <button
                style={{ ...btnStyle, color: '#f38ba8' }}
                title="Delete state"
                onClick={() => void handleDeleteState()}
              >×</button>
            </div>
          ) : !addingState && (
            <div style={{ fontSize: 11, color: '#45475a', textAlign: 'center', padding: '4px 0' }}>
              No states — click + to add one
            </div>
          )}

          {/* Data field rows */}
          {activeKey && Object.entries(data).map(([fieldKey, fieldValue]) => (
            <div key={fieldKey} style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
              <span style={{ ...inputStyle, width: 90, flexShrink: 0, display: 'inline-flex', alignItems: 'center', color: '#a6adc8', userSelect: 'none', overflow: 'hidden' }}>{fieldKey}</span>
              <span style={{ color: '#45475a', flexShrink: 0 }}>:</span>
              <div style={{ flex: 1, height: 20, minWidth: 0, borderRadius: 3, overflow: 'hidden', border: '1px solid #313244' }}>
                <Editor
                  height={20}
                  language="javascript"
                  theme="vs-dark"
                  value={fieldValue}
                  onChange={v => handleFieldValueChange(fieldKey, v ?? '')}
                  options={{
                    fontSize: 11,
                    lineNumbers: 'off',
                    minimap: { enabled: false },
                    scrollbar: { vertical: 'hidden', horizontal: 'hidden', handleMouseWheel: false },
                    overviewRulerLanes: 0,
                    scrollBeyondLastLine: false,
                    wordWrap: 'off',
                    renderLineHighlight: 'none',
                    glyphMargin: false,
                    folding: false,
                    lineDecorationsWidth: 0,
                    lineNumbersMinChars: 0,
                    padding: { top: 2, bottom: 2 },
                  }}
                />
              </div>
              <button
                style={{ ...btnStyle, color: '#585b70' }}
                title="Remove field"
                onClick={() => handleDeleteField(fieldKey)}
              >×</button>
            </div>
          ))}

          {/* Add field row — dropdown constrained to root props+state not yet in data */}
          {activeKey && (() => {
            const rootLayer = scopeLayers[0]
            const rootFields = rootLayer ? [...rootLayer.props, ...rootLayer.state] : []
            const available = rootFields.filter(f => !(f.name in data))
            if (available.length === 0) return null
            const effectiveKey = newFieldKey || available[0].name
            return (
              <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                <select
                  style={{ ...inputStyle, width: 90, flexShrink: 0, cursor: 'pointer' }}
                  value={newFieldKey}
                  onChange={e => setNewFieldKey(e.target.value)}
                >
                  {available.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
                </select>
                <span style={{ color: '#45475a', flexShrink: 0 }}>:</span>
                <div style={{ flex: 1, height: 20, minWidth: 0, borderRadius: 3, overflow: 'hidden', border: '1px solid #313244' }}>
                  <Editor
                    height={20}
                    language="javascript"
                    theme="vs-dark"
                    value={newFieldValue}
                    onChange={v => setNewFieldValue(v ?? '')}
                    options={{
                      fontSize: 11,
                      lineNumbers: 'off',
                      minimap: { enabled: false },
                      scrollbar: { vertical: 'hidden', horizontal: 'hidden', handleMouseWheel: false },
                      overviewRulerLanes: 0,
                      scrollBeyondLastLine: false,
                      wordWrap: 'off',
                      renderLineHighlight: 'none',
                      glyphMargin: false,
                      folding: false,
                      lineDecorationsWidth: 0,
                      lineNumbersMinChars: 0,
                      padding: { top: 2, bottom: 2 },
                    }}
                  />
                </div>
                <button
                  style={{ ...btnStyle, color: '#a6e3a1', fontSize: 11 }}
                  title="Add field"
                  onClick={() => { const k = newFieldKey || available[0].name; const next = { ...data, [k]: newFieldValue }; updateData(next); setNewFieldKey(''); setNewFieldValue('') }}
                >+</button>
              </div>
            )
          })()}

        </div>
      )}
    </div>
  )
}
