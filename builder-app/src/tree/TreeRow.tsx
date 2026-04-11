import { useEffect, useRef, useState } from 'react'
import { highlightElement, clearHighlight } from '../highlight'
import { isInChildrenPropOf } from '../fiberSource'
import type { DisplayNode } from './types'
import { firstDomElement } from './treeBuilders'

/** Recursively extracts non-DOM nodes from a children list, hoisting component/ghost/loop
 *  nodes out of any DOM wrappers so only React components explicitly passed as slot children
 *  (between open/close tags) are shown. Named-prop components (e.g. badge2={<Badge>}) are filtered out. */
function flattenToComponents(nodes: DisplayNode[], parentComponentName?: string): DisplayNode[] {
  const result: DisplayNode[] = []
  for (const node of nodes) {
    if (node.kind === 'dom') {
      result.push(...flattenToComponents(node.children, parentComponentName))
    } else {
      if (parentComponentName && node.kind === 'component') {
        const el = firstDomElement(node)
        if (el && !isInChildrenPropOf(el, parentComponentName)) continue
      }
      result.push(node)
    }
  }
  return result
}

interface RowProps {
  node: DisplayNode
  selected: Element | null
  onSelect: (node: DisplayNode) => void
  /** Element currently hovered in the preview canvas */
  hoveredElement: Element | null
  /** Set of file paths that contain more than one React component definition */
  multiCompFiles: Set<string>
  /** Set of node keys currently multi-selected */
  multiSelectedKeys: Set<string>
  /** Called when the user Ctrl/Cmd+clicks the row */
  onMultiToggle: (e: React.MouseEvent, node: DisplayNode) => void
  /** Called on right-click */
  onRowContextMenu: (e: React.MouseEvent, node: DisplayNode) => void
  /** Key of the node hovered in the ExpressionAssignPanel chip list */
  hoveredWrapKey?: string | null
  /** Incrementing counter — when it changes all rows expand */
  expandGen?: number
  /** Incrementing counter — when it changes all rows collapse */
  collapseGen?: number
  /** When true, this node and all descendants are forced open in one render pass */
  forceExpandAll?: boolean
  /** Called when the user manually toggles a row, to clear any force-expand override */
  onClearForceExpand?: () => void
  /** Keys of ancestor nodes that must be forced open to reveal a target node */
  expandedAncestors?: Set<string> | null
  /** Key of the node that should be scrolled into view */
  scrollToKey?: string | null
  /** When true, DOM nodes are hidden — only component/ghost/loop nodes are shown. */
  filterDomNodes?: boolean
}

export function TreeRow({ node, selected, onSelect, hoveredElement, multiCompFiles, multiSelectedKeys, onMultiToggle, onRowContextMenu, hoveredWrapKey, expandGen = 0, collapseGen = 0, forceExpandAll = false, onClearForceExpand, expandedAncestors, scrollToKey, filterDomNodes = false }: RowProps) {
  // Child component nodes (depth > 0) start collapsed but are expandable.
  const isChildComponent = node.kind === 'component' && node.depth > 0
  // Inside a child component subtree, hide DOM nodes — only show nested React component nodes
  // (i.e. what the page source explicitly composes, not the component's internal DOM implementation).
  const hideDOM = isChildComponent || filterDomNodes
  const [open, setOpen] = useState(!isChildComponent)
  const rowRef = useRef<HTMLDivElement>(null)

  // expandGen expands everything except child component nodes (they start collapsed).
  useEffect(() => { if (expandGen > 0 && !isChildComponent) setOpen(true) }, [expandGen])
  useEffect(() => { if (collapseGen > 0) setOpen(node.depth === 0) }, [collapseGen])
  useEffect(() => {
    if (scrollToKey === node.key && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [scrollToKey, node.key])

  const effectiveOpen = forceExpandAll || !!expandedAncestors?.has(node.key) || open
  const [ghostHovered, setGhostHovered] = useState(false)
  const nodeElement = firstDomElement(node)
  const isSelected = nodeElement !== null && nodeElement === selected
  const isMultiSelected = multiSelectedKeys.has(node.key)
  // Pre-processed children: when inside a child component subtree, strip DOM nodes.
  const visibleChildren = hideDOM ? flattenToComponents(node.children, node.kind === 'component' ? node.name : undefined) : node.children
  const hasChildren = visibleChildren.length > 0

  const isDom = node.kind === 'dom'
  const el = isDom ? node.el : null
  const classes =
    el && typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).join('.')
      : ''

  const isCanvasHovered =
    hoveredElement !== null &&
    node.kind === 'dom' &&
    node.el === hoveredElement

  const isWrapHovered = !!hoveredWrapKey && node.key === hoveredWrapKey
  const isHovered = isCanvasHovered || isWrapHovered

  const rowEl = nodeElement

  // ── Loop node (.map() call grouping) ─────────────────────────────────────
  if (node.kind === 'loop') {
    return (
      <div>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            paddingLeft: 8 + node.depth * 14,
            paddingTop: 2, paddingBottom: 2, paddingRight: 8,
            cursor: 'pointer', userSelect: 'none',
            fontFamily: 'monospace', fontSize: 12,
            background: ghostHovered ? 'rgba(166,227,161,0.06)' : 'transparent',
            borderLeft: ghostHovered ? '2px solid rgba(166,227,161,0.3)' : '2px solid transparent',
            transition: 'background 0.12s, border-left-color 0.12s',
          }}
          onMouseEnter={() => setGhostHovered(true)}
          onMouseLeave={() => setGhostHovered(false)}
          onClick={() => onSelect(node)}
          onDoubleClick={() => { onClearForceExpand?.(); setOpen(o => !o) }}
          ref={rowRef}
        >
          <span
            style={{ color: '#6c7086', fontSize: 10, width: 12, flexShrink: 0, visibility: hasChildren ? 'visible' : 'hidden' }}
            onClick={e => { e.stopPropagation(); onClearForceExpand?.(); setOpen(o => !o) }}
          >{effectiveOpen ? '▾' : '▸'}</span>
          <span style={{ color: '#a6e3a1' }}>{'{ }'}</span>
          <span style={{ color: '#a6e3a1', fontWeight: 600 }}> JSExpression</span>
          <span style={{ color: '#585b70', fontSize: 10, marginLeft: 4 }}>:{node.sourceLine}</span>
          <span style={{ color: '#585b70', fontSize: 10, marginLeft: 4 }}>×{node.count}</span>
        </div>
        {effectiveOpen && visibleChildren.map((child, i) => (
          <TreeRow key={i} node={child} selected={selected} onSelect={onSelect}
            hoveredElement={hoveredElement} multiCompFiles={multiCompFiles}
            multiSelectedKeys={multiSelectedKeys} onMultiToggle={onMultiToggle}
            onRowContextMenu={onRowContextMenu} hoveredWrapKey={hoveredWrapKey}
            expandGen={expandGen} collapseGen={collapseGen}
            forceExpandAll={forceExpandAll} onClearForceExpand={onClearForceExpand}
            expandedAncestors={expandedAncestors} scrollToKey={scrollToKey}
            filterDomNodes={hideDOM} />
        ))}
      </div>
    )
  }

  // ── Ghost (inactive expression) ── clickable, navigates to source ──────
  if (node.kind === 'ghost') {
    return (
      <div style={{ opacity: 0.6 }}>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            paddingLeft: 8 + node.depth * 14,
            paddingTop: 2, paddingBottom: 2, paddingRight: 8,
            cursor: 'pointer', userSelect: 'none',
            fontFamily: 'monospace', fontSize: 12,
            background: ghostHovered ? 'rgba(249,226,175,0.08)' : 'transparent',
            borderLeft: ghostHovered ? '2px solid rgba(249,226,175,0.4)' : '2px solid transparent',
            transition: 'background 0.12s, border-left-color 0.12s',
          }}
          onMouseEnter={() => setGhostHovered(true)}
          onMouseLeave={() => setGhostHovered(false)}
          onClick={() => onSelect(node)}
          onDoubleClick={() => { onClearForceExpand?.(); setOpen(o => !o) }}
          ref={rowRef}
        >
          <span
            style={{ color: '#6c7086', fontSize: 10, width: 12, flexShrink: 0, visibility: hasChildren ? 'visible' : 'hidden' }}
            onClick={e => { e.stopPropagation(); onClearForceExpand?.(); setOpen(o => !o) }}
          >{effectiveOpen ? '▾' : '▸'}</span>
          <span style={{ color: '#f9e2af' }}>{'<>'}</span>
          <span style={{ color: '#f9e2af', fontWeight: 600 }}>{node.displayName ?? node.name}</span>
          {Object.entries(node.exprProps).map(([k, v]) => (
            <span key={k} style={{ color: '#585b70', fontSize: 11, fontFamily: 'monospace' }}>
              {k}=<span style={{ color: '#cba6f7' }}>{v}</span>
            </span>
          ))}
          <span style={{ color: '#585b70', fontSize: 10, marginLeft: 4 }}>(inactive)</span>
          {node.file && (
            <span style={{ marginLeft: 'auto', background: '#1e1e2e', border: '1px solid #45475a', color: '#89b4fa', fontSize: 9, padding: '1px 4px', borderRadius: 3, flexShrink: 0 }}>src</span>
          )}
        </div>
        {effectiveOpen && hasChildren && visibleChildren.map((child, i) => (
          <TreeRow key={i} node={child} selected={selected} onSelect={onSelect}
            hoveredElement={hoveredElement} multiCompFiles={multiCompFiles}
            multiSelectedKeys={multiSelectedKeys} onMultiToggle={onMultiToggle}
            onRowContextMenu={onRowContextMenu} hoveredWrapKey={hoveredWrapKey}
            expandGen={expandGen} collapseGen={collapseGen}
            forceExpandAll={forceExpandAll} onClearForceExpand={onClearForceExpand}
            expandedAncestors={expandedAncestors} scrollToKey={scrollToKey}
            filterDomNodes={hideDOM} />
        ))}
      </div>
    )
  }

  return (
    <div>
      <div
        ref={rowRef}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          paddingLeft: 8 + node.depth * 14,
          paddingTop: 2,
          paddingBottom: 2,
          paddingRight: 8,
          background: isMultiSelected ? 'rgba(137,180,250,0.12)' : isSelected ? '#313244' : isHovered ? 'rgba(250,179,135,0.12)' : 'transparent',
          borderLeft: isMultiSelected ? '2px solid rgba(137,180,250,0.6)' : isSelected ? '2px solid #89b4fa' : isHovered ? '2px solid #fab387' : '2px solid transparent',
          outline: isMultiSelected ? '1px inset rgba(137,180,250,0.2)' : 'none',
          cursor: 'pointer',
          userSelect: 'none',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          fontFamily: 'monospace',
          fontSize: 12,
          transition: 'background 0.12s, border-left-color 0.12s',
        }}
        onMouseEnter={() => highlightElement(rowEl)}
        onMouseLeave={() => clearHighlight()}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            onMultiToggle(e, node)
            return
          }
          onSelect(node)
        }}
        onDoubleClick={() => { onClearForceExpand?.(); setOpen(o => !o) }}
        onContextMenu={(e) => {
          e.preventDefault()
          onRowContextMenu(e, node)
        }}
      >
        {/* expand / collapse */}
        <span
          style={{
            color: '#6c7086',
            fontSize: 10,
            width: 12,
            flexShrink: 0,
            visibility: hasChildren ? 'visible' : 'hidden',
          }}
          onClick={(e) => {
            e.stopPropagation()
            onClearForceExpand?.()
            setOpen((o) => !o)
          }}
        >
          {effectiveOpen ? '▾' : '▸'}
        </span>

        {node.kind === 'component' ? (
          <>
            <span style={{ color: '#f9e2af' }}>{'<>'}</span>
            <span style={{ color: '#f9e2af', fontWeight: 600 }} title={node.name}>
              {node.displayName ?? node.name}
            </span>
            {node.exprProps
              ? Object.entries(node.exprProps).map(([k, v]) => (
                  <span key={k} style={{ color: '#6c7086', fontSize: 11, fontFamily: 'monospace' }}>
                    {k}=<span style={{ color: '#cba6f7' }}>{v}</span>
                  </span>
                ))
              : (
                  <>
                    {multiCompFiles.has(node.file) && (
                      <span
                        title="This file defines multiple React components. Consider splitting them into separate files."
                        style={{
                          color: '#1e1e2e',
                          background: '#f9e2af',
                          fontSize: 9,
                          fontWeight: 800,
                          lineHeight: 1,
                          padding: '2px 5px',
                          borderRadius: 3,
                          flexShrink: 0,
                          letterSpacing: '0.02em',
                        }}
                      >!</span>
                    )}
                    <span style={{ color: '#6c7086', fontSize: 11 }}>(component)</span>
                  </>
                )
            }
          </>
        ) : (
          <>
            {/* tag name */}
            <span style={{ color: node.sourceInfo ? '#89b4fa' : '#cdd6f4' }}>{node.tag}</span>

            {/* id */}
            {el?.id && <span style={{ color: '#a6e3a1', fontSize: 11 }}>#{el.id}</span>}

            {/* class */}
            {classes && (
              <span
                style={{
                  color: '#6c7086',
                  fontSize: 11,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: 110,
                }}
              >
                {classes}
              </span>
            )}
          </>
        )}

        {/* source badge */}
        {(node.kind === 'component' || (node.kind === 'dom' && node.sourceInfo)) && (
          <span
            style={{
              marginLeft: 'auto',
              background: '#1e1e2e',
              border: '1px solid #45475a',
              color: '#89b4fa',
              fontSize: 9,
              padding: '1px 4px',
              borderRadius: 3,
              flexShrink: 0,
            }}
          >
            src
          </span>
        )}
      </div>

      {effectiveOpen &&
        hasChildren &&
        visibleChildren.map((child, i) => (
          <TreeRow key={i} node={child} selected={selected} onSelect={onSelect} hoveredElement={hoveredElement} multiCompFiles={multiCompFiles} multiSelectedKeys={multiSelectedKeys} onMultiToggle={onMultiToggle} onRowContextMenu={onRowContextMenu} hoveredWrapKey={hoveredWrapKey} expandGen={expandGen} collapseGen={collapseGen} forceExpandAll={forceExpandAll} onClearForceExpand={onClearForceExpand} expandedAncestors={expandedAncestors} scrollToKey={scrollToKey} filterDomNodes={hideDOM} />
        ))}
    </div>
  )
}
