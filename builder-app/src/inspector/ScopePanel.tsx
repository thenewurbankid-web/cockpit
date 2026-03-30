import React, { useState } from 'react'
import { InfoIcon } from './InfoIcon'
import type { ScopeItem, ScopeLayer, ScopePanelProps, ComponentProp, JsxAttr } from './types'

const LINK_COLORS = ['#a6e3a1', '#89dceb', '#cba6f7', '#fab387', '#f9e2af', '#94e2d5', '#f38ba8', '#89b4fa']

export function ScopePanel({ layers, onAddProp, onRemoveProp, onAddState, onRemoveState, readOnly }: ScopePanelProps) {
  const [expanded, setExpanded] = useState(true)
  if (layers.length === 0) return null

  const totalUsed = layers.reduce((s, l) =>
    s + l.props.filter(i => i.usedInNode).length + l.state.filter(i => i.usedInNode).length, 0)

  const childLayer = layers.find(l => l.isCurrent)
  const links = childLayer?.links ?? []
  const parentVarColor = new Map<string, string>()
  const childPropColor = new Map<string, string>()
  links.forEach((link, i) => {
    const color = LINK_COLORS[i % LINK_COLORS.length]
    if (link.parentVar) parentVarColor.set(link.parentVar, color)
    if (link.childProp) childPropColor.set(link.childProp, color)
  })

  return (
    <div style={scopeStyles.panel}>
      <button style={scopeStyles.header} onClick={() => setExpanded(v => !v)}>
        <span style={scopeStyles.chevron}>{expanded ? '▾' : '▸'}</span>
        <span>Scope</span>
        <InfoIcon text="Shows the component hierarchy and all available props & state variables in scope for the selected node. Variables marked as 'used' are currently bound." />
        {totalUsed > 0 && (
          <span style={scopeStyles.usedBadge}>{totalUsed} used</span>
        )}
      </button>
      {expanded && (
        <div style={scopeStyles.body}>
          {[...layers].reverse().map((layer, ri) => {
            const depth = layers.length - 1 - ri
            const isLast = ri === layers.length - 1
            const canEdit = !readOnly && layer.isCurrent
            const colorMap = layer.isCurrent ? childPropColor : parentVarColor
            return (
              <div key={layer.componentName} style={{ ...scopeStyles.layer, paddingLeft: 8 + depth * 12, position: 'relative' }}>
                {!isLast && (
                  <div style={{
                    position: 'absolute',
                    left: 8 + depth * 12 + 5,
                    top: 18,
                    bottom: -6,
                    width: 1,
                    background: 'rgba(137,180,250,0.18)',
                  }} />
                )}
                <div style={scopeStyles.layerHeader}>
                  <span style={layer.isCurrent ? scopeStyles.layerNameCurrent : scopeStyles.layerNameParent}>
                    {layer.isCurrent ? '▶ ' : '◦ '}{layer.componentName}
                  </span>
                  {layer.isCurrent
                    ? <span style={scopeStyles.currentBadge}>current</span>
                    : <span style={scopeStyles.parentBadge}>parent</span>
                  }
                </div>
                {(layer.props.length > 0 || canEdit) && (
                  <div style={scopeStyles.group}>
                    <span style={scopeStyles.groupLabel}>props</span>
                    <div style={scopeStyles.items}>
                      {layer.props.map(item => (
                        <ScopeItemChip
                          key={item.name}
                          item={item}
                          linkColor={colorMap.get(item.name)}
                          onRemove={canEdit ? () => onRemoveProp?.(layer.componentName, item.name) : undefined}
                        />
                      ))}
                      {canEdit && onAddProp && (
                        <span
                          style={scopeStyles.addChipBtn}
                          title="Add prop"
                          onClick={() => onAddProp(layer.componentName)}
                        >+</span>
                      )}
                    </div>
                  </div>
                )}
                {(layer.state.length > 0 || canEdit) && (
                  <div style={scopeStyles.group}>
                    <span style={scopeStyles.groupLabel}>state</span>
                    <div style={scopeStyles.items}>
                      {layer.state.map(item => (
                        <ScopeItemChip
                          key={item.name}
                          item={item}
                          linkColor={colorMap.get(item.name)}
                          onRemove={canEdit ? () => onRemoveState?.(layer.componentName, item.name) : undefined}
                        />
                      ))}
                      {canEdit && onAddState && (
                        <span
                          style={scopeStyles.addChipBtn}
                          title="Add state variable"
                          onClick={() => onAddState(layer.componentName)}
                        >+</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ScopeItemChip({ item, onRemove, linkColor }: { item: ScopeItem; onRemove?: () => void; linkColor?: string }) {
  const [copied, setCopied] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  function handleClick() {
    navigator.clipboard.writeText(item.name).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <div
      style={{
        ...scopeStyles.item,
        ...(item.usedInNode ? scopeStyles.itemUsed : {}),
        ...(linkColor ? { borderColor: linkColor + '60', background: linkColor + '14' } : {}),
        cursor: 'pointer',
        position: 'relative',
      }}
      onClick={confirmRemove ? undefined : handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false) }}
      title={confirmRemove ? '' : `Copy "${item.name}" to clipboard`}
    >
      {linkColor
        ? <span style={{ width: 6, height: 6, borderRadius: '50%', background: linkColor, flexShrink: 0, display: 'inline-block' }} />
        : <span style={scopeStyles.itemDot}>{item.usedInNode ? '●' : '○'}</span>
      }
      <code style={{ ...scopeStyles.itemName, ...(linkColor ? { color: linkColor } : {}) }}>{copied ? '✓' : item.name}</code>
      {!copied && item.typeStr && <span style={scopeStyles.itemType}>{item.typeStr}</span>}
      {onRemove && hovered && !confirmRemove && (
        <span
          style={scopeStyles.removeBtn}
          title={`Remove ${item.name}`}
          onClick={(e) => { e.stopPropagation(); setConfirmRemove(true) }}
        >✕</span>
      )}
      {confirmRemove && (
        <span style={scopeStyles.confirmOverlay}>
          <span style={{ fontSize: 10 }}>Remove?</span>
          <span
            style={scopeStyles.confirmYes}
            onClick={(e) => { e.stopPropagation(); onRemove?.() }}
          >Yes</span>
          <span
            style={scopeStyles.confirmNo}
            onClick={(e) => { e.stopPropagation(); setConfirmRemove(false) }}
          >No</span>
        </span>
      )}
    </div>
  )
}

export const scopeStyles: Record<string, React.CSSProperties> = {
  panel: {
    flexShrink: 0,
    borderBottom: '1px solid #1e1e2e',
    maxHeight: 280,
    display: 'flex',
    flexDirection: 'column',
    background: '#13131f',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.35rem',
    width: '100%',
    background: 'none',
    borderTop: 'none',
    borderLeft: 'none',
    borderRight: 'none',
    borderBottom: '1px solid #1e1e2e',
    color: '#7f849c',
    cursor: 'pointer',
    padding: '0.4rem 0.9rem',
    fontSize: '0.68rem',
    fontWeight: 700,
    textAlign: 'left' as const,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    flexShrink: 0,
  },
  chevron: { fontSize: '0.6rem', color: '#585b70', marginRight: 1 },
  usedBadge: {
    marginLeft: 'auto',
    fontSize: '0.67rem',
    color: '#a6e3a1',
    fontWeight: 600,
    background: 'rgba(166,227,161,0.1)',
    border: '1px solid rgba(166,227,161,0.25)',
    borderRadius: 10,
    padding: '1px 7px',
  },
  body: { overflowY: 'auto' as const, padding: '0.4rem 0 0.6rem' },
  layer: { marginBottom: 6 },
  layerHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    marginBottom: 4,
    paddingRight: 10,
  },
  layerNameCurrent: {
    fontSize: '0.75rem',
    fontWeight: 700,
    color: '#89b4fa',
    letterSpacing: '0.01em',
  },
  layerNameParent: {
    fontSize: '0.72rem',
    color: '#6c7086',
    letterSpacing: '0.01em',
  },
  currentBadge: {
    marginLeft: 'auto',
    fontSize: '0.6rem',
    color: '#1e1e2e',
    background: '#89b4fa',
    borderRadius: 10,
    padding: '1px 7px',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
  },
  parentBadge: {
    marginLeft: 'auto',
    fontSize: '0.6rem',
    color: '#6c7086',
    background: 'transparent',
    border: '1px solid #45475a',
    borderRadius: 10,
    padding: '1px 7px',
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
  },
  group: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 5,
    marginBottom: 3,
    paddingLeft: 14,
  },
  groupLabel: {
    fontSize: '0.58rem',
    color: '#45475a',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.07em',
    minWidth: 30,
    paddingTop: 3,
    flexShrink: 0,
  },
  items: { display: 'flex', flexWrap: 'wrap' as const, gap: '3px 4px' },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    fontSize: '0.71rem',
    color: '#45475a',
    padding: '2px 7px',
    borderRadius: 99,
    background: 'transparent',
    border: '1px solid #2a2a3d',
  },
  itemUsed: {
    color: '#b4cefa',
    background: 'rgba(137,180,250,0.1)',
    border: '1px solid rgba(137,180,250,0.28)',
  },
  itemDot: { fontSize: '0.5rem' },
  itemName: {
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '0.7rem',
    fontWeight: 500,
  },
  itemType: {
    fontSize: '0.62rem',
    color: '#45475a',
    fontStyle: 'italic' as const,
    marginLeft: 1,
  },
  addChipBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 20,
    height: 20,
    borderRadius: '50%',
    border: '1px dashed #45475a',
    background: 'transparent',
    color: '#6c7086',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    lineHeight: 1,
    padding: 0,
    flexShrink: 0,
  },
  removeBtn: {
    marginLeft: 2,
    fontSize: 9,
    color: '#f38ba8',
    cursor: 'pointer',
    lineHeight: 1,
    fontWeight: 700,
  } as React.CSSProperties,
  confirmOverlay: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    marginLeft: 4,
    fontSize: 9,
    color: '#f38ba8',
    fontFamily: 'system-ui, sans-serif',
  } as React.CSSProperties,
  confirmYes: {
    cursor: 'pointer',
    fontWeight: 700,
    padding: '1px 4px',
    borderRadius: 3,
    border: '1px solid #f38ba8',
    lineHeight: 1.4,
    fontSize: 9,
    color: '#f38ba8',
  } as React.CSSProperties,
  confirmNo: {
    cursor: 'pointer',
    padding: '1px 4px',
    borderRadius: 3,
    border: '1px solid #45475a',
    lineHeight: 1.4,
    fontSize: 9,
    color: '#6c7086',
  } as React.CSSProperties,
}
