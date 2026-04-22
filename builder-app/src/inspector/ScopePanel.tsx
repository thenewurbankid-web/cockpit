import React, { useState } from 'react'
import { InfoIcon } from './InfoIcon'
import { scopeStyles } from './styles'
import type { ScopeItem, ScopeLayer, ScopePanelProps, ComponentProp, JsxAttr } from './types'

const LINK_COLORS = ['#a6e3a1', '#89dceb', '#cba6f7', '#fab387', '#f9e2af', '#94e2d5', '#f38ba8', '#89b4fa']

export function ScopePanel({ layers, onAddProp, onRemoveProp, onAddState, onRemoveState, readOnly }: ScopePanelProps) {
  const [expanded, setExpanded] = useState(true)
  if (layers.length === 0) return null

  const totalUsed = layers.reduce((s, l) =>
    s + l.props.filter(i => i.usedInNode).length + l.state.filter(i => i.usedInNode).length, 0)

  // Build per-layer color maps: links in layer[i] describe what layer[i-1] passes to layer[i].
  // Each link gets a unique color so the parent var and the child prop share the same color.
  const layerColorMaps: Map<string, string>[] = layers.map(() => new Map())
  let globalColorIdx = 0
  for (let i = 1; i < layers.length; i++) {
    for (const link of (layers[i].links ?? [])) {
      const color = LINK_COLORS[globalColorIdx % LINK_COLORS.length]
      globalColorIdx++
      if (link.parentVar) layerColorMaps[i - 1].set(link.parentVar, color)
      if (link.childProp) layerColorMaps[i].set(link.childProp, color)
    }
  }

  // childBindings: vars in the current layer flowing down to child components
  const currentLayerIdx = layers.findIndex(l => l.isCurrent)
  const allChildBindings = layers[currentLayerIdx]?.childBindings ?? []
  for (const { bindings } of allChildBindings) {
    for (const { rootVar } of bindings) {
      if (!layerColorMaps[currentLayerIdx].has(rootVar)) {
        layerColorMaps[currentLayerIdx].set(rootVar, LINK_COLORS[globalColorIdx % LINK_COLORS.length])
        globalColorIdx++
      }
    }
  }

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
            // Keep the connector line if there are child layers below the current
            const isLast = ri === layers.length - 1 && allChildBindings.length === 0
            const canEdit = !readOnly && layer.isCurrent
            const colorMap = layerColorMaps[depth]
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
                    : <span style={scopeStyles.parentBadge}>{depth === layers.length - 2 ? 'parent' : 'ancestor'}</span>
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

          {/* Child component layers — vars from current scope flowing down */}
          {allChildBindings.map(({ componentName, bindings }, di, arr) => {
            const depth = layers.length
            const isSubComponent = componentName.includes('.')
            const isLastChild = di === arr.length - 1
            // Group bindings by childProp, collecting all rootVars per prop
            const bindingsByProp = new Map<string, string[]>()
            for (const b of bindings) {
              const existing = bindingsByProp.get(b.childProp)
              if (existing) {
                if (!existing.includes(b.rootVar)) existing.push(b.rootVar)
              } else {
                bindingsByProp.set(b.childProp, [b.rootVar])
              }
            }
            const groupedBindings = Array.from(bindingsByProp.entries()).map(([childProp, rootVars]) => ({ childProp, rootVars }))
            return (
              <div key={`${componentName}-${di}`} style={{ ...scopeStyles.layer, paddingLeft: 8 + depth * 12 + (isSubComponent ? 14 : 0), position: 'relative' }}>
                {!isLastChild && (
                  <div style={{
                    position: 'absolute',
                    left: 8 + depth * 12 + (isSubComponent ? 14 : 0) + 5,
                    top: 18,
                    bottom: -6,
                    width: 1,
                    background: 'rgba(137,180,250,0.18)',
                  }} />
                )}
                <div style={scopeStyles.layerHeader}>
                  <span style={scopeStyles.layerNameParent}>◦ {componentName}</span>
                  <span style={scopeStyles.parentBadge}>child</span>
                </div>
                {groupedBindings.length > 0 && (
                  <div style={scopeStyles.group}>
                    <span style={scopeStyles.groupLabel}>{/^[a-z]/.test(componentName) ? 'attrs' : 'props'}</span>
                    <div style={scopeStyles.items}>
                      {groupedBindings.map(({ childProp, rootVars }) => (
                        <ScopeItemChip
                          key={childProp}
                          item={{ name: childProp, typeStr: rootVars.every(v => v === childProp) ? '' : `= ${rootVars.join(', ')}`, usedInNode: true }}
                          linkColor={layerColorMaps[currentLayerIdx]?.get(rootVars[0])}
                        />
                      ))}
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
