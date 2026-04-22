import { useEffect, useRef, useState, useCallback } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import type { FeaturePage } from './types'

// ── Module-level Monaco type cache (loaded once per session) ─────────────────
let _monacoTypesLoaded = false
const _monacoTypesQueue: Array<() => void> = []
async function ensureMonacoTypes(monacoInstance: unknown, projectRoot: string) {
  if (_monacoTypesLoaded) return
  _monacoTypesLoaded = true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = monacoInstance as any
  const ts = m.languages.typescript.typescriptDefaults
  ts.setCompilerOptions({
    target: m.languages.typescript.ScriptTarget.ES2020,
    module: m.languages.typescript.ModuleKind.ESNext,
    moduleResolution: m.languages.typescript.ModuleResolutionKind.NodeJs,
    jsx: m.languages.typescript.JsxEmit.ReactJSX,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    strict: false,
  })
  ts.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
  const packages = ['xstate', '@xstate/react', 'react']
  for (const pkg of packages) {
    try {
      const r = await fetch(`/__source/pkg-types?projectRoot=${encodeURIComponent(projectRoot)}&pkg=${encodeURIComponent(pkg)}`)
      if (!r.ok) continue
      const { files } = await r.json() as { files: { path: string; content: string }[] }
      for (const f of files ?? []) ts.addExtraLib(f.content, f.path)
    } catch { /* non-fatal */ }
  }
  _monacoTypesQueue.forEach(fn => fn())
  _monacoTypesQueue.length = 0
}

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
  actions: string[]
  assignTargets: string[]
  isInvoke?: boolean
  invokeActorId?: string | null
}

interface MachineStateDetail {
  name: string
  stateType: string
  entryCount: number
  exitCount: number
  entryActions: string[]
  exitActions: string[]
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
  linkedPages?: FeaturePage[]
  iframeWindow?: Window | null
  onClose: () => void
  onSimStart?: (pageId: string) => void
  onSimStop?: () => void
  onSimMockChange?: (data: Record<string, unknown>) => void
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

export function FlowPanel({ flowId, featureId, projectRoot, width, selectedState, stateEventNames, linkedPages, iframeWindow, onClose, onSimStart, onSimStop, onSimMockChange }: FlowPanelProps) {
  // Machine data
  const [events, setEvents] = useState<MachineEvent[]>([])
  const [states, setStates] = useState<MachineStateDetail[]>([])
  const [actions, setActions] = useState<MachineAction[]>([])

  // Machine accordion + tabs
  const [machineOpen, setMachineOpen] = useState(false)
  const [machineTab, setMachineTab] = useState<'events' | 'states' | 'actions'>('events')

  // States tab UI
  const [expandedStateName, setExpandedStateName] = useState<string | null>(null)
  type TransitionActionKind = 'assign' | 'raise' | 'sendTo' | 'log' | 'cancel' | 'stopChild' | 'forwardTo' | 'named'
  const [addTransitionForm, setAddTransitionForm] = useState<{ stateName: string; event: string; target: string; guard: string; actionKind?: TransitionActionKind; actionParams?: Record<string, string>; showAction?: boolean } | null>(null)
  const [addActionForm, setAddActionForm] = useState<{ stateName: string; kind: 'entry' | 'exit'; value: string } | null>(null)
  const [addTransitionActionForm, setAddTransitionActionForm] = useState<{
    stateName: string
    event: string
    kind: 'assign' | 'raise' | 'sendTo' | 'log' | 'cancel' | 'stopChild' | 'forwardTo' | 'named'
    params: Record<string, string>
  } | null>(null)
  const [addStateName, setAddStateName] = useState('')
  const [showAddState, setShowAddState] = useState(false)

  // Snippet toast
  const [lastSnippet, setLastSnippet] = useState<string | null>(null)
  const snippetTimerRef = useRef<number | null>(null)

  // Simulation
  const [simOpen, setSimOpen] = useState(false)
  const [simActive, setSimActive] = useState(false)
  // Live actor state (from cockpit:machine-state postMessage bridge)
  const [simState, setSimState] = useState<string | null>(null)
  const [simContext, setSimContext] = useState<Record<string, unknown>>({})
  const [simHistory, setSimHistory] = useState<Array<{ from: string; event: string; to: string }>>([])
  const prevSimStateRef = useRef<string | null>(null)
  // Simulation preview: page + mocks
  const [simPage, setSimPage] = useState<string | null>(null)
  const [simMocks, setSimMocks] = useState<Array<{ key: string; label: string }>>([])
  const [simMock, setSimMock] = useState<string | null>(null)
  const [simMockLabel, setSimMockLabel] = useState<string | null>(null)
  const [simMockData, setSimMockData] = useState<Record<string, unknown> | null>(null)
  const [simEventForm, setSimEventForm] = useState<{ event: string; values: Record<string, string> } | null>(null)
  const [invokePrompt, setInvokePrompt] = useState<{ actor: string; input: Record<string, unknown>; errorMsg: string } | null>(null)
  const simMocksLoadedFor = useRef<string | null>(null)

  // Actor
  const [actorOpen, setActorOpen] = useState(false)
  const [actorSource, setActorSource] = useState<string | null>(null)

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
        setStates(d.states ?? [])
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

  // Load actor source file
  useEffect(() => {
    if (!projectRoot || !featureId || !flowId) return
    const file = `${projectRoot}/src/features/${featureId}/${flowId}.actor.ts`.replace(/\\/g, '/')
    void fetch(`/__source?file=${encodeURIComponent(file)}`)
      .then(r => r.ok ? r.text() : Promise.reject())
      .then(text => setActorSource(text))
      .catch(() => setActorSource(null))
  }, [projectRoot, featureId, flowId])

  // Reset simulation when flow changes
  useEffect(() => { setSimState(null); setSimHistory([]); setSimActive(false); prevSimStateRef.current = null }, [flowId])

  // Listen for live actor state from the preview iframe via cockpit:machine-state postMessage bridge
  useEffect(() => {
    function handleMsg(e: MessageEvent) {
      if (e.data?.type === 'cockpit:machine-state') {
        const newState = String(e.data.value)
        const ctx = (e.data.context ?? {}) as Record<string, unknown>
        if (prevSimStateRef.current !== null && prevSimStateRef.current !== newState) {
          setSimHistory(h => [...h, { from: prevSimStateRef.current!, event: '—', to: newState }])
        }
        prevSimStateRef.current = newState
        setSimState(newState)
        setSimContext(ctx)
      }
      if (e.data?.type === 'cockpit:invoke-pending') {
        const actor = String(e.data.actor ?? '')
        const input = (e.data.input ?? {}) as Record<string, unknown>
        setInvokePrompt({ actor, input, errorMsg: '' })
      }
      if (e.data?.type === 'cockpit:invoke-done') {
        setInvokePrompt(null)
      }
    }
    window.addEventListener('message', handleMsg)
    return () => window.removeEventListener('message', handleMsg)
  }, [])

  // Auto-select the first linked page (only sets the picker — does NOT start simulation)
  useEffect(() => {
    if (simPage) return
    const first = linkedPages?.[0]?.id ?? null
    if (first) { setSimPage(first); simMocksLoadedFor.current = null }
  }, [linkedPages]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load mocks when simPage changes
  useEffect(() => {
    if (!simPage || !projectRoot || simMocksLoadedFor.current === simPage) return
    simMocksLoadedFor.current = simPage
    void fetch(`/__source/list-states?projectRoot=${encodeURIComponent(projectRoot)}&page=${encodeURIComponent(simPage)}`)
      .then(r => r.ok ? r.json() : { states: [] })
      .then(d => {
        const mocks = (d.states ?? []).map((s: { key: string; label?: string }) => ({ key: s.key, label: s.label ?? s.key }))
        setSimMocks(mocks)
        if (mocks.length > 0) setSimMock(mocks[0].key)
      })
      .catch(() => {})
  }, [simPage, projectRoot])

  // Push mock data to iframe when mock changes
  useEffect(() => {
    if (!simMock || !simPage || !projectRoot || !onSimMockChange) return
    void fetch(`/__source/state-data?projectRoot=${encodeURIComponent(projectRoot)}&page=${encodeURIComponent(simPage)}&state=${encodeURIComponent(simMock)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) { const props = (d.data ?? d) as Record<string, unknown>; onSimMockChange(props); setSimMockData(props); setSimContext(props) } })
      .catch(() => {})
  }, [simMock, simPage, projectRoot, onSimMockChange])

  // Snippet toast helper
  function showSnippet(snippet: string) {
    setLastSnippet(snippet)
    if (snippetTimerRef.current !== null) clearTimeout(snippetTimerRef.current)
    snippetTimerRef.current = window.setTimeout(() => { setLastSnippet(null); snippetTimerRef.current = null }, 5000)
  }

  // States tab: toggle initial
  async function handleSetInitial(stateName: string) {
    const r = await fetch('/__source/flow-initial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot, featureId, flowId, stateName }),
    })
    const d = await r.json()
    if (d.ok) { loadMachineData(); if (d.snippet) showSnippet(d.snippet) }
  }

  // States tab: toggle state type
  async function handleSetStateType(stateName: string, stateType: string | null) {
    const r = await fetch('/__source/flow-state-type', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot, featureId, flowId, stateName, stateType }),
    })
    const d = await r.json()
    if (d.ok) { loadMachineData(); if (d.snippet) showSnippet(d.snippet) }
  }

  // States tab: add/replace transition
  async function handleAddTransition(stateName: string, event: string, target: string, guard: string, actionKind?: string, actionParams?: Record<string, string>) {
    const r = await fetch('/__source/flow-transition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot, featureId, flowId, stateName, event, target: target || undefined, guard: guard || undefined }),
    })
    const d = await r.json()
    if (d.ok) {
      if (actionKind && actionParams) {
        const code = buildActionCode(actionKind as Parameters<typeof buildActionCode>[0], actionParams)
        if (code) {
          await fetch('/__source/flow-transition-actions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectRoot, featureId, flowId, stateName, event, actions: [code] }),
          })
        }
      }
      loadMachineData(); setAddTransitionForm(null); if (d.snippet) showSnippet(d.snippet)
    }
  }

  // States tab: remove transition
  async function handleDeleteTransition(stateName: string, event: string) {
    const r = await fetch(
      `/__source/flow-transition?projectRoot=${encodeURIComponent(projectRoot)}&featureId=${encodeURIComponent(featureId)}&flowId=${encodeURIComponent(flowId)}&stateName=${encodeURIComponent(stateName)}&event=${encodeURIComponent(event)}`,
      { method: 'DELETE' }
    )
    const d = await r.json()
    if (d.ok) loadMachineData()
  }

  // States tab: save entry/exit actions
  async function handleSaveStateActions(stateName: string, entry: string[], exit: string[]) {
    const r = await fetch('/__source/flow-state-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot, featureId, flowId, stateName, entry, exit }),
    })
    const d = await r.json()
    if (d.ok) { loadMachineData(); if (d.snippet) showSnippet(d.snippet) }
  }

  // States tab: set actions on a transition event
  async function handleSetTransitionActions(stateName: string, event: string, actions: string[]) {
    const r = await fetch('/__source/flow-transition-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot, featureId, flowId, stateName, event, actions }),
    })
    const d = await r.json()
    if (d.ok) { loadMachineData(); setAddTransitionActionForm(null); if (d.snippet) showSnippet(d.snippet) }
  }

  // Build action code string from form
  function buildActionCode(kind: string, params: Record<string, string>): string {
    switch (kind) {
      case 'assign': {
        const key = params.key ?? 'value'
        const val = params.value ?? ''
        // If value looks like an arrow function or expression, use it directly; otherwise quote it
        const valCode = val.includes('=>') || val.includes('(') ? val : JSON.stringify(val)
        return `assign({ ${key}: ${valCode} })`
      }
      case 'raise':
        return `raise({ type: '${params.eventType ?? 'EVENT'}' })`
      case 'sendTo':
        return `sendTo('${params.actorId ?? 'actor'}', { type: '${params.eventType ?? 'EVENT'}' })`
      case 'log':
        return params.expr ? `log(${params.expr})` : `log('${params.message ?? ''}')`
      case 'cancel':
        return `cancel('${params.delayId ?? 'delayedEvent'}')`
      case 'stopChild':
        return `stopChild('${params.actorId ?? 'actor'}')`
      case 'forwardTo':
        return `forwardTo('${params.actorId ?? 'actor'}')`
      case 'named':
        return `'${params.name ?? 'myAction'}'`
      default:
        return `'${kind}'`
    }
  }

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
      const r = await fetch('/__source/flow-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRoot, featureId, flowId, fields: nextFields }),
      }).catch(() => null)
      if (r?.ok) {
        const d = await r.json().catch(() => ({})) as { createdControllers?: string[] }
        if (d.createdControllers?.length) {
          showSnippet(`Controller created: ${d.createdControllers.map((f: string) => f.split('/').slice(-2).join('/')).join(', ')}`)
        }
      }
      setSaving(false)
    }, 400)
  }, [projectRoot, featureId, flowId]) // eslint-disable-line react-hooks/exhaustive-deps

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
                {([['events', 'Events', TEAL, events.length], ['states', 'States', GREEN, states.length], ['actions', 'Actions', PURPLE, actions.length]] as const).map(([tab, label, color, count]) => (
                  <button key={tab} onClick={() => setMachineTab(tab as 'events' | 'states' | 'actions')}
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

              {machineTab === 'states' && (
              <div>
                {/* States list */}
                {states.length === 0
                  ? <div style={{ padding: '10px 14px', color: MUTED, fontSize: 11, fontStyle: 'italic' }}>No states found.</div>
                  : states.map(st => {
                    const isExpanded = expandedStateName === st.name
                    const typeBadgeColor = st.stateType === 'final' ? RED : st.stateType === 'parallel' ? PURPLE : st.stateType === 'history' ? ORANGE : MUTED
                    return (
                      <div key={st.name} style={{ borderTop: `1px solid ${BORDER}` }}>
                        {/* State header row */}
                        <div
                          onClick={() => setExpandedStateName(isExpanded ? null : st.name)}
                          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', cursor: 'pointer', userSelect: 'none' }}
                        >
                          <span style={{ fontSize: 10, color: isExpanded ? TEXT : MUTED, transition: 'color 0.1s' }}>{isExpanded ? '▼' : '▶'}</span>
                          <span style={{ fontSize: 12, fontFamily: "'JetBrains Mono','Fira Code',monospace", color: TEXT, flex: 1 }}>{st.name}</span>
                          {/* Initial star */}
                          <button
                            title="Set as initial state"
                            onClick={e => { e.stopPropagation(); void handleSetInitial(st.name) }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: ORANGE, opacity: 0.55, padding: 0 }}
                            onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.opacity = '1'}
                            onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.opacity = '0.55'}
                          >★</button>
                          {/* Type badge */}
                          {st.stateType && st.stateType !== 'atomic' && (
                            <span style={{ fontSize: 9, color: typeBadgeColor, background: typeBadgeColor + '18', border: `1px solid ${typeBadgeColor}30`, borderRadius: 3, padding: '1px 5px', fontFamily: 'monospace' }}>{st.stateType}</span>
                          )}
                        </div>

                        {isExpanded && (
                          <div style={{ padding: '0 14px 10px 28px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {/* Type selector */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontSize: 10, color: MUTED, flexShrink: 0 }}>Type</span>
                              {(['atomic', 'final', 'parallel', 'history'] as const).map(t => (
                                <button
                                  key={t}
                                  onClick={() => void handleSetStateType(st.name, t === 'atomic' ? null : t)}
                                  style={{
                                    padding: '2px 7px', borderRadius: 3, fontSize: 9, cursor: 'pointer', fontFamily: 'monospace',
                                    background: (st.stateType || 'atomic') === t ? typeBadgeColor + '20' : 'none',
                                    border: `1px solid ${(st.stateType || 'atomic') === t ? typeBadgeColor : BORDER}`,
                                    color: (st.stateType || 'atomic') === t ? typeBadgeColor : MUTED,
                                  }}
                                >{t}</button>
                              ))}
                            </div>

                            {/* Transitions sub-section */}
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 5 }}>
                                <span style={{ fontSize: 10, fontWeight: 600, color: TEAL, flex: 1 }}>Transitions</span>
                                <button
                                  onClick={() => setAddTransitionForm(f => f?.stateName === st.name ? null : { stateName: st.name, event: '', target: '', guard: '' })}
                                  style={{ fontSize: 10, background: 'none', border: `1px solid ${TEAL}40`, borderRadius: 3, color: TEAL, cursor: 'pointer', padding: '1px 6px' }}
                                >+ Add</button>
                              </div>
                              {st.transitions.length === 0 && !addTransitionForm
                                ? <div style={{ fontSize: 10, color: MUTED, fontStyle: 'italic' }}>No transitions.</div>
                                : st.transitions.map(tr => (
                                  <div key={tr.event} style={{ marginBottom: 6, padding: '4px 6px', background: '#11111b', borderRadius: 4, border: `1px solid ${BORDER}` }}>
                                    {/* Transition header: EVENT → target */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontFamily: 'monospace', marginBottom: tr.actions.length > 0 || addTransitionActionForm?.stateName === st.name && addTransitionActionForm.event === tr.event ? 4 : 0 }}>
                                      <span style={{ color: TEAL, fontWeight: 600 }}>{tr.event}</span>
                                      {tr.target && <><span style={{ color: MUTED }}>→</span><span style={{ color: GREEN }}>{tr.target}</span></>}
                                      {tr.hasGuard && <span style={{ color: MUTED, fontSize: 9 }}>[?]</span>}
                                      <button
                                        title="Add action"
                                        onClick={() => setAddTransitionActionForm(f =>
                                          f?.stateName === st.name && f.event === tr.event ? null
                                            : { stateName: st.name, event: tr.event, kind: 'assign', params: {} }
                                        )}
                                        style={{ marginLeft: 'auto', fontSize: 9, background: 'none', border: `1px solid ${ORANGE}40`, borderRadius: 3, color: ORANGE, cursor: 'pointer', padding: '1px 5px' }}
                                      >+ action</button>
                                      <button
                                        onClick={() => void handleDeleteTransition(st.name, tr.event)}
                                        style={{ background: 'none', border: 'none', color: MUTED, cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 0 }}
                                      >×</button>
                                    </div>

                                    {/* Existing action chips */}
                                    {tr.actions.length > 0 && (
                                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, paddingLeft: 4, marginBottom: 3 }}>
                                        {tr.actions.map((a, ai) => (
                                          <span key={ai} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9, fontFamily: "'JetBrains Mono','Fira Code',monospace", color: ORANGE, background: ORANGE + '14', border: `1px solid ${ORANGE}30`, borderRadius: 3, padding: '1px 5px' }}>
                                            {a}
                                            <button
                                              onClick={() => void handleSetTransitionActions(st.name, tr.event, tr.actions.filter((_, i) => i !== ai))}
                                              style={{ background: 'none', border: 'none', color: MUTED, cursor: 'pointer', fontSize: 10, lineHeight: 1, padding: 0 }}
                                            >×</button>
                                          </span>
                                        ))}
                                      </div>
                                    )}

                                    {/* Add action form */}
                                    {addTransitionActionForm?.stateName === st.name && addTransitionActionForm.event === tr.event && (() => {
                                      const f = addTransitionActionForm
                                      const ACTION_TYPES = [
                                        { kind: 'assign',     label: 'assign',     color: GREEN,  desc: 'Update context' },
                                        { kind: 'raise',      label: 'raise',      color: TEAL,   desc: 'Raise an event' },
                                        { kind: 'sendTo',     label: 'sendTo',     color: BLUE,   desc: 'Send to actor' },
                                        { kind: 'log',        label: 'log',        color: MUTED,  desc: 'Log value' },
                                        { kind: 'cancel',     label: 'cancel',     color: ORANGE, desc: 'Cancel delayed event' },
                                        { kind: 'stopChild',  label: 'stopChild',  color: RED,    desc: 'Stop child actor' },
                                        { kind: 'forwardTo',  label: 'forwardTo',  color: PURPLE, desc: 'Forward event' },
                                        { kind: 'named',      label: 'named',      color: MUTED,  desc: 'Custom action string' },
                                      ] as const
                                      return (
                                        <div style={{ marginTop: 4, padding: '6px 6px', background: BG, borderRadius: 4, border: `1px solid ${ORANGE}30` }}>
                                          {/* Action type selector */}
                                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 6 }}>
                                            {ACTION_TYPES.map(at => (
                                              <button
                                                key={at.kind}
                                                title={at.desc}
                                                onClick={() => setAddTransitionActionForm(prev => prev ? { ...prev, kind: at.kind as typeof f.kind, params: {} } : prev)}
                                                style={{
                                                  padding: '2px 7px', borderRadius: 3, fontSize: 9, cursor: 'pointer', fontFamily: 'monospace',
                                                  background: f.kind === at.kind ? at.color + '22' : 'none',
                                                  border: `1px solid ${f.kind === at.kind ? at.color : BORDER}`,
                                                  color: f.kind === at.kind ? at.color : MUTED,
                                                }}
                                              >{at.label}</button>
                                            ))}
                                          </div>

                                          {/* Param fields per action type */}
                                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                            {f.kind === 'assign' && (<>
                                              <div style={{ display: 'flex', gap: 4 }}>
                                                <input value={f.params.key ?? ''} onChange={e => setAddTransitionActionForm(p => p ? { ...p, params: { ...p.params, key: e.target.value } } : p)} placeholder="context key" style={{ ...inputStyle, flex: 1 }} />
                                                <input value={f.params.value ?? ''} onChange={e => setAddTransitionActionForm(p => p ? { ...p, params: { ...p.params, value: e.target.value } } : p)} placeholder="value / (ctx,evt) => ..." style={{ ...inputStyle, flex: 2 }} />
                                              </div>
                                            </>)}
                                            {f.kind === 'raise' && (
                                              <input value={f.params.eventType ?? ''} onChange={e => setAddTransitionActionForm(p => p ? { ...p, params: { ...p.params, eventType: e.target.value } } : p)} placeholder="Event type, e.g. DONE" style={{ ...inputStyle }} />
                                            )}
                                            {f.kind === 'sendTo' && (<>
                                              <div style={{ display: 'flex', gap: 4 }}>
                                                <input value={f.params.actorId ?? ''} onChange={e => setAddTransitionActionForm(p => p ? { ...p, params: { ...p.params, actorId: e.target.value } } : p)} placeholder="actor ID" style={{ ...inputStyle, flex: 1 }} />
                                                <input value={f.params.eventType ?? ''} onChange={e => setAddTransitionActionForm(p => p ? { ...p, params: { ...p.params, eventType: e.target.value } } : p)} placeholder="event type" style={{ ...inputStyle, flex: 1 }} />
                                              </div>
                                            </>)}
                                            {f.kind === 'log' && (
                                              <input value={f.params.expr ?? ''} onChange={e => setAddTransitionActionForm(p => p ? { ...p, params: { ...p.params, expr: e.target.value } } : p)} placeholder="ctx => ctx.value  or  'message'" style={{ ...inputStyle }} />
                                            )}
                                            {f.kind === 'cancel' && (
                                              <input value={f.params.delayId ?? ''} onChange={e => setAddTransitionActionForm(p => p ? { ...p, params: { ...p.params, delayId: e.target.value } } : p)} placeholder="delayed event ID" style={{ ...inputStyle }} />
                                            )}
                                            {f.kind === 'stopChild' && (
                                              <input value={f.params.actorId ?? ''} onChange={e => setAddTransitionActionForm(p => p ? { ...p, params: { ...p.params, actorId: e.target.value } } : p)} placeholder="actor ID" style={{ ...inputStyle }} />
                                            )}
                                            {f.kind === 'forwardTo' && (
                                              <input value={f.params.actorId ?? ''} onChange={e => setAddTransitionActionForm(p => p ? { ...p, params: { ...p.params, actorId: e.target.value } } : p)} placeholder="actor ID" style={{ ...inputStyle }} />
                                            )}
                                            {f.kind === 'named' && (
                                              <input value={f.params.name ?? ''} onChange={e => setAddTransitionActionForm(p => p ? { ...p, params: { ...p.params, name: e.target.value } } : p)} placeholder="action name string" style={{ ...inputStyle }} />
                                            )}
                                          </div>

                                          {/* Preview + Add */}
                                          <div style={{ display: 'flex', gap: 4, marginTop: 5, alignItems: 'center' }}>
                                            <span style={{ fontSize: 9, color: MUTED, fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                              {buildActionCode(f.kind, f.params)}
                                            </span>
                                            <button
                                              onClick={() => void handleSetTransitionActions(st.name, tr.event, [...tr.actions, buildActionCode(f.kind, f.params)])}
                                              style={{ padding: '2px 10px', fontSize: 10, background: ORANGE + '20', border: `1px solid ${ORANGE}50`, borderRadius: 3, color: ORANGE, cursor: 'pointer', flexShrink: 0 }}
                                            >Add</button>
                                            <button onClick={() => setAddTransitionActionForm(null)} style={{ padding: '2px 6px', fontSize: 10, background: 'none', border: `1px solid ${BORDER}`, borderRadius: 3, color: MUTED, cursor: 'pointer', flexShrink: 0 }}>×</button>
                                          </div>
                                        </div>
                                      )
                                    })()}
                                  </div>
                                ))
                              }
                              {/* Add transition form */}
                              {addTransitionForm?.stateName === st.name && (() => {
                                const tf = addTransitionForm
                                const ACTION_TYPES_TF = [
                                  { kind: 'assign', label: 'assign', color: GREEN },
                                  { kind: 'raise', label: 'raise', color: TEAL },
                                  { kind: 'sendTo', label: 'sendTo', color: BLUE },
                                  { kind: 'log', label: 'log', color: MUTED },
                                  { kind: 'cancel', label: 'cancel', color: ORANGE },
                                  { kind: 'stopChild', label: 'stopChild', color: RED },
                                  { kind: 'forwardTo', label: 'forwardTo', color: PURPLE },
                                  { kind: 'named', label: 'named', color: MUTED },
                                ] as const
                                return (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6, padding: '6px 8px', background: '#11111b', borderRadius: 4, border: `1px solid ${BORDER}` }}>
                                  <div style={{ display: 'flex', gap: 4 }}>
                                    <input
                                      value={tf.event}
                                      onChange={e => setAddTransitionForm(f => f ? { ...f, event: e.target.value } : f)}
                                      placeholder="EVENT"
                                      style={{ ...inputStyle, flex: 1 }}
                                    />
                                    <input
                                      value={tf.target}
                                      onChange={e => setAddTransitionForm(f => f ? { ...f, target: e.target.value } : f)}
                                      placeholder="target state (optional)"
                                      style={{ ...inputStyle, flex: 1 }}
                                    />
                                  </div>
                                  <input
                                    value={tf.guard}
                                    onChange={e => setAddTransitionForm(f => f ? { ...f, guard: e.target.value } : f)}
                                    placeholder="guard (optional)"
                                    style={{ ...inputStyle }}
                                  />

                                  {/* Inline action toggle */}
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <button
                                      onClick={() => setAddTransitionForm(f => f ? { ...f, showAction: !f.showAction, actionKind: f.showAction ? undefined : 'assign', actionParams: f.showAction ? undefined : {} } : f)}
                                      style={{ fontSize: 9, padding: '2px 8px', background: tf.showAction ? ORANGE + '20' : 'none', border: `1px solid ${tf.showAction ? ORANGE : BORDER}`, borderRadius: 3, color: tf.showAction ? ORANGE : MUTED, cursor: 'pointer' }}
                                    >{tf.showAction ? '− action' : '+ action'}</button>
                                    {tf.showAction && tf.actionKind && (
                                      <span style={{ fontSize: 9, color: ORANGE, fontFamily: 'monospace' }}>{buildActionCode(tf.actionKind, tf.actionParams ?? {})}</span>
                                    )}
                                  </div>

                                  {tf.showAction && (
                                    <div style={{ padding: '5px 6px', background: BG, borderRadius: 4, border: `1px solid ${ORANGE}30`, display: 'flex', flexDirection: 'column', gap: 4 }}>
                                      {/* Kind selector */}
                                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                                        {ACTION_TYPES_TF.map(at => (
                                          <button key={at.kind} onClick={() => setAddTransitionForm(f => f ? { ...f, actionKind: at.kind, actionParams: {} } : f)}
                                            style={{ padding: '2px 6px', borderRadius: 3, fontSize: 9, cursor: 'pointer', fontFamily: 'monospace',
                                              background: tf.actionKind === at.kind ? at.color + '22' : 'none',
                                              border: `1px solid ${tf.actionKind === at.kind ? at.color : BORDER}`,
                                              color: tf.actionKind === at.kind ? at.color : MUTED,
                                            }}>{at.label}</button>
                                        ))}
                                      </div>
                                      {/* Param inputs */}
                                      {tf.actionKind === 'assign' && (
                                        <div style={{ display: 'flex', gap: 4 }}>
                                          <input value={tf.actionParams?.key ?? ''} onChange={e => setAddTransitionForm(f => f ? { ...f, actionParams: { ...f.actionParams, key: e.target.value } } : f)} placeholder="context key" style={{ ...inputStyle, flex: 1 }} />
                                          <input value={tf.actionParams?.value ?? ''} onChange={e => setAddTransitionForm(f => f ? { ...f, actionParams: { ...f.actionParams, value: e.target.value } } : f)} placeholder="value / (ctx,evt) => ..." style={{ ...inputStyle, flex: 2 }} />
                                        </div>
                                      )}
                                      {tf.actionKind === 'raise' && <input value={tf.actionParams?.eventType ?? ''} onChange={e => setAddTransitionForm(f => f ? { ...f, actionParams: { ...f.actionParams, eventType: e.target.value } } : f)} placeholder="Event type" style={{ ...inputStyle }} />}
                                      {tf.actionKind === 'sendTo' && (
                                        <div style={{ display: 'flex', gap: 4 }}>
                                          <input value={tf.actionParams?.actorId ?? ''} onChange={e => setAddTransitionForm(f => f ? { ...f, actionParams: { ...f.actionParams, actorId: e.target.value } } : f)} placeholder="actor ID" style={{ ...inputStyle, flex: 1 }} />
                                          <input value={tf.actionParams?.eventType ?? ''} onChange={e => setAddTransitionForm(f => f ? { ...f, actionParams: { ...f.actionParams, eventType: e.target.value } } : f)} placeholder="event type" style={{ ...inputStyle, flex: 1 }} />
                                        </div>
                                      )}
                                      {tf.actionKind === 'log' && <input value={tf.actionParams?.expr ?? ''} onChange={e => setAddTransitionForm(f => f ? { ...f, actionParams: { ...f.actionParams, expr: e.target.value } } : f)} placeholder="ctx => ctx.value  or  'message'" style={{ ...inputStyle }} />}
                                      {tf.actionKind === 'cancel' && <input value={tf.actionParams?.delayId ?? ''} onChange={e => setAddTransitionForm(f => f ? { ...f, actionParams: { ...f.actionParams, delayId: e.target.value } } : f)} placeholder="delayed event ID" style={{ ...inputStyle }} />}
                                      {(tf.actionKind === 'stopChild' || tf.actionKind === 'forwardTo') && <input value={tf.actionParams?.actorId ?? ''} onChange={e => setAddTransitionForm(f => f ? { ...f, actionParams: { ...f.actionParams, actorId: e.target.value } } : f)} placeholder="actor ID" style={{ ...inputStyle }} />}
                                      {tf.actionKind === 'named' && <input value={tf.actionParams?.name ?? ''} onChange={e => setAddTransitionForm(f => f ? { ...f, actionParams: { ...f.actionParams, name: e.target.value } } : f)} placeholder="action name" style={{ ...inputStyle }} />}
                                    </div>
                                  )}

                                  <div style={{ display: 'flex', gap: 4 }}>
                                    <button
                                      onClick={() => void handleAddTransition(tf.stateName, tf.event, tf.target, tf.guard, tf.showAction ? tf.actionKind : undefined, tf.showAction ? tf.actionParams : undefined)}
                                      disabled={!tf.event}
                                      style={{ flex: 1, padding: '3px 0', fontSize: 10, background: TEAL + '20', border: `1px solid ${TEAL}50`, borderRadius: 3, color: TEAL, cursor: 'pointer' }}
                                    >Save</button>
                                    <button onClick={() => setAddTransitionForm(null)} style={{ flex: 1, padding: '3px 0', fontSize: 10, background: 'none', border: `1px solid ${BORDER}`, borderRadius: 3, color: MUTED, cursor: 'pointer' }}>Cancel</button>
                                  </div>
                                </div>
                                )
                              })()}
                            </div>

                            {/* Actions sub-section (entry/exit) */}
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 600, color: PURPLE, marginBottom: 6 }}>Actions</div>
                              {(['entry', 'exit'] as const).map(kind => {
                                const currentActions = kind === 'entry' ? st.entryActions : st.exitActions
                                const otherActions = kind === 'entry' ? st.exitActions : st.entryActions
                                const isAddingThis = addActionForm?.stateName === st.name && addActionForm.kind === kind
                                return (
                                  <div key={kind} style={{ marginBottom: 6 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                                      <span style={{ fontSize: 10, color: MUTED, width: 30, flexShrink: 0 }}>{kind}</span>
                                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, flex: 1 }}>
                                        {currentActions.map(a => (
                                          <span key={a} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, fontFamily: "'JetBrains Mono','Fira Code',monospace", color: PURPLE, background: PURPLE + '14', border: `1px solid ${PURPLE}30`, borderRadius: 3, padding: '1px 5px' }}>
                                            {a}
                                            <button
                                              onClick={() => void handleSaveStateActions(
                                                st.name,
                                                kind === 'entry' ? currentActions.filter(x => x !== a) : currentActions,
                                                kind === 'exit' ? currentActions.filter(x => x !== a) : otherActions,
                                              )}
                                              style={{ background: 'none', border: 'none', color: MUTED, cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 0, marginLeft: 1 }}
                                            >×</button>
                                          </span>
                                        ))}
                                      </div>
                                      <button
                                        onClick={() => setAddActionForm(isAddingThis ? null : { stateName: st.name, kind, value: '' })}
                                        style={{ fontSize: 11, background: 'none', border: `1px solid ${PURPLE}40`, borderRadius: 3, color: PURPLE, cursor: 'pointer', padding: '1px 6px', flexShrink: 0 }}
                                      >+</button>
                                    </div>
                                    {isAddingThis && (
                                      <div style={{ display: 'flex', gap: 4, paddingLeft: 34, marginTop: 3 }}>
                                        <input
                                          value={addActionForm!.value}
                                          onChange={e => setAddActionForm(f => f ? { ...f, value: e.target.value } : f)}
                                          placeholder="action name"
                                          style={{ ...inputStyle, flex: 1 }}
                                          onKeyDown={e => {
                                            if (e.key === 'Enter' && addActionForm!.value.trim()) {
                                              void handleSaveStateActions(
                                                st.name,
                                                kind === 'entry' ? [...currentActions, addActionForm!.value.trim()] : st.entryActions,
                                                kind === 'exit' ? [...currentActions, addActionForm!.value.trim()] : st.exitActions,
                                              ).then(() => setAddActionForm(null))
                                            }
                                          }}
                                        />
                                        <button
                                          onClick={() => {
                                            if (!addActionForm!.value.trim()) return
                                            void handleSaveStateActions(
                                              st.name,
                                              kind === 'entry' ? [...currentActions, addActionForm!.value.trim()] : st.entryActions,
                                              kind === 'exit' ? [...currentActions, addActionForm!.value.trim()] : st.exitActions,
                                            ).then(() => setAddActionForm(null))
                                          }}
                                          disabled={!addActionForm!.value.trim()}
                                          style={{ padding: '2px 8px', fontSize: 10, background: PURPLE + '20', border: `1px solid ${PURPLE}50`, borderRadius: 3, color: PURPLE, cursor: 'pointer', flexShrink: 0 }}
                                        >Add</button>
                                        <button onClick={() => setAddActionForm(null)} style={{ padding: '2px 6px', fontSize: 10, background: 'none', border: `1px solid ${BORDER}`, borderRadius: 3, color: MUTED, cursor: 'pointer', flexShrink: 0 }}>×</button>
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })
                }

                {/* Add state form */}
                <div style={{ padding: '8px 14px', borderTop: `1px solid ${BORDER}` }}>
                  {showAddState
                    ? (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input
                          value={addStateName}
                          onChange={e => setAddStateName(e.target.value)}
                          placeholder="State name"
                          style={{ ...inputStyle, flex: 1 }}
                        />
                        <button
                          onClick={() => {
                            if (!addStateName.trim()) return
                            void fetch('/__source/flow-state', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ projectRoot, featureId, flowId, name: addStateName.trim() }),
                            }).then(() => { loadMachineData(); setAddStateName(''); setShowAddState(false) })
                          }}
                          disabled={!addStateName.trim()}
                          style={{ padding: '3px 10px', fontSize: 10, background: GREEN + '20', border: `1px solid ${GREEN}50`, borderRadius: 3, color: GREEN, cursor: 'pointer', flexShrink: 0 }}
                        >Add</button>
                        <button onClick={() => { setShowAddState(false); setAddStateName('') }} style={{ padding: '3px 8px', fontSize: 10, background: 'none', border: `1px solid ${BORDER}`, borderRadius: 3, color: MUTED, cursor: 'pointer', flexShrink: 0 }}>×</button>
                      </div>
                    ) : (
                      <button onClick={() => setShowAddState(true)} style={{ fontSize: 10, background: 'none', border: `1px solid ${BORDER}`, borderRadius: 3, color: MUTED, cursor: 'pointer', padding: '3px 10px', width: '100%' }}>
                        + Add State
                      </button>
                    )
                  }
                </div>
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

        {/* Simulate */}
        <div style={{ borderBottom: `1px solid ${BORDER}` }}>
          <button onClick={() => setSimOpen(o => !o)} style={{ ...sectionHeaderStyle, borderBottom: simOpen ? `1px solid ${BORDER}` : 'none' }}>
            <span style={chevronStyle}>{simOpen ? '▼' : '▶'}</span>
            <span style={accordionLabelStyle}>Simulate</span>
            {simActive && simState && (
              <span style={{ fontSize: 9, color: ORANGE, background: ORANGE + '18', border: `1px solid ${ORANGE}35`, borderRadius: 3, padding: '1px 6px', marginLeft: 4, fontFamily: 'monospace', letterSpacing: '0.02em' }}>{simState}</span>
            )}
            {simActive && !simState && (
              <span style={{ fontSize: 9, color: MUTED, marginLeft: 4, fontStyle: 'italic' }}>connecting…</span>
            )}
          </button>
          {simOpen && (
            <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>

              {/* ── Page picker + Start/Stop ── */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {(linkedPages?.length ?? 0) > 0 && (
                  <select
                    value={simPage ?? ''}
                    onChange={e => {
                      const v = e.target.value || null
                      setSimPage(v); setSimMock(null); simMocksLoadedFor.current = null
                      if (v && simActive && onSimStart) onSimStart(v)
                    }}
                    style={{ ...inputStyle, flex: 1 }}
                    disabled={simActive}
                  >
                    <option value="">— pick a page —</option>
                    {(linkedPages ?? []).map(p => (
                      <option key={p.id} value={p.id}>{p.id}</option>
                    ))}
                  </select>
                )}
                {!simActive
                  ? <button
                      onClick={() => {
                        if (!simPage) return
                        setSimState(null); setSimHistory([]); prevSimStateRef.current = null
                        setSimActive(true)
                        if (onSimStart) onSimStart(simPage)
                      }}
                      disabled={!simPage}
                      style={{
                        padding: '5px 14px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                        cursor: simPage ? 'pointer' : 'not-allowed',
                        background: simPage ? GREEN + '18' : 'none',
                        border: `1px solid ${simPage ? GREEN + '60' : BORDER}`,
                        color: simPage ? GREEN : MUTED, flexShrink: 0, letterSpacing: '0.02em',
                      }}
                    >▶ Start</button>
                  : <button
                      onClick={() => {
                        setSimActive(false); setSimState(null); setSimHistory([]); prevSimStateRef.current = null
                        if (onSimStop) onSimStop()
                      }}
                      style={{
                        padding: '5px 14px', borderRadius: 4, fontSize: 11,
                        cursor: 'pointer', background: RED + '10',
                        border: `1px solid ${RED}40`, color: RED, flexShrink: 0,
                      }}
                    >■ Stop</button>
                }
              </div>

              {/* ── Live panel (only once started) ── */}
              {simActive && (
                <>
                  {/* Live state + context card */}
                  <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 6, overflow: 'hidden' }}>
                    {/* State row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: simState && Object.keys(simContext).length > 0 ? `1px solid ${BORDER}` : 'none' }}>
                      <span style={{ fontSize: 10, color: MUTED, flexShrink: 0, width: 36 }}>state</span>
                      {simState
                        ? <span style={{ fontSize: 12, color: ORANGE, fontFamily: 'monospace', fontWeight: 600, letterSpacing: '0.02em' }}>{simState}</span>
                        : <span style={{ fontSize: 11, color: MUTED, fontStyle: 'italic' }}>waiting for actor…</span>
                      }
                    </div>
                    {/* Context rows */}
                    {simState && Object.keys(simContext).length > 0 && Object.entries(simContext).map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '4px 10px', borderBottom: `1px solid ${BORDER}22`, userSelect: 'text' }}>
                        <span style={{ fontSize: 10, color: MUTED, fontFamily: 'monospace', flexShrink: 0, width: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k}</span>
                        <span style={{ fontSize: 10, color: v === null || v === undefined || v === '' ? MUTED : GREEN, fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {v === null || v === undefined ? 'null' : v === '' ? <em>empty</em> : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* ── Invoke resolution prompt ── */}
                  {invokePrompt && (
                    <div style={{ borderRadius: 6, border: `2px solid ${ORANGE}60`, background: ORANGE + '08', overflow: 'hidden' }}>
                      {/* Header */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: `1px solid ${ORANGE}30`, background: ORANGE + '12' }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: ORANGE, flexShrink: 0, animation: 'pulse 1.5s infinite' }} />
                        <span style={{ fontSize: 11, color: ORANGE, fontWeight: 600 }}>Invoke pending</span>
                        <span style={{ fontSize: 10, color: MUTED, fontFamily: 'monospace', marginLeft: 2 }}>{invokePrompt.actor}()</span>
                      </div>
                      {/* Input data */}
                      {Object.keys(invokePrompt.input).length > 0 && (
                        <div style={{ padding: '5px 10px', borderBottom: `1px solid ${BORDER}` }}>
                          {Object.entries(invokePrompt.input).map(([k, v]) => (
                            <div key={k} style={{ display: 'flex', gap: 8, fontSize: 10, lineHeight: '20px' }}>
                              <span style={{ color: MUTED, fontFamily: 'monospace', width: 72, flexShrink: 0 }}>{k}</span>
                              <span style={{ color: '#cdd6f4', fontFamily: 'monospace' }}>{String(v)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Error message input */}
                      <div style={{ padding: '6px 10px', borderBottom: `1px solid ${BORDER}` }}>
                        <input
                          value={invokePrompt.errorMsg}
                          onChange={e => setInvokePrompt(p => p ? { ...p, errorMsg: e.target.value } : p)}
                          placeholder="Error message (leave empty for generic)…"
                          style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
                        />
                      </div>
                      {/* Resolve buttons */}
                      <div style={{ display: 'flex', gap: 6, padding: '8px 10px' }}>
                        <button
                          onClick={() => {
                            iframeWindow?.postMessage({ type: 'cockpit:invoke-result', actor: invokePrompt.actor, success: true, value: true }, '*')
                            setInvokePrompt(null)
                          }}
                          style={{ flex: 1, padding: '5px 0', fontSize: 11, fontWeight: 600, background: GREEN + '18', border: `1px solid ${GREEN}50`, borderRadius: 4, color: GREEN, cursor: 'pointer' }}
                        >✓ Succeed</button>
                        <button
                          onClick={() => {
                            iframeWindow?.postMessage({ type: 'cockpit:invoke-result', actor: invokePrompt.actor, success: false, error: invokePrompt.errorMsg || 'Simulated error' }, '*')
                            setInvokePrompt(null)
                          }}
                          style={{ flex: 1, padding: '5px 0', fontSize: 11, fontWeight: 600, background: RED + '15', border: `1px solid ${RED}50`, borderRadius: 4, color: RED, cursor: 'pointer' }}
                        >✕ Fail</button>
                      </div>
                    </div>
                  )}

                  {/* ── States + event buttons ── */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {states.filter(s => (s.transitions?.length ?? 0) > 0).map(s => {
                      const isActive = simState === s.name
                      return (
                        <div key={s.name} style={{
                          borderRadius: 6,
                          border: `1px solid ${isActive ? ORANGE + '50' : BORDER}`,
                          background: isActive ? ORANGE + '07' : SURFACE,
                          overflow: 'hidden',
                        }}>
                          {/* State header */}
                          <div style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '5px 10px',
                            borderBottom: `1px solid ${isActive ? ORANGE + '30' : BORDER}`,
                            background: isActive ? ORANGE + '10' : 'transparent',
                          }}>
                            <span style={{
                              fontSize: 11, fontFamily: 'monospace', fontWeight: 600,
                              color: isActive ? ORANGE : '#cdd6f4',
                              letterSpacing: '0.02em',
                            }}>{s.name}</span>
                            {isActive && (
                              <span style={{
                                fontSize: 9, color: ORANGE, background: ORANGE + '20',
                                border: `1px solid ${ORANGE}40`, borderRadius: 10,
                                padding: '1px 6px', marginLeft: 'auto', letterSpacing: '0.03em',
                              }}>● live</span>
                            )}
                          </div>
                          {/* Event buttons */}
                          <div style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {(s.transitions ?? []).map((t, i) => {
                              const eventDef = events.find(e => e.type === t.event)
                              const hasPayload = (eventDef?.payload?.length ?? 0) > 0
                              const isOpen = simEventForm?.event === `${s.name}::${t.event}`
                              return (
                                <div key={i}>
                                  <button
                                    onClick={() => {
                                      if (t.isInvoke) {
                                        // onDone/onError are invoke lifecycle transitions — resolve via cockpit:invoke-result
                                        const actor = t.invokeActorId ?? invokePrompt?.actor ?? s.name
                                        if (t.event === 'onDone') {
                                          iframeWindow?.postMessage({ type: 'cockpit:invoke-result', actor, success: true, value: undefined }, '*')
                                        } else {
                                          iframeWindow?.postMessage({ type: 'cockpit:invoke-result', actor, success: false, error: 'Simulated error' }, '*')
                                        }
                                        setInvokePrompt(null)
                                        return
                                      }
                                      if (hasPayload) {
                                        if (isOpen) { setSimEventForm(null); return }
                                        const defaults: Record<string, string> = {}
                                        for (const f of (eventDef?.payload ?? [])) defaults[f.name] = ''
                                        setSimEventForm({ event: `${s.name}::${t.event}`, values: defaults })
                                      } else {
                                        iframeWindow?.postMessage({ type: 'cockpit:machine-event', event: { type: t.event } }, '*')
                                        setSimEventForm(null)
                                      }
                                    }}
                                    title={t.hasGuard ? 'guarded — may not fire if condition not met' : t.isInvoke ? `invoke lifecycle — resolves the actor (${t.invokeActorId ?? s.name})` : undefined}
                                    style={{
                                      width: '100%', textAlign: 'left',
                                      padding: '5px 8px', borderRadius: 4, fontSize: 10, cursor: 'pointer',
                                      fontFamily: "'JetBrains Mono','Fira Code',monospace",
                                      background: t.isInvoke
                                        ? (t.event === 'onDone' ? GREEN + '12' : RED + '10')
                                        : isOpen ? TEAL + '18' : 'rgba(137,220,235,0.07)',
                                      border: `1px solid ${t.isInvoke ? (t.event === 'onDone' ? GREEN + '45' : RED + '40') : isOpen ? TEAL + '60' : TEAL + '25'}`,
                                      color: t.isInvoke ? (t.event === 'onDone' ? GREEN : RED) : TEAL,
                                      display: 'flex', alignItems: 'center', gap: 6,
                                    }}
                                  >
                                    <span style={{ flex: 1, letterSpacing: '0.01em' }}>{t.event}</span>
                                    {t.isInvoke && <span style={{ fontSize: 8, color: t.event === 'onDone' ? GREEN : RED, background: (t.event === 'onDone' ? GREEN : RED) + '15', border: `1px solid ${(t.event === 'onDone' ? GREEN : RED)}30`, borderRadius: 3, padding: '1px 4px' }}>invoke</span>}
                                    {t.hasGuard && <span style={{ fontSize: 8, color: MUTED, background: BORDER, borderRadius: 3, padding: '1px 4px' }}>guard</span>}
                                    {hasPayload && <span style={{ fontSize: 8, color: ORANGE, background: ORANGE + '15', border: `1px solid ${ORANGE}30`, borderRadius: 3, padding: '1px 4px' }}>payload</span>}
                                    {t.target && <span style={{ fontSize: 9, color: MUTED }}>→ {t.target}</span>}
                                  </button>

                                  {isOpen && simEventForm && (
                                    <div style={{ marginTop: 4, padding: '8px', background: BG, borderRadius: 4, border: `1px solid ${TEAL}30`, display: 'flex', flexDirection: 'column', gap: 6 }}>
                                      {(eventDef?.payload ?? []).map(f => (
                                        <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                          <span style={{ fontSize: 9, color: TEAL, fontFamily: 'monospace', flexShrink: 0, width: 76 }}>evt.{f.name}</span>
                                          <input
                                            value={simEventForm.values[f.name] ?? ''}
                                            onChange={e => setSimEventForm(prev => prev ? { ...prev, values: { ...prev.values, [f.name]: e.target.value } } : prev)}
                                            placeholder={f.type}
                                            style={{ ...inputStyle, flex: 1 }}
                                          />
                                        </div>
                                      ))}
                                      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                                        <button
                                          onClick={() => {
                                            const evt: Record<string, unknown> = { type: t.event }
                                            for (const f of (eventDef?.payload ?? [])) evt[f.name] = simEventForm.values[f.name] ?? ''
                                            iframeWindow?.postMessage({ type: 'cockpit:machine-event', event: evt }, '*')
                                            setSimEventForm(null)
                                          }}
                                          style={{ flex: 1, padding: '4px 0', fontSize: 10, fontWeight: 600, background: TEAL + '20', border: `1px solid ${TEAL}50`, borderRadius: 4, color: TEAL, cursor: 'pointer' }}
                                        >Send ↑</button>
                                        <button onClick={() => setSimEventForm(null)} style={{ padding: '4px 10px', fontSize: 10, background: 'none', border: `1px solid ${BORDER}`, borderRadius: 4, color: MUTED, cursor: 'pointer' }}>✕</button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* ── Transition history ── */}
                  {simHistory.length > 0 && (
                    <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 6, overflow: 'hidden' }}>
                      <div style={{ fontSize: 10, color: MUTED, padding: '5px 10px', borderBottom: `1px solid ${BORDER}`, letterSpacing: '0.04em', textTransform: 'uppercase' }}>History</div>
                      <div style={{ padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {[...simHistory].reverse().slice(0, 8).map((h, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, opacity: i === 0 ? 1 : Math.max(0.25, 1 - i * 0.12) }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: i === 0 ? GREEN : MUTED, flexShrink: 0 }} />
                            <span style={{ color: '#cdd6f4', fontFamily: 'monospace' }}>{h.from}</span>
                            <span style={{ color: MUTED, fontSize: 9 }}>→</span>
                            <span style={{ color: i === 0 ? GREEN : '#cdd6f4', fontFamily: 'monospace', fontWeight: i === 0 ? 600 : 400 }}>{h.to}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {states.length === 0 && (
                <div style={{ fontSize: 11, color: MUTED, fontStyle: 'italic' }}>No states found in machine.</div>
              )}
            </div>
          )}
        </div>

        {/* Actor */}
        <div style={{ borderBottom: `1px solid ${BORDER}` }}>
          <button onClick={() => setActorOpen(o => !o)} style={{ ...sectionHeaderStyle, borderBottom: actorOpen ? `1px solid ${BORDER}` : 'none' }}>
            <span style={chevronStyle}>{actorOpen ? '▼' : '▶'}</span>
            <span style={accordionLabelStyle}>Actor</span>
            <span style={{ fontSize: 10, color: PURPLE, fontFamily: 'monospace', marginLeft: 4 }}>use{flowId}Actor()</span>
          </button>
          {actorOpen && (
            <div>
              {/* Hook + Provider badges */}
              <div style={{ display: 'flex', gap: 6, padding: '8px 14px', borderBottom: `1px solid ${BORDER}`, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, fontFamily: 'monospace', color: PURPLE, background: PURPLE + '14', border: `1px solid ${PURPLE}30`, borderRadius: 3, padding: '2px 8px' }}>
                  use{flowId}Actor()
                </span>
                <span style={{ fontSize: 10, fontFamily: 'monospace', color: BLUE, background: BLUE + '14', border: `1px solid ${BLUE}30`, borderRadius: 3, padding: '2px 8px' }}>
                  {flowId}Provider
                </span>
              </div>
              {actorSource !== null
                ? <div style={{ height: 200 }}>
                    <Editor
                      height="100%"
                      language="typescript"
                      theme="vs-dark"
                      path={`file:///${projectRoot.replace(/\\/g, '/')}/src/features/${featureId}/${flowId}.actor.ts`}
                      value={actorSource}
                      options={{ fontSize: 12, minimap: { enabled: false }, scrollBeyondLastLine: false, readOnly: true, lineNumbers: 'on' as const }}
                    />
                  </div>
                : <div style={{ padding: '10px 14px', fontSize: 11, color: MUTED, fontStyle: 'italic' }}>{flowId}.actor.ts not found.</div>
              }
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
                        // Load xstate / react type defs for IntelliSense (async, non-blocking)
                        void ensureMonacoTypes(monaco, projectRoot)
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

      {/* Snippet toast */}
      {lastSnippet && (
        <div style={{
          position: 'absolute', bottom: 48, left: 12, right: 12,
          background: SURFACE, border: `1px solid ${TEAL}50`, borderRadius: 6,
          padding: '8px 10px', zIndex: 300,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 5 }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: TEAL, flex: 1 }}>Snippet preview</span>
            <button onClick={() => { setLastSnippet(null); if (snippetTimerRef.current) { clearTimeout(snippetTimerRef.current); snippetTimerRef.current = null } }}
              style={{ background: 'none', border: 'none', color: MUTED, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
          </div>
          <pre style={{ margin: 0, fontSize: 10, fontFamily: "'JetBrains Mono','Fira Code',monospace", color: TEXT, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 180, overflowY: 'auto' }}>{lastSnippet}</pre>
        </div>
      )}

      {/* Footer */}
      <div style={{ padding: '6px 14px', borderTop: `1px solid ${BORDER}`, fontSize: 10, color: MUTED, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        src/features/{featureId}/{flowId}.machine.ts
      </div>
    </div>
  )
}