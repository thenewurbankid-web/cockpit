import { useEffect, useRef, useState, useCallback } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FieldDef {
  name: string
  type: string
  optional: boolean
}

interface PageScope {
  id: string
  props: FieldDef[]
}

interface ServiceInterface {
  name: string
  fields: FieldDef[]
}

interface ServiceScope {
  id: string
  interfaces: ServiceInterface[]
}

type FieldSource =
  | { kind: 'page'; pageId: string; prop: string }
  | { kind: 'service'; serviceId: string; interface: string; field: string }
  | null

interface ContextField {
  name: string
  type: string
  optional: boolean
  source: FieldSource
}

interface ManualForm {
  name: string
  type: string
  optional: boolean
}

interface EventPayloadField {
  name: string
  type: string
  optional: boolean
}

interface MachineEvent {
  type: string
  payload: EventPayloadField[]
}

interface StateTransition {
  event: string
  target?: string
  hasGuard: boolean
  actionCount: number
}

interface MachineStateDetail {
  name: string
  stateType: string
  entryCount: number
  exitCount: number
  transitions: StateTransition[]
}

interface MachineAction {
  state: string
  trigger: string
  assigns: string[]
}

interface FlowPanelProps {
  flowId: string
  featureId: string
  projectRoot: string
  width: number
  selectedState?: string | null
  stateEventNames?: string[]
  onClose: () => void
}

// ── Palette ───────────────────────────────────────────────────────────────────

const LINK_COLORS = ['#a6e3a1', '#89dceb', '#cba6f7', '#fab387', '#f9e2af', '#94e2d5', '#f38ba8', '#89b4fa']

const BG = '#1e1e2e'
const SURFACE = '#181825'
const BORDER = '#313244'
const MUTED = '#6c7086'
const TEXT = '#cdd6f4'
const BLUE = '#89b4fa'
const GREEN = '#a6e3a1'
const PURPLE = '#cba6f7'
const ORANGE = '#fab387'
const TEAL = '#89dceb'
const RED = '#f38ba8'

// ── Shared style atoms ────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  background: '#11111b', border: `1px solid ${BORDER}`, borderRadius: 4,
  color: TEXT, fontSize: 12, fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  padding: '4px 8px', outline: 'none', width: '100%', boxSizing: 'border-box' as const,
}

const iconBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: MUTED, cursor: 'pointer',
  fontSize: 14, lineHeight: 1, padding: '0 3px', flexShrink: 0,
}

const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, width: '100%',
  background: '#1e1e2e', border: 'none', padding: '0.4rem 0.8rem', cursor: 'pointer',
  textAlign: 'left' as const, userSelect: 'none',
}
const chevronStyle: React.CSSProperties = { fontSize: '0.65rem', color: '#6c7086', width: 12, flexShrink: 0 }
const accordionLabelStyle: React.CSSProperties = { fontSize: '0.72rem', fontWeight: 600, color: '#cdd6f4', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

// ── Helpers ───────────────────────────────────────────────────────────────────

function sourceBadge(source: FieldSource, color?: string) {
  if (!source) return null
  if (source.kind === 'page') {
    const c = color ?? BLUE
    return (
      <span style={{
        fontSize: 10, fontFamily: 'monospace',
        background: c + '1e', border: `1px solid ${c}48`,
        borderRadius: 4, padding: '1px 6px', color: c,
        display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0,
      }}>
        <span style={{ color: c + 'aa' }}>{source.pageId}</span>
        <span style={{ color: c + 'aa' }}>&#8250;</span>
        <span>{source.prop}</span>
      </span>
    )
  }
  const c = color ?? PURPLE
  return (
    <span style={{
      fontSize: 10, fontFamily: 'monospace',
      background: c + '1e', border: `1px solid ${c}48`,
      borderRadius: 4, padding: '1px 6px', color: c,
      display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0,
    }}>
      <span style={{ color: c + 'aa' }}>{source.serviceId}</span>
      <span style={{ color: c + 'aa' }}>&#8250;</span>
      <span>{source.field}</span>
    </span>
  )
}

function BadgeEl({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' as const,
      color, background: color + '18', border: `1px solid ${color}40`,
      borderRadius: 3, padding: '1px 5px', flexShrink: 0,
    }}>{label}</span>
  )
}

function CountChip({ n, color }: { n: number; color: string }) {
  return (
    <span style={{
      fontSize: 9, color, background: color + '14', border: `1px solid ${color}30`,
      borderRadius: 10, padding: '1px 6px', flexShrink: 0,
    }}>{n}</span>
  )
}

// ── Sub-component ─────────────────────────────────────────────────────────────

function PayloadFieldRow({ f, i, onChange, onRemove }: {
  f: EventPayloadField; i: number
  onChange: (i: number, field: Partial<EventPayloadField>) => void
  onRemove: (i: number) => void
}) {
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
      <input
        value={f.name} placeholder="name"
        onChange={e => onChange(i, { name: e.target.value })}
        style={{ ...inputStyle, flex: 1 }}
      />
      <input
        value={f.type} placeholder="type"
        onChange={e => onChange(i, { type: e.target.value })}
        style={{ ...inputStyle, flex: 1 }}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: MUTED, cursor: 'pointer', flexShrink: 0 }}>
        <input type="checkbox" checked={f.optional} onChange={e => onChange(i, { optional: e.target.checked })} />
        opt
      </label>
      <button onClick={() => onRemove(i)} style={iconBtnStyle}>x</button>
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function FlowPanel({ flowId, featureId, projectRoot, width, selectedState, stateEventNames, onClose }: FlowPanelProps) {
  // Machine data
  const [events, setEvents] = useState<MachineEvent[]>([])
  const [actions, setActions] = useState<MachineAction[]>([])

  // Machine accordion + tabs
  const [machineOpen, setMachineOpen] = useState(false)
  const [machineTab, setMachineTab] = useState<'events' | 'actions'>('events')

  // Events UI
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null)
  const [editingEvent, setEditingEvent] = useState<MachineEvent | null>(null)
  const [showAddEvent, setShowAddEvent] = useState(false)
  const [newEvent, setNewEvent] = useState<MachineEvent>({ type: '', payload: [] })
  const [savingEvents, setSavingEvents] = useState(false)

  // Actions UI
  const [actionsView, setActionsView] = useState<'by-state' | 'all'>('by-state')

  // Context fields
  const [fields, setFields] = useState<ContextField[]>([])
  const [scope, setScope] = useState<{ pages: PageScope[]; services: ServiceScope[] }>({ pages: [], services: [] })
  const [scopePickerOpen, setScopePickerOpen] = useState(false)
  const [pageScopeOpen, setPageScopeOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const [manual, setManual] = useState<ManualForm>({ name: '', type: '', optional: false })

  // Source
  const [sourceOpen, setSourceOpen] = useState(false)
  const [sourceCode, setSourceCode] = useState<string | null>(null)
  const [sourceOriginal, setSourceOriginal] = useState<string | null>(null)
  const [sourceEdited, setSourceEdited] = useState<string | null>(null)
  const [sourceSaving, setSourceSaving] = useState(false)
  const [sourceSaveStatus, setSourceSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const sourceEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const sourceMonacoRef = useRef<typeof import('monaco-editor') | null>(null)
  const sourceDiagTimerRef = useRef<number | null>(null)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Data loading

  const loadMachineData = useCallback(() => {
    if (!projectRoot || !featureId || !flowId) return
    void fetch(
      `/__source/flow-machine-details?projectRoot=${encodeURIComponent(projectRoot)}&featureId=${encodeURIComponent(featureId)}&flowId=${encodeURIComponent(flowId)}`
    )
      .then(r => r.json())
      .then(d => {
        setEvents(d.events ?? [])
        setActions(d.actions ?? [])
      })
      .catch(() => {})
  }, [projectRoot, featureId, flowId])

  useEffect(() => {
    if (!projectRoot || !featureId || !flowId) return
    loadMachineData()
    void fetch(
      `/__source/flow-context?projectRoot=${encodeURIComponent(projectRoot)}&featureId=${encodeURIComponent(featureId)}&flowId=${encodeURIComponent(flowId)}`
    )
      .then(r => r.json())
      .then(d => setFields(d.fields ?? []))
      .catch(() => {})
  }, [projectRoot, featureId, flowId, loadMachineData])

  useEffect(() => {
    if (!projectRoot || !featureId) return
    void fetch(
      `/__source/feature-scope?projectRoot=${encodeURIComponent(projectRoot)}&featureId=${encodeURIComponent(featureId)}`
    )
      .then(r => r.json())
      .then(d => setScope({ pages: d.pages ?? [], services: d.services ?? [] }))
      .catch(() => {})
  }, [projectRoot, featureId])

  useEffect(() => {
    if (!projectRoot || !featureId || !flowId) return
    const file = `${projectRoot}/src/features/${featureId}/${flowId}.machine.ts`.replace(/\\/g, '/')
    void fetch(`/__source?file=${encodeURIComponent(file)}`)
      .then(r => r.ok ? r.text() : Promise.reject())
      .then(text => { setSourceCode(text); setSourceOriginal(text); setSourceEdited(null) })
      .catch(() => setSourceCode(null))
  }, [projectRoot, featureId, flowId])

  // Reset edits when selected state changes
  useEffect(() => { setSourceEdited(null) }, [selectedState])

  function extractStateBlock(source: string, stateName: string): { text: string; start: number; end: number; startLine: number } | null {
    const pattern = new RegExp(`(?<![\\w])${stateName}\\s*:`)
    const match = pattern.exec(source)
    if (!match) return null
    const openIdx = source.indexOf('{', match.index + match[0].length - 1)
    if (openIdx === -1) return null
    const startLine = source.slice(0, openIdx).split('\n').length
    let depth = 0
    let i = openIdx
    while (i < source.length) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') { depth--; if (depth === 0) return { text: source.slice(openIdx, i + 1), start: openIdx, end: i + 1, startLine } }
      i++
    }
    return null
  }

  async function syncSourceDiagnostics(fullContent: string, blockStartLine?: number) {
    const monaco = sourceMonacoRef.current
    const ed = sourceEditorRef.current
    if (!monaco || !ed) return
    const model = ed.getModel()
    if (!model) return
    const file = `${projectRoot}/src/features/${featureId}/${flowId}.machine.ts`.replace(/\\/g, '/')
    try {
      const res = await fetch('/__diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, content: fullContent }),
      })
      if (!res.ok) return
      const payload = await res.json()
      interface Diag { code: number; message: string; severity: number; startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
      const diags: Diag[] = payload.diagnostics ?? []
      const markers = blockStartLine != null
        ? diags
            .filter(d => d.endLineNumber >= blockStartLine && d.startLineNumber <= blockStartLine + model.getLineCount())
            .map(d => ({
              code: String(d.code),
              message: d.message,
              severity: d.severity,
              startLineNumber: Math.max(1, d.startLineNumber - blockStartLine + 1),
              startColumn: d.startColumn,
              endLineNumber: Math.max(1, d.endLineNumber - blockStartLine + 1),
              endColumn: d.endColumn,
            }))
        : diags.map(d => ({ code: String(d.code), message: d.message, severity: d.severity, startLineNumber: d.startLineNumber, startColumn: d.startColumn, endLineNumber: d.endLineNumber, endColumn: d.endColumn }))
      monaco.editor.setModelMarkers(model, 'server-tsc', markers)
    } catch { /* keep existing markers */ }
  }

  function scheduleSourceDiagnostics(fullContent: string, blockStartLine?: number) {
    if (sourceDiagTimerRef.current != null) window.clearTimeout(sourceDiagTimerRef.current)
    sourceDiagTimerRef.current = window.setTimeout(() => {
      void syncSourceDiagnostics(fullContent, blockStartLine)
    }, 400)
  }

  async function saveSource() {
    if (!sourceOriginal || !projectRoot || !featureId || !flowId) return
    if (sourceEdited === null) return
    setSourceSaving(true)
    const file = `${projectRoot}/src/features/${featureId}/${flowId}.machine.ts`.replace(/\\/g, '/')
    // If a state is selected, splice the edited block back into the full file
    let content = sourceEdited
    if (selectedState) {
      const block = extractStateBlock(sourceOriginal, selectedState)
      if (block) {
        content = sourceOriginal.slice(0, block.start) + sourceEdited + sourceOriginal.slice(block.end)
      }
    }
    try {
      const r = await fetch('/__source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, content }),
      })
      if (r.ok) {
        setSourceOriginal(content)
        setSourceEdited(null)
        setSourceSaveStatus('saved')
        setTimeout(() => setSourceSaveStatus('idle'), 2000)
      } else {
        setSourceSaveStatus('error')
      }
    } catch {
      setSourceSaveStatus('error')
    }
    setSourceSaving(false)
  }

  // Events actions

  async function commitEvents(next: MachineEvent[]) {
    setSavingEvents(true)
    await fetch('/__source/flow-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot, featureId, flowId, events: next }),
    }).catch(() => {})
    setSavingEvents(false)
    loadMachineData()
  }

  function saveEditingEvent() {
    if (!editingEvent || !editingEvent.type.trim()) return
    const next = events.map(e => e.type === expandedEvent ? editingEvent : e)
    setEvents(next)
    setExpandedEvent(null)
    setEditingEvent(null)
    void commitEvents(next)
  }

  function deleteEvent(type: string) {
    const next = events.filter(e => e.type !== type)
    setEvents(next)
    setExpandedEvent(null)
    setEditingEvent(null)
    void commitEvents(next)
  }

  function commitAddEvent() {
    if (!newEvent.type.trim()) return
    const eventType = newEvent.type.trim().toUpperCase().replace(/\s+/g, '_')
    const next = [...events, { ...newEvent, type: eventType }]
    setEvents(next)
    setShowAddEvent(false)
    setNewEvent({ type: '', payload: [] })
    void commitEvents(next)
  }

  function updateEditPayload(i: number, field: Partial<EventPayloadField>) {
    if (!editingEvent) return
    const payload = editingEvent.payload.map((p, idx) => idx === i ? { ...p, ...field } : p)
    setEditingEvent({ ...editingEvent, payload })
  }

  function updateNewPayload(i: number, field: Partial<EventPayloadField>) {
    const payload = newEvent.payload.map((p, idx) => idx === i ? { ...p, ...field } : p)
    setNewEvent({ ...newEvent, payload })
  }

  // Context fields

  const save = useCallback((nextFields: ContextField[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      setSaving(true)
      await fetch('/__source/flow-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRoot, featureId, flowId, fields: nextFields }),
      }).catch(() => {})
      setSaving(false)
    }, 400)
  }, [projectRoot, featureId, flowId])

  function addFromScope(field: FieldDef, src: FieldSource) {
    const next = [...fields, { name: field.name, type: field.type, optional: field.optional, source: src }]
    setFields(next)
    save(next)
    setScopePickerOpen(false)
  }

  function addManual() {
    if (!manual.name.trim() || !manual.type.trim()) return
    const next = [...fields, { name: manual.name.trim(), type: manual.type.trim(), optional: manual.optional, source: null }]
    setFields(next)
    save(next)
    setManual({ name: '', type: '', optional: false })
    setShowManual(false)
  }

  function removeField(idx: number) {
    const next = fields.filter((_, i) => i !== idx)
    setFields(next)
    save(next)
  }

  const addedNames = new Set(fields.map(f => f.name))
  const hasScope = scope.pages.some(p => p.props.length > 0) || scope.services.some(s => s.interfaces.some(i => i.fields.length > 0))

  const fieldColorMap = new Map<string, string>()
  fields.forEach((f, i) => { fieldColorMap.set(f.name, LINK_COLORS[i % LINK_COLORS.length]) })

  function toggleFromScope(prop: FieldDef, pageId: string) {
    const contextName = `${pageId}_${prop.name}`
    if (addedNames.has(contextName)) {
      removeField(fields.findIndex(f => f.name === contextName))
    } else {
      addFromScope({ ...prop, name: contextName }, { kind: 'page', pageId, prop: prop.name })
    }
  }

  // Render

  return (
    <div style={{
      position: 'fixed', right: 0, top: 0, bottom: 0, width,
      background: BG, borderLeft: `1px solid ${BORDER}`,
      display: 'flex', flexDirection: 'column',
      zIndex: 200, fontFamily: 'system-ui, sans-serif',
    }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: `1px solid ${BORDER}`, flexShrink: 0 }}>
        <span style={{ fontSize: 10, color: GREEN, fontWeight: 700, letterSpacing: 0.5 }}>FLOW</span>
        <span style={{ fontSize: 14, color: TEXT, fontWeight: 600, flex: 1 }}>{flowId}</span>
        {(saving || savingEvents) && <span style={{ fontSize: 10, color: MUTED }}>saving...</span>}
        {selectedState && (
          <span style={{ fontSize: 9, color: ORANGE, background: ORANGE + '14', border: `1px solid ${ORANGE}30`, borderRadius: 3, padding: '1px 6px', flexShrink: 0 }}>
            {selectedState}
          </span>
        )}
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: MUTED, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px' }}>x</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>

        {/* Scope + Context Fields */}
        <div style={{ borderBottom: `1px solid ${BORDER}` }}>
          <button onClick={() => setPageScopeOpen(o => !o)} style={{ ...sectionHeaderStyle, borderBottom: pageScopeOpen ? `1px solid ${BORDER}` : 'none' }}>
            <span style={chevronStyle}>{pageScopeOpen ? '▼' : '▶'}</span>
            <span style={accordionLabelStyle}>Scope</span>
          </button>
          {pageScopeOpen && (
            <>
              {/* Page props */}
              {scope.pages.filter(p => p.props.length > 0).map(page => (
                <div key={page.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px 4px', background: '#181825' }}>
                    <span style={{ fontSize: '0.72rem', color: MUTED }}>o {page.id}</span>
                    <span style={{ fontSize: '0.6rem', color: MUTED, background: 'transparent', border: '1px solid #45475a', borderRadius: 10, padding: '1px 7px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>page</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 4px', padding: '4px 14px 8px 22px' }}>
                    {page.props.map(prop => {
                      const contextName = `${page.id}_${prop.name}`
                      const added = addedNames.has(contextName)
                      const color = fieldColorMap.get(contextName)
                      return (
                        <div key={prop.name} onClick={() => toggleFromScope(prop, page.id)}
                          title={added ? `Remove "${contextName}" from context` : `Add "${contextName}" to context`}
                          style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: '0.71rem', color: added && color ? color : '#45475a', padding: '2px 7px', borderRadius: 99, cursor: 'pointer', background: added && color ? color + '14' : 'transparent', border: `1px solid ${added && color ? color + '60' : '#2a2a3d'}`, transition: 'all 0.12s' }}>
                          {added && color
                            ? <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
                            : <span style={{ fontSize: '0.5rem' }}>o</span>}
                          <code style={{ fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: '0.7rem', fontWeight: 500 }}>{prop.name}{prop.optional ? '?' : ''}</code>
                          {prop.type && <span style={{ fontSize: '0.62rem', color: added && color ? color : '#45475a', fontStyle: 'italic', marginLeft: 1 }}>{prop.type}</span>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}

              {/* Context Fields sub-section */}
              <div style={{ borderBottom: `1px solid ${BORDER}` }}>
                <div style={{ display: 'flex', alignItems: 'center', padding: '5px 12px 4px', background: '#181825', gap: 6 }}>
                  <span style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase' as const, color: '#45475a', flex: 1 }}>Context Fields</span>
                  {hasScope && (
                    <span onClick={e => { e.stopPropagation(); setScopePickerOpen(o => !o); setShowManual(false) }}
                      style={{ background: scopePickerOpen ? 'rgba(137,180,250,0.15)' : 'none', border: `1px solid ${scopePickerOpen ? BLUE : BORDER}`, borderRadius: 3, color: scopePickerOpen ? BLUE : MUTED, cursor: 'pointer', fontSize: 10, padding: '1px 7px' }}>
                      + from scope
                    </span>
                  )}
                  <span onClick={e => { e.stopPropagation(); setShowManual(o => !o); setScopePickerOpen(false) }}
                    style={{ background: showManual ? 'rgba(166,227,161,0.10)' : 'none', border: `1px solid ${showManual ? GREEN : BORDER}`, borderRadius: 3, color: showManual ? GREEN : MUTED, cursor: 'pointer', fontSize: 10, padding: '1px 7px' }}>
                    + manual
                  </span>
                </div>

                {scopePickerOpen && (
                  <div style={{ background: SURFACE, borderTop: `1px solid ${BORDER}`, padding: '8px 14px' }}>
                    {scope.pages.map(page => page.props.length === 0 ? null : (
                      <div key={page.id} style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: BLUE, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{page.id} (page)</div>
                        {page.props.map(prop => {
                          const already = addedNames.has(prop.name)
                          return (
                            <button key={prop.name} disabled={already}
                              onClick={() => addFromScope(prop, { kind: 'page', pageId: page.id, prop: prop.name })}
                              style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%', background: 'none', border: 'none', textAlign: 'left', cursor: already ? 'default' : 'pointer', opacity: already ? 0.4 : 1, padding: '3px 4px', borderRadius: 3 }}>
                              <span style={{ fontFamily: 'monospace', fontSize: 12, color: BLUE }}>{prop.name}{prop.optional ? '?' : ''}</span>
                              <span style={{ fontFamily: 'monospace', fontSize: 10, color: MUTED }}>: {prop.type}</span>
                              {already && <span style={{ fontSize: 10, color: MUTED, marginLeft: 'auto' }}>added</span>}
                            </button>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                )}

                {showManual && (
                  <div style={{ background: SURFACE, borderTop: `1px solid ${BORDER}`, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <input placeholder="field name" value={manual.name} onChange={e => setManual(m => ({ ...m, name: e.target.value }))} style={inputStyle} />
                    <input placeholder="type (e.g. string | null)" value={manual.type} onChange={e => setManual(m => ({ ...m, type: e.target.value }))} style={inputStyle} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: MUTED, cursor: 'pointer' }}>
                        <input type="checkbox" checked={manual.optional} onChange={e => setManual(m => ({ ...m, optional: e.target.checked }))} /> optional
                      </label>
                      <button onClick={addManual} disabled={!manual.name.trim() || !manual.type.trim()}
                        style={{ marginLeft: 'auto', background: manual.name.trim() && manual.type.trim() ? 'rgba(166,227,161,0.15)' : 'none', border: `1px solid ${manual.name.trim() && manual.type.trim() ? GREEN : BORDER}`, borderRadius: 3, color: manual.name.trim() && manual.type.trim() ? GREEN : MUTED, cursor: manual.name.trim() && manual.type.trim() ? 'pointer' : 'default', fontSize: 11, padding: '3px 12px' }}>
                        Add
                      </button>
                    </div>
                  </div>
                )}

                {fields.length === 0 && !scopePickerOpen && !showManual && (
                  <div style={{ padding: '8px 22px 10px', color: MUTED, fontSize: 11, fontStyle: 'italic' }}>No context fields yet.</div>
                )}

                {fields.map((field, idx) => {
                  const color = fieldColorMap.get(field.name)
                  return (
                    <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 14px 6px 22px', borderTop: `1px solid ${BORDER}` }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0 }}>
                          <span style={{ fontFamily: 'monospace', fontSize: 12, color: TEXT, flexShrink: 0 }}>{field.name}{field.optional ? '?' : ''}</span>
                          <span style={{ fontFamily: 'monospace', fontSize: 10, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>: {field.type}</span>
                        </div>
                        {field.source && <div style={{ marginTop: 2 }}>{sourceBadge(field.source, color)}</div>}
                      </div>
                      <button onClick={() => removeField(idx)} style={iconBtnStyle} title="Remove field">x</button>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
        <div style={{ borderBottom: `1px solid ${BORDER}` }}>
          <button onClick={() => setMachineOpen(o => !o)} style={{ ...sectionHeaderStyle, borderBottom: machineOpen ? `1px solid ${BORDER}` : 'none' }}>
            <span style={chevronStyle}>{machineOpen ? '▼' : '▶'}</span>
            <span style={accordionLabelStyle}>Machine</span>
            <span style={{ display: 'flex', gap: 4 }}>
              {events.length > 0 && <CountChip n={events.length} color={TEAL} />}
              {actions.length > 0 && <CountChip n={actions.length} color={PURPLE} />}
            </span>
          </button>

          {machineOpen && (
            <div>
              {/* Tab bar */}
              <div style={{ display: 'flex', borderBottom: `1px solid ${BORDER}` }}>
                {([['events', 'Events', TEAL, events.length], ['actions', 'Actions', PURPLE, actions.length]] as const).map(([tab, label, color, count]) => (
                  <button key={tab} onClick={() => setMachineTab(tab as 'events' | 'actions')}
                    style={{ flex: 1, padding: '6px 4px', background: 'none', border: 'none', borderBottom: machineTab === tab ? `2px solid ${color}` : '2px solid transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 600, color: machineTab === tab ? color : MUTED }}>{label}</span>
                    {count > 0 && <CountChip n={count} color={machineTab === tab ? color : MUTED} />}
                  </button>
                ))}
              </div>

              {machineTab === 'events' && (
            <div>
              {(() => {
                const displayEvents = selectedState && stateEventNames?.length
                  ? events.filter(e => stateEventNames!.includes(e.type))
                  : events
                return displayEvents.map(ev => (
                <div key={ev.type} style={{ borderTop: `1px solid ${BORDER}` }}>
                  <div
                    onClick={() => {
                      if (expandedEvent === ev.type) { setExpandedEvent(null); setEditingEvent(null) }
                      else { setExpandedEvent(ev.type); setEditingEvent({ type: ev.type, payload: ev.payload.map(p => ({ ...p })) }) }
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 14px', cursor: 'pointer' }}
                  >
                    <span style={{ fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: 11, color: TEAL, flex: 1 }}>{ev.type}</span>
                    {ev.payload.length > 0 && <span style={{ fontSize: 10, color: MUTED }}>+{ev.payload.length}</span>}
                    <span style={{ fontSize: 10, color: MUTED }}>{expandedEvent === ev.type ? 'A' : 'V'}</span>
                  </div>

                  {expandedEvent === ev.type && editingEvent && (
                    <div style={{ background: SURFACE, borderTop: `1px solid ${BORDER}`, padding: '10px 14px' }}>
                      <div style={{ marginBottom: 8 }}>
                        <label style={{ fontSize: 10, color: MUTED, display: 'block', marginBottom: 3 }}>Event type</label>
                        <input value={editingEvent.type} onChange={e => setEditingEvent(ev => ({ ...ev!, type: e.target.value }))} style={inputStyle} />
                      </div>
                      <div style={{ marginBottom: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
                          <label style={{ fontSize: 10, color: MUTED }}>Payload fields</label>
                          <button
                            onClick={() => setEditingEvent(ev => ({ ...ev!, payload: [...ev!.payload, { name: '', type: 'string', optional: false }] }))}
                            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: TEAL, fontSize: 11, cursor: 'pointer', padding: 0 }}
                          >+ field</button>
                        </div>
                        {editingEvent.payload.map((f, i) => (
                          <PayloadFieldRow key={i} f={f} i={i} onChange={updateEditPayload}
                            onRemove={idx => setEditingEvent(ev => ({ ...ev!, payload: ev!.payload.filter((_, pi) => pi !== idx) }))} />
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                        <button onClick={saveEditingEvent} disabled={!editingEvent.type.trim()}
                          style={{ flex: 1, padding: '4px 0', borderRadius: 4, fontSize: 12, cursor: 'pointer', background: 'rgba(137,220,235,0.12)', border: `1px solid ${TEAL}50`, color: TEAL }}>
                          Save
                        </button>
                        <button onClick={() => deleteEvent(ev.type)}
                          style={{ padding: '4px 12px', borderRadius: 4, fontSize: 12, cursor: 'pointer', background: 'rgba(243,139,168,0.10)', border: `1px solid ${RED}40`, color: RED }}>
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              )()}

              {showAddEvent ? (
                <div style={{ background: SURFACE, borderTop: `1px solid ${BORDER}`, padding: '10px 14px' }}>
                  <div style={{ marginBottom: 8 }}>
                    <label style={{ fontSize: 10, color: MUTED, display: 'block', marginBottom: 3 }}>Event type</label>
                    <input value={newEvent.type} placeholder="e.g. SUBMIT" onChange={e => setNewEvent(ev => ({ ...ev, type: e.target.value }))} style={inputStyle} autoFocus />
                  </div>
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
                      <label style={{ fontSize: 10, color: MUTED }}>Payload fields</label>
                      <button
                        onClick={() => setNewEvent(ev => ({ ...ev, payload: [...ev.payload, { name: '', type: 'string', optional: false }] }))}
                        style={{ marginLeft: 'auto', background: 'none', border: 'none', color: TEAL, fontSize: 11, cursor: 'pointer', padding: 0 }}
                      >+ field</button>
                    </div>
                    {newEvent.payload.map((f, i) => (
                      <PayloadFieldRow key={i} f={f} i={i} onChange={updateNewPayload}
                        onRemove={idx => setNewEvent(ev => ({ ...ev, payload: ev.payload.filter((_, pi) => pi !== idx) }))} />
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button onClick={commitAddEvent} disabled={!newEvent.type.trim()}
                      style={{ flex: 1, padding: '4px 0', borderRadius: 4, fontSize: 12, cursor: 'pointer', background: 'rgba(137,220,235,0.12)', border: `1px solid ${TEAL}50`, color: TEAL }}>
                      Add event
                    </button>
                    <button onClick={() => { setShowAddEvent(false); setNewEvent({ type: '', payload: [] }) }}
                      style={{ padding: '4px 12px', borderRadius: 4, fontSize: 12, cursor: 'pointer', background: 'none', border: `1px solid ${BORDER}`, color: MUTED }}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => { setShowAddEvent(true); setExpandedEvent(null) }}
                  style={{ ...sectionHeaderStyle, borderTop: `1px solid ${BORDER}`, padding: '6px 14px', color: MUTED, fontSize: 11 }}>
                  + New event
                </button>
              )}
            </div>
              )}

              {machineTab === 'actions' && (
              <div>
                {!selectedState && (
                <div style={{ display: 'flex', padding: '6px 14px', gap: 6, borderBottom: `1px solid ${BORDER}` }}>
                  {(['by-state', 'all'] as const).map(v => (
                    <button key={v} onClick={() => setActionsView(v)} style={{ padding: '2px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer', background: actionsView === v ? 'rgba(203,166,247,0.12)' : 'none', border: `1px solid ${actionsView === v ? PURPLE + '50' : BORDER}`, color: actionsView === v ? PURPLE : MUTED }}>
                      {v === 'by-state' ? 'By State' : 'All'}
                    </button>
                  ))}
                </div>
                )}

                {actionsView === 'all' && !selectedState && (
                  <div style={{ padding: '8px 14px' }}>
                    {actions.map((a, i) => (
                      <div key={i} style={{ marginBottom: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                          {a.state === '__global__'
                            ? <BadgeEl label="global" color={BLUE} />
                            : <span style={{ fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: 10, color: ORANGE }}>{a.state}</span>}
                          <span style={{ fontSize: 9, color: MUTED }}>.</span>
                          <BadgeEl label={a.trigger} color={TEAL} />
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, paddingLeft: 8 }}>
                          {a.assigns.map(k => (
                            <span key={k} style={{ fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: 10, color: GREEN, background: GREEN + '10', border: `1px solid ${GREEN}25`, borderRadius: 3, padding: '1px 5px' }}>{k}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* When a state is selected, show only that state's actions */}
                {selectedState && (() => {
                  const filtered = actions.filter(a => a.state === selectedState)
                  if (filtered.length === 0) return <div style={{ padding: '8px 14px', color: MUTED, fontSize: 11, fontStyle: 'italic' }}>No actions for this state.</div>
                  return (
                    <div style={{ padding: '8px 14px' }}>
                      {filtered.map((a, i) => (
                        <div key={i} style={{ marginBottom: 6 }}>
                          <div style={{ marginBottom: 2 }}><BadgeEl label={a.trigger} color={TEAL} /></div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, paddingLeft: 8 }}>
                            {a.assigns.map(k => (
                              <span key={k} style={{ fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: 10, color: GREEN, background: GREEN + '10', border: `1px solid ${GREEN}25`, borderRadius: 3, padding: '1px 5px' }}>{k}</span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                })()}

                {actionsView === 'by-state' && !selectedState && (() => {
                  const grouped = new Map<string, MachineAction[]>()
                  for (const a of actions) {
                    if (!grouped.has(a.state)) grouped.set(a.state, [])
                    grouped.get(a.state)!.push(a)
                  }
                  return (
                    <div>
                      {Array.from(grouped.entries()).map(([stateName, acts]) => (
                        <div key={stateName} style={{ borderTop: `1px solid ${BORDER}`, padding: '8px 14px' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: stateName === '__global__' ? BLUE : ORANGE, marginBottom: 5 }}>
                            {stateName === '__global__' ? '[ global ]' : stateName}
                          </div>
                          {acts.map((a, i) => (
                            <div key={i} style={{ marginBottom: 5, paddingLeft: 8 }}>
                              <div style={{ marginBottom: 2 }}><BadgeEl label={a.trigger} color={TEAL} /></div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, paddingLeft: 8 }}>
                                {a.assigns.map(k => (
                                  <span key={k} style={{ fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: 10, color: GREEN, background: GREEN + '10', border: `1px solid ${GREEN}25`, borderRadius: 3, padding: '1px 5px' }}>{k}</span>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </div>
              )}
            </div>
          )}
        </div>

        {/* Source */}
        <div style={{ borderBottom: `1px solid ${BORDER}` }}>
          <button onClick={() => setSourceOpen(o => !o)} style={{ ...sectionHeaderStyle, borderBottom: sourceOpen ? `1px solid ${BORDER}` : 'none' }}>
            <span style={chevronStyle}>{sourceOpen ? '▼' : '▶'}</span>
            <span style={{ ...accordionLabelStyle }}>Source</span>
            <span style={{ fontSize: '0.72rem', color: '#6c7086', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: 4 }}>
              {selectedState ? selectedState : `${flowId}.machine.ts`}
            </span>
            {(sourceEdited !== null) && <span style={{ fontSize: 9, color: ORANGE, marginLeft: 4 }}>●</span>}
          </button>
          {sourceOpen && (() => {
            const displayCode = (() => {
              if (sourceEdited !== null) return sourceEdited
              if (selectedState && sourceCode) {
                const block = extractStateBlock(sourceCode, selectedState)
                return block ? block.text : sourceCode
              }
              return sourceCode
            })()
            return (
              <div style={{ height: 300, display: 'flex', flexDirection: 'column' }}>
                {sourceCode === null
                  ? <div style={{ padding: '12px 14px', fontSize: 12, color: MUTED, fontStyle: 'italic' }}>Could not load file.</div>
                  : <Editor
                      height="100%"
                      language="typescript"
                      theme="vs-dark"
                      path={`file:///${projectRoot.replace(/\\/g, '/')}/src/features/${featureId}/${flowId}.machine.ts${selectedState ? `#${selectedState}` : ''}`}
                      value={displayCode ?? ''}
                      options={{
                        fontSize: 12,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        wordWrap: 'off',
                        lineNumbers: 'on' as const,
                      }}
                      onMount={(ed, monaco) => {
                        sourceEditorRef.current = ed
                        sourceMonacoRef.current = monaco
                        monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
                          noSemanticValidation: true,
                          noSyntaxValidation: true,
                        })
                        // Run initial diagnostics
                        if (sourceCode) {
                          const block = selectedState ? extractStateBlock(sourceCode, selectedState) : null
                          scheduleSourceDiagnostics(sourceCode, block?.startLine)
                        }
                      }}
                      onChange={(val) => {
                        if (val === undefined) return
                        const block = selectedState && sourceCode ? extractStateBlock(sourceCode, selectedState) : null
                        const original = block?.text ?? sourceOriginal ?? ''
                        setSourceEdited(val !== original ? val : null)
                        // Build full content for diagnostics
                        if (sourceCode) {
                          const fullContent = block
                            ? sourceCode.slice(0, block.start) + val + sourceCode.slice(block.end)
                            : val
                          scheduleSourceDiagnostics(fullContent, block?.startLine)
                        }
                      }}
                    />
                }
                {sourceEdited !== null && (
                  <div style={{ display: 'flex', gap: 6, padding: '6px 10px', borderTop: `1px solid ${BORDER}`, background: SURFACE, flexShrink: 0 }}>
                    {sourceSaveStatus === 'saved' && <span style={{ fontSize: 11, color: GREEN, flex: 1 }}>✓ Saved</span>}
                    {sourceSaveStatus === 'error' && <span style={{ fontSize: 11, color: RED, flex: 1 }}>✗ Error</span>}
                    {sourceSaveStatus === 'idle' && <span style={{ flex: 1 }} />}
                    <button
                      onClick={() => {
                        setSourceEdited(null)
                        const orig = selectedState && sourceCode
                          ? (extractStateBlock(sourceCode, selectedState)?.text ?? sourceCode)
                          : (sourceOriginal ?? '')
                        sourceEditorRef.current?.setValue(orig)
                      }}
                      style={{ padding: '3px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer', background: 'none', border: `1px solid ${BORDER}`, color: MUTED }}
                    >Discard</button>
                    <button
                      onClick={() => void saveSource()}
                      disabled={sourceSaving}
                      style={{ padding: '3px 12px', borderRadius: 4, fontSize: 11, cursor: 'pointer', background: 'rgba(166,227,161,0.12)', border: `1px solid ${GREEN}50`, color: GREEN }}
                    >{sourceSaving ? 'Saving…' : 'Save'}</button>
                  </div>
                )}
              </div>
            )
          })()}
        </div>

      </div>

      {/* Footer */}
      <div style={{ padding: '6px 14px', borderTop: `1px solid ${BORDER}`, fontSize: 10, color: MUTED, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        src/features/{featureId}/{flowId}.machine.ts
      </div>
    </div>
  )
}