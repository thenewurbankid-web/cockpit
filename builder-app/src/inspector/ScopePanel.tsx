import React, { useState } from 'react'
import { InfoIcon } from './InfoIcon'
import { scopeStyles } from './styles'
import type { ScopeItem, ScopeLayer, ScopePanelProps, ComponentProp, JsxAttr } from './types'

const LINK_COLORS = ['#a6e3a1', '#89dceb', '#cba6f7', '#fab387', '#f9e2af', '#94e2d5', '#f38ba8', '#89b4fa']

export function ScopePanel({ layers, onAddProp, onRemoveProp, onAddState, onRemoveState, readOnly }: ScopePanelProps) {
  const [expanded, setExpanded] = useState(false)
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

export { scopeStyles } from './styles'
