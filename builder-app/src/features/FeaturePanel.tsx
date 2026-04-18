import { useState } from 'react'
import type { Feature } from './types'

interface FeaturePanelProps {
  features: Feature[]
  activeFeature: Feature | null
  projectRoot: string
  onFeatureSelect: (feature: Feature) => void
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
    >×</button>
  )
}

export function FeaturePanel({
  features,
  activeFeature,
  projectRoot,
  onFeatureSelect,
  onAddFeature,
  onDeleteFeature,
}: FeaturePanelProps) {
  const [hoveredFeature, setHoveredFeature] = useState<string | null>(null)

  async function handleDeleteFeature(id: string) {
    if (!window.confirm(`Delete feature "${id}" and all its files?`)) return
    const qs = `?projectRoot=${encodeURIComponent(projectRoot)}`
    await fetch(`/__source/feature/${encodeURIComponent(id)}${qs}`, { method: 'DELETE' })
    onDeleteFeature(id)
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
            No features — click + to create one.
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
                <span style={{ fontSize: 11, color: ACCENT, flexShrink: 0 }}>◆</span>
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
      </div>
    </div>
  )
}
