import { useState } from 'react'
import type { Feature, FeatureItemSelection, FeaturePage } from './types'

interface FeatureDetailPanelProps {
  feature: Feature
  activeItem: FeatureItemSelection | null
  projectRoot: string
  width: number
  onItemSelect: (sel: FeatureItemSelection, file: string) => void
  onAddService: () => void
  onDeleteService: (featureId: string, serviceId: string) => void
  onAddFlow: () => void
  onDeleteFlow: (featureId: string, flowId: string) => void
  onAddPage: () => void
  onDeletePage: (featureId: string, pageId: string) => void
}

const BG = '#1e1e2e'
const SURFACE = '#181825'
const BORDER = '#313244'
const MUTED = '#6c7086'
const TEXT = '#cdd6f4'
const ACCENT = '#fab387'
const BLUE = '#89b4fa'
const PURPLE = '#cba6f7'
const GREEN = '#a6e3a1'
const SUBTEXT = '#a6adc8'

function AccordionHeader({
  label, color, count, addLabel, onAdd, expanded, onToggle,
}: {
  label: string; color: string; count: number; addLabel: string
  onAdd: () => void; expanded: boolean; onToggle: () => void
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '8px 14px', cursor: 'pointer',
      borderBottom: `1px solid ${BORDER}`,
      background: expanded ? `${color}0a` : 'transparent',
      userSelect: 'none',
    }}>
      <span
        onClick={onToggle}
        style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <span style={{ fontSize: 10, color, flexShrink: 0 }}>{expanded ? '▾' : '▸'}</span>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color }}>{label}</span>
        <span style={{ fontSize: 10, color: MUTED, fontFamily: 'monospace' }}>{count}</span>
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); onAdd() }}
        style={{
          background: 'none', border: `1px solid ${BORDER}`, borderRadius: 3,
          color: MUTED, cursor: 'pointer', fontSize: 10, padding: '1px 7px',
        }}
      >{addLabel}</button>
    </div>
  )
}

function ItemRow({
  icon, label, color, active, onClick, onDelete,
}: {
  icon: string; label: string; color: string; active: boolean
  onClick: () => void; onDelete: () => void
}) {
  const [hov, setHov] = useState(false)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '5px 14px 5px 22px', cursor: 'pointer',
        background: active ? `${color}18` : hov ? `${color}0a` : 'transparent',
        borderLeft: `2px solid ${active ? color : 'transparent'}`,
        borderBottom: `1px solid ${BORDER}`,
      }}
    >
      <span style={{ fontSize: 10, color: MUTED, flexShrink: 0 }}>{icon}</span>
      <span style={{ fontSize: 12, color: active ? color : SUBTEXT, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {(hov || active) && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          style={{ background: 'none', border: 'none', color: MUTED, cursor: 'pointer', fontSize: 13, padding: '0 2px', lineHeight: 1, flexShrink: 0 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#f38ba8' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = MUTED }}
        >×</button>
      )}
    </div>
  )
}

export function FeatureDetailPanel({
  feature, activeItem, projectRoot, width,
  onItemSelect, onAddService, onDeleteService, onAddFlow, onDeleteFlow, onAddPage, onDeletePage,
}: FeatureDetailPanelProps) {
  const [expanded, setExpanded] = useState({ pages: true, services: true, flows: true })

  function toggle(section: keyof typeof expanded) {
    setExpanded(e => ({ ...e, [section]: !e[section] }))
  }

  function pageFile(pageId: string) {
    return `${projectRoot}/src/pages/${pageId}/page.tsx`
  }
  function serviceFile(serviceId: string) {
    return `${projectRoot}/src/features/${feature.id}/${serviceId}.ts`
  }
  function machineFile(flowId: string) {
    return `${projectRoot}/src/features/${feature.id}/${flowId}.machine.ts`
  }

  async function handleDeleteService(serviceId: string) {
    if (!window.confirm(`Delete ${serviceId}.ts?`)) return
    const qs = `featureId=${encodeURIComponent(feature.id)}&serviceId=${encodeURIComponent(serviceId)}&projectRoot=${encodeURIComponent(projectRoot)}`
    await fetch(`/__source/service?${qs}`, { method: 'DELETE' })
    onDeleteService(feature.id, serviceId)
  }

  async function handleDeleteFlow(flowId: string) {
    if (!window.confirm(`Delete ${flowId}.machine.ts and ${flowId}.actor.ts?`)) return
    const qs = `featureId=${encodeURIComponent(feature.id)}&flowId=${encodeURIComponent(flowId)}&projectRoot=${encodeURIComponent(projectRoot)}`
    await fetch(`/__source/flow?${qs}`, { method: 'DELETE' })
    onDeleteFlow(feature.id, flowId)
  }

  async function handleDeletePage(pageId: string) {
    if (!window.confirm(`Unlink "${pageId}" from this feature?`)) return
    const qs = `featureId=${encodeURIComponent(feature.id)}&pageId=${encodeURIComponent(pageId)}&projectRoot=${encodeURIComponent(projectRoot)}`
    await fetch(`/__source/feature-page?${qs}`, { method: 'DELETE' })
    onDeletePage(feature.id, pageId)
  }

  return (
    <div style={{
      position: 'fixed', right: 0, top: 0, bottom: 0, width,
      background: BG, borderLeft: `1px solid ${BORDER}`,
      display: 'flex', flexDirection: 'column',
      zIndex: 150, fontFamily: 'system-ui, sans-serif',
    }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 14px', borderBottom: `1px solid ${BORDER}`, flexShrink: 0,
      }}>
        <span style={{ fontSize: 10, color: ACCENT, fontWeight: 700, letterSpacing: 0.5 }}>FEATURE</span>
        <span style={{ fontSize: 14, color: TEXT, fontWeight: 600, flex: 1 }}>{feature.name}</span>
      </div>

      {/* Scrollable accordions */}
      <div style={{ flex: 1, overflowY: 'auto' }}>

        {/* ── Pages ── */}
        <AccordionHeader
          label="Pages" color={BLUE} count={feature.pages.length}
          addLabel="+ link" onAdd={onAddPage}
          expanded={expanded.pages} onToggle={() => toggle('pages')}
        />
        {expanded.pages && (
          <>
            {feature.pages.length === 0 && (
              <div style={{ padding: '8px 22px', fontSize: 11, color: MUTED, fontStyle: 'italic', borderBottom: `1px solid ${BORDER}` }}>
                No linked pages
              </div>
            )}
            {feature.pages.map((page: FeaturePage) => {
              const active = activeItem?.kind === 'page' && activeItem.itemId === page.id
              return (
                <div key={page.id}>
                  <ItemRow
                    icon="□" label={page.id} color={BLUE} active={active}
                    onClick={() => onItemSelect({ kind: 'page', featureId: feature.id, itemId: page.id }, pageFile(page.id))}
                    onDelete={() => void handleDeletePage(page.id)}
                  />
                  {page.props.length > 0 && (
                    <div style={{ padding: '4px 14px 6px 32px', background: `${BLUE}06`, borderBottom: `1px solid ${BORDER}` }}>
                      {page.props.map(p => (
                        <div key={p.name} style={{ display: 'flex', gap: 4, fontSize: 11, padding: '1px 0', fontFamily: 'monospace' }}>
                          <span style={{ color: BLUE }}>{p.name}{p.optional ? '?' : ''}</span>
                          <span style={{ color: MUTED }}>:</span>
                          <span style={{ color: GREEN, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.type}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}

        {/* ── Services ── */}
        <AccordionHeader
          label="Services" color={PURPLE} count={feature.services.length}
          addLabel="+ new" onAdd={onAddService}
          expanded={expanded.services} onToggle={() => toggle('services')}
        />
        {expanded.services && (
          <>
            {feature.services.length === 0 && (
              <div style={{ padding: '8px 22px', fontSize: 11, color: MUTED, fontStyle: 'italic', borderBottom: `1px solid ${BORDER}` }}>
                No services
              </div>
            )}
            {feature.services.map(sid => {
              const active = activeItem?.kind === 'service' && activeItem.itemId === sid
              return (
                <ItemRow
                  key={sid} icon="⚙" label={sid} color={PURPLE} active={active}
                  onClick={() => onItemSelect({ kind: 'service', featureId: feature.id, itemId: sid }, serviceFile(sid))}
                  onDelete={() => void handleDeleteService(sid)}
                />
              )
            })}
          </>
        )}

        {/* ── Flows ── */}
        <AccordionHeader
          label="Flows" color={GREEN} count={feature.flows.length}
          addLabel="+ new" onAdd={onAddFlow}
          expanded={expanded.flows} onToggle={() => toggle('flows')}
        />
        {expanded.flows && (
          <>
            {feature.flows.length === 0 && (
              <div style={{ padding: '8px 22px', fontSize: 11, color: MUTED, fontStyle: 'italic', borderBottom: `1px solid ${BORDER}` }}>
                No flows
              </div>
            )}
            {feature.flows.map(fid => {
              const active = activeItem?.kind === 'flow' && activeItem.itemId === fid
              return (
                <ItemRow
                  key={fid} icon="⟳" label={fid} color={GREEN} active={active}
                  onClick={() => onItemSelect({ kind: 'flow', featureId: feature.id, itemId: fid }, machineFile(fid))}
                  onDelete={() => void handleDeleteFlow(fid)}
                />
              )
            })}
          </>
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: '6px 14px', borderTop: `1px solid ${BORDER}`,
        fontSize: 10, color: MUTED, flexShrink: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        src/features/{feature.id}/
      </div>
    </div>
  )
}
