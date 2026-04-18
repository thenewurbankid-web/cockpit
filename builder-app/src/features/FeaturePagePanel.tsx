import { useEffect, useRef, useState } from 'react'
import type { PropDef } from './types'

interface FieldDef {
  name: string
  type: string
  optional: boolean
}

interface StateModel {
  key: string
  label: string
  fields: FieldDef[]
  data: Record<string, string>
}

interface PageStateModels {
  layout: string | null
  states: StateModel[]
}

interface ContextFieldBinding {
  name: string
  type: string
  optional: boolean
  source: { kind: 'page'; pageId: string; prop: string } | { kind: 'service'; serviceId: string; interface: string; field: string } | null
}

interface FlowWithContext {
  id: string
  states: string[]
  context: ContextFieldBinding[]
}

interface FeaturePagePanelProps {
  pageId: string
  featureId: string
  flows: string[]
  props: PropDef[]
  projectRoot: string
  width: number
  onClose: () => void
}

const BG = '#1e1e2e'
const SURFACE = '#181825'
const BORDER = '#313244'
const MUTED = '#6c7086'
const TEXT = '#cdd6f4'
const BLUE = '#89b4fa'
const GREEN = '#a6e3a1'
const YELLOW = '#f9e2af'
const ORANGE = '#fab387'
const SUBTEXT = '#a6adc8'

export function FeaturePagePanel({ pageId, featureId, flows, props, projectRoot, width, onClose }: FeaturePagePanelProps) {
  const [models, setModels] = useState<PageStateModels | null>(null)
  const [expandedStates, setExpandedStates] = useState<Set<string>>(new Set())
  const [flowsWithContext, setFlowsWithContext] = useState<FlowWithContext[]>([])
  const controllerRef = useRef<AbortController | null>(null)

  // Load page state models
  useEffect(() => {
    if (!pageId || !projectRoot) return
    controllerRef.current?.abort()
    const ctrl = new AbortController()
    controllerRef.current = ctrl
    setModels(null)
    void fetch(
      `/__source/page-state-models?projectRoot=${encodeURIComponent(projectRoot)}&page=${encodeURIComponent(pageId)}`,
      { signal: ctrl.signal }
    )
      .then(r => r.json())
      .then(data => {
        setModels(data)
        setExpandedStates(new Set((data.states ?? []).map((s: StateModel) => s.key)))
      })
      .catch(() => {})
    return () => ctrl.abort()
  }, [pageId, projectRoot])

  // Load flows (states + context bindings)
  useEffect(() => {
    if (!featureId || !projectRoot) return
    void fetch(`/__source/all-flow-states?projectRoot=${encodeURIComponent(projectRoot)}&featureId=${encodeURIComponent(featureId)}`)
      .then(r => r.json())
      .then(d => setFlowsWithContext(d.flows ?? []))
      .catch(() => {})
  }, [featureId, projectRoot])

  function toggleState(key: string) {
    setExpandedStates(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Bindings derived from flows: which page props appear as context sources in any flow
  const propBindings = props.map(prop => ({
    propName: prop.name,
    flows: flowsWithContext.flatMap(f =>
      f.context
        .filter(c => c.source?.kind === 'page' && (c.source as { kind: 'page'; pageId: string; prop: string }).pageId === pageId && (c.source as { kind: 'page'; pageId: string; prop: string }).prop === prop.name)
        .map(c => ({ flowId: f.id, fieldName: c.name }))
    ),
  }))

  return (
    <div style={{
      position: 'fixed',
      right: 0,
      top: 0,
      bottom: 0,
      width,
      background: BG,
      borderLeft: `1px solid ${BORDER}`,
      display: 'flex',
      flexDirection: 'column',
      zIndex: 200,
      fontFamily: 'system-ui, sans-serif',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 14px',
        borderBottom: `1px solid ${BORDER}`,
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 10, color: BLUE, fontWeight: 700, letterSpacing: 0.5 }}>PAGE</span>
        <span style={{ fontSize: 14, color: TEXT, fontWeight: 600, flex: 1 }}>{pageId}</span>
        {models?.layout && (
          <span style={{
            fontSize: 10, color: YELLOW,
            background: 'rgba(249,226,175,0.12)',
            border: '1px solid rgba(249,226,175,0.25)',
            borderRadius: 4, padding: '2px 7px', fontWeight: 600,
          }}>
            {models.layout}
          </span>
        )}
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: MUTED, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px' }}>×</button>
      </div>

      {/* Layout row */}
      {models?.layout && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderBottom: `1px solid ${BORDER}`, flexShrink: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color: MUTED, textTransform: 'uppercase' }}>Layout</span>
          <span style={{ fontSize: 13, color: YELLOW }}>{models.layout}</span>
        </div>
      )}

      {/* Flows legend */}
      {flowsWithContext.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderBottom: `1px solid ${BORDER}`, flexShrink: 0, flexWrap: 'wrap' as const }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color: MUTED, textTransform: 'uppercase', flexShrink: 0 }}>Flows</span>
          {flowsWithContext.map(f => (
            <span key={f.id} style={{ fontSize: 10, color: ORANGE, fontFamily: 'monospace', background: 'rgba(250,179,135,0.10)', borderRadius: 3, padding: '1px 6px' }}>
              {f.id} <span style={{ color: MUTED }}>({f.states.join(', ')})</span>
            </span>
          ))}
        </div>
      )}

      {/* Prop bindings (derived from flow context) */}
      {props.length > 0 && (
        <div style={{ borderBottom: `1px solid ${BORDER}`, flexShrink: 0 }}>
          <div style={{ padding: '7px 14px 4px', fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color: MUTED, textTransform: 'uppercase' }}>Props</div>
          {propBindings.map(({ propName, flows: boundFlows }) => (
            <div key={propName} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 14px' }}>
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: BLUE, flexShrink: 0 }}>{propName}</span>
              {boundFlows.length === 0
                ? <span style={{ fontSize: 10, color: MUTED, fontStyle: 'italic' }}>unbound</span>
                : boundFlows.map(b => (
                  <span key={`${b.flowId}::${b.fieldName}`} style={{
                    fontSize: 10, fontFamily: 'monospace',
                    background: 'rgba(250,179,135,0.10)', border: '1px solid rgba(250,179,135,0.25)',
                    borderRadius: 4, padding: '1px 6px', color: ORANGE,
                    display: 'inline-flex', alignItems: 'center', gap: 3,
                  }}>
                    <span style={{ color: MUTED }}>{b.flowId}</span>
                    <span style={{ color: MUTED }}>›</span>
                    <span>{b.fieldName}</span>
                  </span>
                ))
              }
            </div>
          ))}
        </div>
      )}

      {/* States */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {models === null && (
          <div style={{ padding: 16, color: MUTED, fontSize: 12, fontStyle: 'italic' }}>Loading…</div>
        )}
        {models !== null && models.states.length === 0 && (
          <div style={{ padding: 16, color: MUTED, fontSize: 12, fontStyle: 'italic' }}>No states defined for this page.</div>
        )}

        {models?.states.map(state => {
          const isExpanded = expandedStates.has(state.key)
          return (
            <div key={state.key} style={{ borderBottom: `1px solid ${BORDER}` }}>
              {/* State header */}
              <div
                onClick={() => toggleState(state.key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  padding: '8px 14px', cursor: 'pointer',
                  background: isExpanded ? 'rgba(137,180,250,0.05)' : 'transparent',
                  userSelect: 'none',
                }}
              >
                <span style={{ fontSize: 10, color: BLUE, flexShrink: 0 }}>{isExpanded ? '▾' : '▸'}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: TEXT, flex: 1 }}>{state.label}</span>
                <span style={{ fontSize: 10, color: MUTED }}>{state.fields.length}f</span>
              </div>

              {isExpanded && (
                <div style={{ background: SURFACE, paddingBottom: 8 }}>

                  {/* Model fields */}
                  {state.fields.length === 0 && (
                    <div style={{ padding: '4px 20px', color: MUTED, fontSize: 11, fontStyle: 'italic' }}>No fields in model</div>
                  )}
                  {state.fields.map(field => {
                    const dataVal = state.data[field.name]
                    return (
                      <div key={field.name} style={{
                        display: 'grid', gridTemplateColumns: '1fr 1fr',
                        gap: 4, padding: '4px 14px 4px 20px', alignItems: 'baseline',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 3, minWidth: 0 }}>
                          <span style={{ fontSize: 12, color: BLUE, fontFamily: 'monospace', flexShrink: 0 }}>
                            {field.name}{field.optional ? '?' : ''}
                          </span>
                          <span style={{ fontSize: 10, color: MUTED, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            : {field.type}
                          </span>
                        </div>
                        <div style={{ minWidth: 0 }}>
                          {dataVal !== undefined ? (
                            <span style={{
                              fontSize: 11, color: GREEN, fontFamily: 'monospace',
                              background: 'rgba(166,227,161,0.08)', borderRadius: 3,
                              padding: '1px 5px', display: 'inline-block',
                              maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }} title={String(dataVal)}>
                              {JSON.stringify(dataVal)}
                            </span>
                          ) : (
                            <span style={{ fontSize: 11, color: MUTED, fontStyle: 'italic', fontFamily: 'monospace' }}>—</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  {/* Extra data keys not in model */}
                  {Object.entries(state.data)
                    .filter(([k]) => !state.fields.some(f => f.name === k))
                    .map(([k, v]) => (
                      <div key={k} style={{
                        display: 'grid', gridTemplateColumns: '1fr 1fr',
                        gap: 4, padding: '4px 14px 4px 20px', alignItems: 'baseline', opacity: 0.6,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
                          <span style={{ fontSize: 12, color: SUBTEXT, fontFamily: 'monospace' }}>{k}</span>
                          <span style={{ fontSize: 10, color: MUTED, fontFamily: 'monospace' }}>: ?</span>
                        </div>
                        <span style={{
                          fontSize: 11, color: GREEN, fontFamily: 'monospace',
                          background: 'rgba(166,227,161,0.08)', borderRadius: 3,
                          padding: '1px 5px', display: 'inline-block',
                          maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }} title={String(v)}>
                          {JSON.stringify(v)}
                        </span>
                      </div>
                    ))
                  }
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div style={{
        padding: '6px 14px', borderTop: `1px solid ${BORDER}`,
        fontSize: 10, color: MUTED, flexShrink: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        src/pages/{pageId}/page.tsx
      </div>
    </div>
  )
}
