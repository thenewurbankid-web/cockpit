import { useState, useEffect } from 'react'
import type { Feature } from './types'

interface FlowState {
  id: string
  states: string[]
}

interface StateTransition {
  event: string
  target?: string
  hasGuard: boolean
  actionCount: number
}

interface StateDetail {
  name: string
  stateType: string
  entryCount: number
  exitCount: number
  transitions: StateTransition[]
}

interface StateAction {
  state: string
  trigger: string
  assigns: string[]
}

interface MachineDetails {
  events: { type: string; payload: unknown[] }[]
  states: StateDetail[]
  actions: StateAction[]
}

interface FeaturePanelProps {
  features: Feature[]
  activeFeature: Feature | null
  projectRoot: string
  selectedFlow: string | null
  onFeatureSelect: (feature: Feature) => void
  onFlowSelect: (flowId: string | null) => void
  onStateSelect: (state: string | null, eventNames: string[]) => void
  onAddFeature: () => void
  onDeleteFeature: (id: string) => void
}

const ACCENT = '#fab387'

const s = {
  root: {
    width: 240,
    minWidth: 240,
    background: '#181825',
    borderRight: '1px solid #313244',
    display: 'flex',
    flexDirection: 'column' as const,
    fontFamily: 'system-ui, sans-serif',
    overflow: 'hidden',
    height: '100%',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px 6px',
    borderBottom: '1px solid #313244',
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 1,
    textTransform: 'uppercase' as const,
    color: '#6c7086',
  },
  addBtn: {
    background: 'none',
    border: 'none',
    color: '#6c7086',
    cursor: 'pointer',
    fontSize: 18,
    lineHeight: 1,
    padding: '0 2px',
  },
  scroll: {
    flex: 1,
    overflowY: 'auto' as const,
  },
}

function featureRowStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    padding: '7px 12px',
    cursor: 'pointer',
    background: active ? 'rgba(250,179,135,0.10)' : 'transparent',
    borderLeft: `2px solid ${active ? ACCENT : 'transparent'}`,
    gap: 6,
  }
}

function DeleteX({ onClick }: { onClick: () => void }) {
  const [hov, setHov] = useState(false)
  return (
    <button
      style={{ background: 'none', border: 'none', color: hov ? '#f38ba8' : '#45475a', cursor: 'pointer', fontSize: 13, padding: '0 2px', lineHeight: 1, marginLeft: 'auto', flexShrink: 0 }}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
    >x</button>
  )
}

export function FeaturePanel({
  features,
  activeFeature,
  projectRoot,
  selectedFlow,
  onFeatureSelect,
  onFlowSelect,
  onStateSelect,
  onAddFeature,
  onDeleteFeature,
}: FeaturePanelProps) {
  const [hoveredFeature, setHoveredFeature] = useState<string | null>(null)
  const [flowStates, setFlowStates] = useState<FlowState[]>([])
  const [selectedState, setSelectedState] = useState<string | null>(null)
  const [machineDetails, setMachineDetails] = useState<MachineDetails | null>(null)

  useEffect(() => {
    if (!activeFeature || !projectRoot) { setFlowStates([]); return }
    void fetch(
      `/__source/all-flow-states?projectRoot=${encodeURIComponent(projectRoot)}&featureId=${encodeURIComponent(activeFeature.id)}`
    )
      .then(r => r.json())
      .then(d => {
        setFlowStates(d.flows ?? [])
      })
      .catch(() => setFlowStates([]))
  }, [activeFeature?.id, projectRoot])

  useEffect(() => {
    setSelectedState(null)
    onStateSelect(null, [])
    setMachineDetails(null)
    if (!selectedFlow || !activeFeature || !projectRoot) return
    void fetch(
      `/__source/flow-machine-details?projectRoot=${encodeURIComponent(projectRoot)}&featureId=${encodeURIComponent(activeFeature.id)}&flowId=${encodeURIComponent(selectedFlow)}`
    )
      .then(r => r.json())
      .then(d => setMachineDetails(d))
      .catch(() => setMachineDetails(null))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFlow, activeFeature?.id, projectRoot])

  async function handleDeleteFeature(id: string) {
    if (!window.confirm(`Delete feature "${id}" and all its files?`)) return
    const qs = `?projectRoot=${encodeURIComponent(projectRoot)}`
    await fetch(`/__source/feature/${encodeURIComponent(id)}${qs}`, { method: 'DELETE' })
    onDeleteFeature(id)
  }

  const selectedFlowData = selectedFlow ? flowStates.find(f => f.id === selectedFlow) : null

  // Flow states view — when a flow is selected
  if (selectedFlow) {
    return (
      <div style={s.root}>
        <div style={s.sectionHeader}>
          <button
            onClick={() => onFlowSelect(null)}
            style={{ background: 'none', border: 'none', color: '#6c7086', cursor: 'pointer', fontSize: 13, padding: '0 4px 0 0', lineHeight: 1 }}
            title="Back to features"
          >←</button>
          <span style={{ fontSize: 11, color: '#a6e3a1', fontFamily: 'monospace', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedFlow}</span>
          {selectedFlowData && <span style={{ fontSize: 9, color: '#45475a' }}>{selectedFlowData.states.length} states</span>}
        </div>
        <div style={s.scroll}>
          {!selectedFlowData && (
            <div style={{ padding: '16px 12px', color: '#45475a', fontSize: 12, fontStyle: 'italic' }}>Loading...</div>
          )}
          {selectedFlowData && selectedFlowData.states.length === 0 && (
            <div style={{ padding: '16px 12px', color: '#45475a', fontSize: 12, fontStyle: 'italic' }}>No states defined.</div>
          )}
          {selectedFlowData && selectedFlowData.states.map(state => {
            const stateDetail = machineDetails?.states.find(s => s.name === state)
            return (
              <div
                key={state}
                onClick={() => {
                  setSelectedState(state)
                  const eventNames = stateDetail?.transitions.map(t => t.event) ?? []
                  onStateSelect(state, eventNames)
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderBottom: '1px solid #1e1e2e', cursor: 'pointer', background: selectedState === state ? 'rgba(166,227,161,0.10)' : 'transparent', borderLeft: `2px solid ${selectedState === state ? '#a6e3a1' : 'transparent'}` }}
              >
                <span style={{ fontSize: 9, color: selectedState === state ? '#a6e3a1' : '#45475a', flexShrink: 0 }}>◦</span>
                <span style={{ fontSize: 12, color: selectedState === state ? '#a6e3a1' : '#cdd6f4', fontFamily: 'monospace', flex: 1 }}>{state}</span>
                {stateDetail && stateDetail.transitions.length > 0 && (
                  <span style={{ fontSize: 9, color: '#45475a' }}>{stateDetail.transitions.length}ev</span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div style={s.root}>
      <div style={s.sectionHeader}>
        <span style={s.sectionLabel}>Features</span>
        <button style={s.addBtn} onClick={onAddFeature} title="New feature">+</button>
      </div>

      <div style={s.scroll}>
        {features.length === 0 && (
          <div style={{ padding: '16px 12px', color: '#45475a', fontSize: 12, fontStyle: 'italic' }}>
            No features -- click + to create one.
          </div>
        )}

        {features.map(feature => {
          const isActive = activeFeature?.id === feature.id
          return (
            <div key={feature.id}>
              <div
                style={featureRowStyle(isActive)}
                onClick={() => onFeatureSelect(feature)}
                onMouseEnter={() => setHoveredFeature(feature.id)}
                onMouseLeave={() => setHoveredFeature(null)}
              >
                <span style={{ fontSize: 11, color: ACCENT, flexShrink: 0 }}>*</span>
                <span style={{ fontSize: 13, color: isActive ? ACCENT : '#cdd6f4', fontWeight: isActive ? 600 : 400, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {feature.name}
                </span>
                {(hoveredFeature === feature.id || isActive) && (
                  <DeleteX onClick={() => void handleDeleteFeature(feature.id)} />
                )}
              </div>
            </div>
          )
        })}

        {activeFeature && flowStates.length > 0 && (
          <div>
            <div style={{ padding: '8px 12px 4px', borderTop: '1px solid #313244', marginTop: 4 }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#45475a' }}>Flows</span>
            </div>
            {flowStates.map(flow => (
              <div
                key={flow.id}
                onClick={() => onFlowSelect(flow.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '5px 12px 5px 10px', cursor: 'pointer',
                  borderBottom: '1px solid #1e1e2e',
                }}
              >
                <span style={{ fontSize: 9, color: '#45475a', flexShrink: 0 }}>›</span>
                <span style={{ fontSize: 11, color: '#6c7086', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {flow.id}
                </span>
                {flow.states.length > 0 && (
                  <span style={{ fontSize: 9, color: '#45475a', flexShrink: 0 }}>{flow.states.length}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
