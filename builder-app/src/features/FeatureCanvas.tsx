import { useState, useEffect, useRef } from 'react'
import type { Feature } from './types'

interface FeatureCanvasProps {
  feature: Feature
  projectRoot: string
  onSummaryChange: (summary: string) => void
  onAddPage: () => void
  onDeletePage: (featureId: string, pageId: string) => void
  onAddFlow: () => void
  onDeleteFlow: (featureId: string, flowId: string) => void
  onNameChange?: (name: string) => void
  onFlowSelect?: (flowId: string) => void
  activeFlowId?: string | null
  onPageSelect?: (pageId: string) => void
  activePageId?: string | null
}

const BG = '#11111b'
const SURFACE = '#1e1e2e'
const CARD = '#181825'
const BORDER = '#313244'
const MUTED = '#6c7086'
const TEXT = '#cdd6f4'
const SUBTEXT = '#a6adc8'
const ACCENT = '#fab387'
const BLUE = '#89b4fa'
const GREEN = '#a6e3a1'

export function FeatureCanvas({
  feature,
  projectRoot,
  onSummaryChange,
  onAddPage,
  onDeletePage,
  onAddFlow,
  onDeleteFlow,
  onNameChange,
  onFlowSelect,
  activeFlowId,
  onPageSelect,
  activePageId,
}: FeatureCanvasProps) {
  const [summary, setSummary] = useState(feature.summary)
  const [editingSummary, setEditingSummary] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState(feature.name)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  // Sync when feature changes
  useEffect(() => {
    setSummary(feature.summary)
    setNameValue(feature.name)
  }, [feature.id, feature.summary, feature.name])

  // Auto-focus name input when editing starts
  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    }
  }, [editingName])

  async function saveFeatureName(val: string) {
    const trimmed = val.trim()
    if (!trimmed || trimmed === feature.name) { setNameValue(feature.name); setEditingName(false); return }
    setNameValue(trimmed)
    setEditingName(false)
    await fetch('/__source/rename-feature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot, featureId: feature.id, name: trimmed }),
    })
    onNameChange?.(trimmed)
  }

  function handleSummaryChange(val: string) {
    setSummary(val)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      await fetch('/__source/feature-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRoot, featureId: feature.id, summary: val }),
      })
      onSummaryChange(val)
    }, 500)
  }

  async function handleDeletePage(pageId: string) {
    if (!window.confirm(`Unlink "${pageId}" from this feature?`)) return
    const qs = `featureId=${encodeURIComponent(feature.id)}&pageId=${encodeURIComponent(pageId)}&projectRoot=${encodeURIComponent(projectRoot)}`
    await fetch(`/__source/feature-page?${qs}`, { method: 'DELETE' })
    onDeletePage(feature.id, pageId)
  }

  async function handleDeleteFlow(flowId: string) {
    if (!window.confirm(`Delete ${flowId}.machine.ts and ${flowId}.actor.ts?`)) return
    const qs = `featureId=${encodeURIComponent(feature.id)}&flowId=${encodeURIComponent(flowId)}&projectRoot=${encodeURIComponent(projectRoot)}`
    await fetch(`/__source/flow?${qs}`, { method: 'DELETE' })
    onDeleteFlow(feature.id, flowId)
  }

  return (
    <div style={{
      flex: 1, overflowY: 'auto', background: BG,
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{
        maxWidth: 1120, margin: '0 auto', padding: '24px 16px 60px',
      }}>

        {/* Feature badge + name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 1,
            textTransform: 'uppercase', color: ACCENT,
            background: `${ACCENT}18`, border: `1px solid ${ACCENT}40`,
            borderRadius: 4, padding: '2px 8px',
          }}>Feature</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 32 }}>
          {editingName ? (
            <input
              ref={nameInputRef}
              value={nameValue}
              onChange={e => setNameValue(e.target.value)}
              onBlur={() => void saveFeatureName(nameValue)}
              onKeyDown={e => {
                if (e.key === 'Enter') void saveFeatureName(nameValue)
                if (e.key === 'Escape') { setNameValue(feature.name); setEditingName(false) }
              }}
              style={{
                fontSize: 28, fontWeight: 700, color: TEXT, letterSpacing: -0.5,
                background: 'transparent', border: 'none', borderBottom: `2px solid ${ACCENT}`,
                outline: 'none', fontFamily: 'system-ui, sans-serif', width: '100%', padding: '0 2px',
              }}
            />
          ) : (
            <h1
              style={{ margin: 0, fontSize: 28, fontWeight: 700, color: TEXT, letterSpacing: -0.5 }}
            >{nameValue}</h1>
          )}
          {!editingName && (
            <button
              onClick={() => setEditingName(true)}
              title="Rename feature"
              style={{
                background: 'none', border: 'none', borderRadius: 4,
                color: MUTED, cursor: 'pointer', padding: '2px 4px',
                display: 'flex', alignItems: 'center', flexShrink: 0, lineHeight: 1,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = TEXT }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = MUTED }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
          )}
        </div>

        {/* Summary card */}
        <div style={{
          background: CARD, border: `1px solid ${BORDER}`,
          borderRadius: 8, marginBottom: 24, overflow: 'hidden',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 16px', borderBottom: `1px solid ${BORDER}`,
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: MUTED }}>
              Summary
            </span>
            <button
              onClick={() => setEditingSummary(v => !v)}
              style={{
                background: 'none', border: `1px solid ${BORDER}`, borderRadius: 4,
                color: editingSummary ? SUBTEXT : MUTED, cursor: 'pointer',
                fontSize: 10, padding: '2px 8px', fontFamily: 'inherit',
              }}
            >{editingSummary ? 'Done' : 'Edit'}</button>
          </div>

          {editingSummary ? (
            <textarea
              ref={textareaRef}
              value={summary}
              onChange={e => handleSummaryChange(e.target.value)}
              placeholder="Describe what this feature does, its goals, and key interactions…"
              style={{
                width: '100%', boxSizing: 'border-box', minHeight: 120,
                background: 'transparent', border: 'none', outline: 'none',
                color: TEXT, fontSize: 14, lineHeight: 1.6,
                padding: '14px 16px', resize: 'vertical',
                fontFamily: 'system-ui, sans-serif',
              }}
            />
          ) : (
            <div
              onClick={() => setEditingSummary(true)}
              style={{
                padding: '14px 16px', minHeight: 60, cursor: 'text',
                color: summary ? TEXT : MUTED, fontSize: 14, lineHeight: 1.6,
                fontStyle: summary ? 'normal' : 'italic',
              }}
            >
              {summary || 'No summary yet — click to add one.'}
            </div>
          )}
        </div>

        {/* Pages + Flows side by side */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Section
            label="Pages"
            color={BLUE}
            addLabel="+ Link page"
            onAdd={onAddPage}
            empty={feature.pages.length === 0}
            emptyText="No pages linked yet."
          >
            {feature.pages.map(page => (
              <ItemRow
                key={page.id}
                icon="□"
                label={page.id}
                color={BLUE}
                meta={page.props.length > 0 ? `${page.props.length} prop${page.props.length === 1 ? '' : 's'}` : undefined}
                active={activePageId === page.id}
                onClick={() => onPageSelect?.(page.id)}
                onDelete={() => void handleDeletePage(page.id)}
              />
            ))}
          </Section>

          <Section
            label="Flows"
            color={GREEN}
            addLabel="+ New flow"
            onAdd={onAddFlow}
            empty={feature.flows.length === 0}
            emptyText="No flows yet."
          >
            {feature.flows.map(fid => (
              <ItemRow
                key={fid}
                icon="⟳"
                label={fid}
                color={GREEN}
                meta=".machine.ts"
                active={activeFlowId === fid}
                onClick={() => onFlowSelect?.(fid)}
                onDelete={() => void handleDeleteFlow(fid)}
              />
            ))}
          </Section>
        </div>

      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Section({
  label, color, addLabel, onAdd, empty, emptyText, children,
}: {
  label: string; color: string; addLabel: string; onAdd: () => void
  empty: boolean; emptyText: string; children: React.ReactNode
}) {
  return (
    <div style={{
      background: CARD, border: `1px solid ${BORDER}`,
      borderRadius: 8, marginBottom: 16, overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', borderBottom: `1px solid ${BORDER}`,
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color }}>
          {label}
        </span>
        <button
          onClick={onAdd}
          style={{
            background: 'none', border: `1px solid ${BORDER}`, borderRadius: 4,
            color: MUTED, cursor: 'pointer', fontSize: 10, padding: '2px 8px',
            fontFamily: 'inherit',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = color }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = MUTED }}
        >{addLabel}</button>
      </div>
      {empty ? (
        <div style={{ padding: '14px 16px', fontSize: 12, color: MUTED, fontStyle: 'italic' }}>
          {emptyText}
        </div>
      ) : (
        <div>{children}</div>
      )}
    </div>
  )
}

function ItemRow({
  icon, label, color, meta, active, onClick, onDelete,
}: {
  icon: string; label: string; color: string; meta?: string
  active?: boolean; onClick?: () => void; onDelete: () => void
}) {
  const [hov, setHov] = useState(false)
  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '9px 16px', borderBottom: `1px solid ${BORDER}`,
        background: active ? `${color}18` : hov ? `${color}08` : 'transparent',
        borderLeft: `2px solid ${active ? color : 'transparent'}`,
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <span style={{ fontSize: 11, color: MUTED, flexShrink: 0 }}>{icon}</span>
      <span style={{ fontSize: 13, color: TEXT, fontWeight: 500, flex: 1 }}>{label}</span>
      {meta && (
        <span style={{
          fontSize: 10, color: MUTED, background: SURFACE, border: `1px solid ${BORDER}`,
          borderRadius: 3, padding: '1px 6px', fontFamily: 'monospace',
        }}>{meta}</span>
      )}
      {hov && (
        <button
          onClick={onDelete}
          style={{
            background: 'none', border: 'none', color: MUTED, cursor: 'pointer',
            fontSize: 14, padding: '0 2px', lineHeight: 1, flexShrink: 0,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#f38ba8' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = MUTED }}
          title={`Remove ${label}`}
        >×</button>
      )}
    </div>
  )
}
