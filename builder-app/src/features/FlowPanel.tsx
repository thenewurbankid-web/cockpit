import { useEffect, useRef, useState, useCallback } from 'react'

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

/** Source of a context field: linked to a page prop, a service field, or unlinked. */
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

// ── Props ─────────────────────────────────────────────────────────────────────

interface FlowPanelProps {
  flowId: string
  featureId: string
  projectRoot: string
  width: number
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function sourceBadge(source: FieldSource) {
  if (!source) return null
  if (source.kind === 'page') {
    return (
      <span style={{
        fontSize: 10, fontFamily: 'monospace',
        background: 'rgba(137,180,250,0.12)', border: '1px solid rgba(137,180,250,0.28)',
        borderRadius: 4, padding: '1px 6px', color: BLUE,
        display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0,
      }}>
        <span style={{ color: MUTED }}>{source.pageId}</span>
        <span style={{ color: MUTED }}>›</span>
        <span>{source.prop}</span>
      </span>
    )
  }
  return (
    <span style={{
      fontSize: 10, fontFamily: 'monospace',
      background: 'rgba(203,166,247,0.12)', border: '1px solid rgba(203,166,247,0.28)',
      borderRadius: 4, padding: '1px 6px', color: PURPLE,
      display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0,
    }}>
      <span style={{ color: MUTED }}>{source.serviceId}</span>
      <span style={{ color: MUTED }}>›</span>
      <span>{source.field}</span>
    </span>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function FlowPanel({ flowId, featureId, projectRoot, width, onClose }: FlowPanelProps) {
  const [fields, setFields] = useState<ContextField[]>([])
  const [machineStates, setMachineStates] = useState<string[]>([])
  const [scope, setScope] = useState<{ pages: PageScope[]; services: ServiceScope[] }>({ pages: [], services: [] })
  const [scopePickerOpen, setScopePickerOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const [manual, setManual] = useState<ManualForm>({ name: '', type: '', optional: false })
  const [statesOpen, setStatesOpen] = useState(true)
  const [contextOpen, setContextOpen] = useState(true)
  const [pageScopeOpen, setPageScopeOpen] = useState(true)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [sourceCode, setSourceCode] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load saved context bindings and machine states
  useEffect(() => {
    if (!projectRoot || !featureId || !flowId) return
    void fetch(
      `/__source/flow-context?projectRoot=${encodeURIComponent(projectRoot)}&featureId=${encodeURIComponent(featureId)}&flowId=${encodeURIComponent(flowId)}`
    )
      .then(r => r.json())
      .then(d => setFields(d.fields ?? []))
      .catch(() => {})
    void fetch(
      `/__source/all-flow-states?projectRoot=${encodeURIComponent(projectRoot)}&featureId=${encodeURIComponent(featureId)}`
    )
      .then(r => r.json())
      .then(d => {
        const flow = (d.flows ?? []).find((f: { id: string; states: string[] }) => f.id === flowId)
        setMachineStates(flow?.states ?? [])
      })
      .catch(() => {})
  }, [projectRoot, featureId, flowId])

  // Load feature scope (pages + services)
  useEffect(() => {
    if (!projectRoot || !featureId) return
    void fetch(
      `/__source/feature-scope?projectRoot=${encodeURIComponent(projectRoot)}&featureId=${encodeURIComponent(featureId)}`
    )
      .then(r => r.json())
      .then(d => setScope({ pages: d.pages ?? [], services: d.services ?? [] }))
      .catch(() => {})
  }, [projectRoot, featureId])

  // Load source code when section opened
  useEffect(() => {
    if (!sourceOpen || !projectRoot || !featureId || !flowId) return
    const file = `${projectRoot}/src/features/${featureId}/${flowId}.machine.ts`.replace(/\\/g, '/')
    void fetch(`/__source?file=${encodeURIComponent(file)}`)
      .then(r => r.ok ? r.text() : Promise.reject())
      .then(text => setSourceCode(text))
      .catch(() => setSourceCode(null))
  }, [sourceOpen, projectRoot, featureId, flowId])

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

  function addFromScope(field: FieldDef, source: FieldSource) {
    const next = [...fields, { name: field.name, type: field.type, optional: field.optional, source }]
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

  // Stable color per field name (assigned in order fields were added)
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

  return (
    <div style={{
      position: 'fixed', right: 0, top: 0, bottom: 0, width,
      background: BG, borderLeft: `1px solid ${BORDER}`,
      display: 'flex', flexDirection: 'column',
      zIndex: 200, fontFamily: 'system-ui, sans-serif',
    }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 14px', borderBottom: `1px solid ${BORDER}`, flexShrink: 0,
      }}>
        <span style={{ fontSize: 10, color: GREEN, fontWeight: 700, letterSpacing: 0.5 }}>FLOW</span>
        <span style={{ fontSize: 14, color: TEXT, fontWeight: 600, flex: 1 }}>{flowId}</span>
        {saving && <span style={{ fontSize: 10, color: MUTED }}>saving…</span>}
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: MUTED, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px' }}>×</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>

        {/* ── States ──────────────────────────────────────── */}
        {machineStates.length > 0 && (
          <div style={{ borderBottom: `1px solid ${BORDER}` }}>
            <button
              onClick={() => setStatesOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                background: 'none', border: 'none', padding: '8px 14px', cursor: 'pointer',
                borderBottom: statesOpen ? `1px solid ${BORDER}` : 'none',
              }}
            >
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: ORANGE }}>States</span>
              <span style={{ fontSize: 10, color: MUTED, marginLeft: 'auto' }}>{statesOpen ? '▲' : '▼'}</span>
            </button>
            {statesOpen && (
              <div style={{ padding: '8px 14px', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {machineStates.map(s => (
                  <span key={s} style={{
                    fontSize: 11, fontFamily: 'monospace', color: ORANGE,
                    background: 'rgba(250,179,135,0.10)', border: '1px solid rgba(250,179,135,0.20)',
                    borderRadius: 3, padding: '1px 7px',
                  }}>{s}</span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Scope (pages props, inspector-style) ─────────── */}
        {scope.pages.some(p => p.props.length > 0) && (
          <div style={{ borderBottom: `1px solid ${BORDER}` }}>
            <button
              onClick={() => setPageScopeOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                background: 'none', border: 'none', padding: '8px 14px', cursor: 'pointer',
                borderBottom: pageScopeOpen ? `1px solid ${BORDER}` : 'none',
              }}
            >
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: BLUE }}>Scope</span>
              <span style={{ fontSize: 10, color: MUTED, marginLeft: 'auto' }}>{pageScopeOpen ? '▲' : '▼'}</span>
            </button>
            {pageScopeOpen && (
              <div style={{ padding: '4px 0 6px' }}>
                {scope.pages.filter(p => p.props.length > 0).map(page => (
                  <div key={page.id} style={{ marginBottom: 6, paddingLeft: 8 }}>
                    {/* Layer header — same as inspector parentBadge style */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4, paddingRight: 10 }}>
                      <span style={{ fontSize: '0.72rem', color: MUTED, letterSpacing: '0.01em' }}>◦ {page.id}</span>
                      <span style={{
                        marginLeft: 'auto',
                        fontSize: '0.6rem', color: MUTED,
                        background: 'transparent', border: `1px solid #45475a`,
                        borderRadius: 10, padding: '1px 7px',
                        fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const,
                      }}>page</span>
                    </div>
                    {/* Props group — chips like inspector */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 5, marginBottom: 3, paddingLeft: 14 }}>
                      <span style={{
                        fontSize: '0.58rem', color: '#45475a', fontWeight: 700,
                        textTransform: 'uppercase' as const, letterSpacing: '0.07em',
                        minWidth: 30, paddingTop: 3, flexShrink: 0,
                      }}>props</span>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 4px' }}>
                        {page.props.map(prop => {
                          const contextName = `${page.id}_${prop.name}`
                          const added = addedNames.has(contextName)
                          const color = fieldColorMap.get(contextName)
                          return (
                            <div
                              key={prop.name}
                              onClick={() => toggleFromScope(prop, page.id)}
                              title={added ? `Remove "${contextName}" from context` : `Add "${contextName}" to context`}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 3,
                                fontSize: '0.71rem',
                                color: added && color ? color : '#45475a',
                                padding: '2px 7px', borderRadius: 99, cursor: 'pointer',
                                background: added && color ? color + '14' : 'transparent',
                                border: `1px solid ${added && color ? color + '60' : '#2a2a3d'}`,
                                transition: 'all 0.12s',
                              }}
                            >
                              {added && color
                                ? <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
                                : <span style={{ fontSize: '0.5rem' }}>○</span>
                              }
                              <code style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: '0.7rem', fontWeight: 500 }}>
                                {prop.name}{prop.optional ? '?' : ''}
                              </code>
                              {prop.type && (
                                <span style={{ fontSize: '0.62rem', color: added && color ? color : '#45475a', fontStyle: 'italic', marginLeft: 1 }}>
                                  {prop.type}
                                </span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Context Fields ──────────────────────────────── */}
        <div style={{ borderBottom: `1px solid ${BORDER}` }}>
          <button
            onClick={() => setContextOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, width: '100%',
              background: 'none', border: 'none', padding: '8px 14px', cursor: 'pointer',
              borderBottom: contextOpen ? `1px solid ${BORDER}` : 'none',
            }}
          >
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: MUTED }}>Context Fields</span>
            {contextOpen && (
              <div style={{ display: 'flex', gap: 5, marginLeft: 'auto' }}>
                {hasScope && (
                  <span
                    onClick={e => { e.stopPropagation(); setScopePickerOpen(o => !o); setShowManual(false) }}
                    style={{
                      background: scopePickerOpen ? 'rgba(137,180,250,0.15)' : 'none',
                      border: `1px solid ${scopePickerOpen ? BLUE : BORDER}`,
                      borderRadius: 3, color: scopePickerOpen ? BLUE : MUTED, cursor: 'pointer',
                      fontSize: 10, padding: '1px 7px',
                    }}
                  >+ from scope</span>
                )}
                <span
                  onClick={e => { e.stopPropagation(); setShowManual(o => !o); setScopePickerOpen(false) }}
                  style={{
                    background: showManual ? 'rgba(166,227,161,0.10)' : 'none',
                    border: `1px solid ${showManual ? GREEN : BORDER}`,
                    borderRadius: 3, color: showManual ? GREEN : MUTED, cursor: 'pointer',
                    fontSize: 10, padding: '1px 7px',
                  }}
                >+ manual</span>
              </div>
            )}
            {!contextOpen && <span style={{ fontSize: 10, color: MUTED, marginLeft: 'auto' }}>▼</span>}
          </button>

          {contextOpen && (
            <>
              {/* Scope picker */}
              {scopePickerOpen && (
                <div style={{ background: SURFACE, borderBottom: `1px solid ${BORDER}`, padding: '8px 14px' }}>
                  {scope.pages.map(page => page.props.length === 0 ? null : (
                    <div key={page.id} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: BLUE, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
                        {page.id} (page)
                      </div>
                      {page.props.map(prop => {
                        const already = addedNames.has(prop.name)
                        return (
                          <button
                            key={prop.name}
                            disabled={already}
                            onClick={() => addFromScope(prop, { kind: 'page', pageId: page.id, prop: prop.name })}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 5, width: '100%',
                              background: 'none', border: 'none', textAlign: 'left',
                              cursor: already ? 'default' : 'pointer',
                              opacity: already ? 0.4 : 1,
                              padding: '3px 4px', borderRadius: 3,
                            }}
                          >
                            <span style={{ fontFamily: 'monospace', fontSize: 12, color: BLUE }}>
                              {prop.name}{prop.optional ? '?' : ''}
                            </span>
                            <span style={{ fontFamily: 'monospace', fontSize: 10, color: MUTED }}>: {prop.type}</span>
                            {already && <span style={{ fontSize: 10, color: MUTED, marginLeft: 'auto' }}>added</span>}
                          </button>
                        )
                      })}
                    </div>
                  ))}
                  {scope.services.map(svc => svc.interfaces.map(iface => iface.fields.length === 0 ? null : (
                    <div key={`${svc.id}::${iface.name}`} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: PURPLE, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
                        {svc.id} › {iface.name}
                      </div>
                      {iface.fields.map(field => {
                        const already = addedNames.has(field.name)
                        return (
                          <button
                            key={field.name}
                            disabled={already}
                            onClick={() => addFromScope(field, { kind: 'service', serviceId: svc.id, interface: iface.name, field: field.name })}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 5, width: '100%',
                              background: 'none', border: 'none', textAlign: 'left',
                              cursor: already ? 'default' : 'pointer',
                              opacity: already ? 0.4 : 1,
                              padding: '3px 4px', borderRadius: 3,
                            }}
                          >
                            <span style={{ fontFamily: 'monospace', fontSize: 12, color: PURPLE }}>
                              {field.name}{field.optional ? '?' : ''}
                            </span>
                            <span style={{ fontFamily: 'monospace', fontSize: 10, color: MUTED }}>: {field.type}</span>
                            {already && <span style={{ fontSize: 10, color: MUTED, marginLeft: 'auto' }}>added</span>}
                          </button>
                        )
                      })}
                    </div>
                  )))}
                </div>
              )}

              {/* Manual add form */}
              {showManual && (
                <div style={{ background: SURFACE, borderBottom: `1px solid ${BORDER}`, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input
                    placeholder="field name"
                    value={manual.name}
                    onChange={e => setManual(m => ({ ...m, name: e.target.value }))}
                    style={{ background: '#181825', border: `1px solid ${BORDER}`, borderRadius: 4, color: TEXT, fontSize: 12, fontFamily: 'monospace', padding: '4px 8px', outline: 'none' }}
                  />
                  <input
                    placeholder="type (e.g. string | null)"
                    value={manual.type}
                    onChange={e => setManual(m => ({ ...m, type: e.target.value }))}
                    style={{ background: '#181825', border: `1px solid ${BORDER}`, borderRadius: 4, color: TEXT, fontSize: 12, fontFamily: 'monospace', padding: '4px 8px', outline: 'none' }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: MUTED, cursor: 'pointer' }}>
                      <input type="checkbox" checked={manual.optional} onChange={e => setManual(m => ({ ...m, optional: e.target.checked }))} />
                      optional
                    </label>
                    <button
                      onClick={addManual}
                      disabled={!manual.name.trim() || !manual.type.trim()}
                      style={{
                        marginLeft: 'auto', background: manual.name.trim() && manual.type.trim() ? 'rgba(166,227,161,0.15)' : 'none',
                        border: `1px solid ${manual.name.trim() && manual.type.trim() ? GREEN : BORDER}`,
                        borderRadius: 3, color: manual.name.trim() && manual.type.trim() ? GREEN : MUTED,
                        cursor: manual.name.trim() && manual.type.trim() ? 'pointer' : 'default',
                        fontSize: 11, padding: '3px 12px',
                      }}
                    >Add</button>
                  </div>
                </div>
              )}

              {/* Field list */}
              {fields.length === 0 && !scopePickerOpen && !showManual && (
                <div style={{ padding: 16, color: MUTED, fontSize: 12, fontStyle: 'italic' }}>
                  No context fields yet. Add from feature scope or manually.
                </div>
              )}

              {fields.map((field, idx) => (
                <div key={idx} style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  padding: '7px 14px', borderTop: `1px solid ${BORDER}`,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0 }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 12, color: TEXT, flexShrink: 0 }}>
                        {field.name}{field.optional ? '?' : ''}
                      </span>
                      <span style={{ fontFamily: 'monospace', fontSize: 10, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        : {field.type}
                      </span>
                    </div>
                    {field.source && <div style={{ marginTop: 2 }}>{sourceBadge(field.source)}</div>}
                    {!field.source && <span style={{ fontSize: 10, color: MUTED, fontStyle: 'italic' }}>no source</span>}
                  </div>
                  <button
                    onClick={() => removeField(idx)}
                    style={{ background: 'none', border: 'none', color: MUTED, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
                    title="Remove field"
                  >×</button>
                </div>
              ))}
            </>
          )}
        </div>

        {/* ── Source ─────────────────────────────────────── */}
        <div style={{ borderBottom: `1px solid ${BORDER}` }}>
          <button
            onClick={() => setSourceOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, width: '100%',
              background: 'none', border: 'none', padding: '8px 14px', cursor: 'pointer',
              borderBottom: sourceOpen ? `1px solid ${BORDER}` : 'none',
            }}
          >
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: GREEN }}>Source</span>
            <span style={{ fontSize: 10, color: MUTED, flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: 6 }}>
              {flowId}.machine.ts
            </span>
            <span style={{ fontSize: 10, color: MUTED }}>{sourceOpen ? '▲' : '▼'}</span>
          </button>
          {sourceOpen && (
            <div style={{ background: '#11111b' }}>
              {sourceCode === null ? (
                <div style={{ padding: '12px 14px', fontSize: 12, color: MUTED, fontStyle: 'italic' }}>
                  Could not load file.
                </div>
              ) : (
                <pre style={{
                  margin: 0, padding: '12px 14px',
                  fontSize: 11, lineHeight: 1.6, fontFamily: 'monospace',
                  color: TEXT, whiteSpace: 'pre', overflowX: 'auto',
                }}>{sourceCode}</pre>
              )}
            </div>
          )}
        </div>

      </div>

      {/* Footer */}
      <div style={{
        padding: '6px 14px', borderTop: `1px solid ${BORDER}`,
        fontSize: 10, color: MUTED, flexShrink: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        src/features/{featureId}/{flowId}.machine.ts
      </div>
    </div>
  )
}


