import { useEffect, useMemo, useRef, useState } from 'react'
import { parse } from '@babel/parser'
import { highlightElement, clearHighlight } from '../highlight'
import { getElementSourceInfo, collectExpressionInstances, type ElementSourceInfo, type ExpressionInstance } from '../fiberSource'
import { wrapNodesWithExpression } from './expressionRewriter'

export interface ExpressionMeta {
  name: string
  file: string
  props: string[]
}

/** A tree node selected for wrapping — passed to App via onWrapIntent. */
export interface WrapIntentNode { key: string; file: string; line: number; tag: string }

function hasMultipleComponents(source: string): boolean {
  try {
    const body = (parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] }).program as any).body as any[]
    const names = new Set<string>()
    for (const node of body) {
      // function Foo() {}
      if (node.type === 'FunctionDeclaration' && /^[A-Z]/.test(node.id?.name ?? '')) names.add(node.id.name)
      // export (default) function Foo() {} / export const Foo = () => {}
      if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') {
        const d = node.declaration
        if (d?.type === 'FunctionDeclaration' && /^[A-Z]/.test(d.id?.name ?? '')) names.add(d.id.name)
        if (d?.type === 'VariableDeclaration') {
          for (const vd of d.declarations ?? []) {
            if (/^[A-Z]/.test(vd.id?.name ?? '') &&
                (vd.init?.type === 'ArrowFunctionExpression' || vd.init?.type === 'FunctionExpression')) {
              names.add(vd.id.name)
            }
          }
        }
      }
      // const Foo = () => {}
      if (node.type === 'VariableDeclaration') {
        for (const vd of node.declarations ?? []) {
          if (/^[A-Z]/.test(vd.id?.name ?? '') &&
              (vd.init?.type === 'ArrowFunctionExpression' || vd.init?.type === 'FunctionExpression')) {
            names.add(vd.id.name)
          }
        }
      }
      if (names.size > 1) return true
    }
    return names.size > 1
  } catch {
    return false
  }
}

function collectComponentFiles(nodes: DisplayNode[], out: Set<string>): void {
  for (const node of nodes) {
    if (node.kind === 'component' && node.file) out.add(node.file)
    if (node.kind === 'loop' && node.sourceFile) out.add(node.sourceFile)
    collectComponentFiles(node.children, out)
  }
}

/** Tiny "i" icon that shows a popover on hover. */
function InfoIcon({ text }: { text: string }) {
  const [show, setShow] = useState(false)
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', marginLeft: 4 }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <span style={{
        width: 14, height: 14, borderRadius: '50%', border: '1px solid #6c7086',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 9, fontWeight: 700, color: '#6c7086', cursor: 'default',
        fontFamily: 'serif', fontStyle: 'italic', lineHeight: 1, flexShrink: 0,
      }}>i</span>
      {show && (
        <div style={{
          position: 'absolute', left: '50%', top: '100%', transform: 'translateX(-50%)',
          marginTop: 6, padding: '6px 10px', background: '#1e1e2e', border: '1px solid #45475a',
          borderRadius: 6, color: '#cdd6f4', fontSize: 11, lineHeight: 1.45,
          whiteSpace: 'normal', width: 200, zIndex: 1000, pointerEvents: 'none',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)', fontFamily: 'system-ui, sans-serif',
          fontWeight: 400, textTransform: 'none', letterSpacing: 0,
        }}>{text}</div>
      )}
    </span>
  )
}

function isLikelyReactComponentName(name: string | null | undefined): boolean {
  if (!name) return false
  return /^[A-Z]/.test(name)
}

interface RawDomNode {
  kind: 'dom'
  el: Element
  tag: string
  sourceInfo: ElementSourceInfo | null
  children: RawDomNode[]
}

interface DisplayDomNode {
  kind: 'dom'
  key: string
  el: Element
  tag: string
  sourceInfo: ElementSourceInfo | null
  depth: number
  children: DisplayNode[]
}

interface DisplayComponentNode {
  kind: 'component'
  key: string
  name: string
  file: string
  line: number
  depth: number
  children: DisplayNode[]
  /** Set when this is an expression component — maps prop name → display value. */
  exprProps?: Record<string, string>
  /** JSX usage-site file (only set for expression nodes). */
  usageFile?: string | null
  /** JSX usage-site line (only set for expression nodes). */
  usageLine?: number | null
}

/** Greyed-out ghost node for an expression that renders null (inactive). */
interface DisplayGhostNode {
  kind: 'ghost'
  key: string
  name: string
  exprProps: Record<string, string>
  /** Source file of the expression component (for navigation). */
  file: string | null
  /** Source line of the expression JSX usage. */
  line: number | null
  depth: number
  children: DisplayNode[]
}

/** Synthetic node grouping repeated component/ghost/dom siblings from the same JS expression. */
interface DisplayLoopNode {
  kind: 'loop'
  key: string
  depth: number
  /** Source line of the expression (for display) */
  sourceLine: number
  sourceFile: string | null
  count: number
  children: DisplayNode[]
}

type DisplayNode = DisplayDomNode | DisplayComponentNode | DisplayGhostNode | DisplayLoopNode

function buildRawDomTree(root: Element): RawDomNode {
  const sourceInfo = getElementSourceInfo(root)
  const children: RawDomNode[] = []
  for (const child of Array.from(root.children)) {
    children.push(buildRawDomTree(child))
  }
  return {
    kind: 'dom',
    el: root,
    tag: root.tagName.toLowerCase(),
    sourceInfo,
    children,
  }
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

function collectSourceInfos(node: RawDomNode, out: ElementSourceInfo[]): void {
  if (node.sourceInfo) out.push(node.sourceInfo)
  for (const child of node.children) collectSourceInfos(child, out)
}

function inferPageRoot(
  rawRoots: RawDomNode[],
  preferredRootComponentName?: string
): { name: string; file: string; line: number } | null {
  const all: ElementSourceInfo[] = []
  for (const root of rawRoots) collectSourceInfos(root, all)

  // If caller provides a preferred root name (e.g. LoginPage, Button), use it first.
  if (preferredRootComponentName && isLikelyReactComponentName(preferredRootComponentName)) {
    // Best case: exact owner match from /pages/ or /components/ file.
    for (const info of all) {
      const f = normalizeSlashes(info.file)
      if (
        info.ownerComponentName === preferredRootComponentName &&
        (f.includes('/pages/') || f.includes('/components/'))
      ) {
        return {
          name: preferredRootComponentName,
          file: info.file,
          line: info.ownerLine ?? info.line,
        }
      }
    }

    // Fallback: no exact owner metadata — pick any anchor from pages or components.
    const srcInfo = all.find((info) => {
      const f = normalizeSlashes(info.file)
      return f.includes('/pages/') || f.includes('/components/')
    })
    if (srcInfo) {
      return {
        name: preferredRootComponentName,
        file: srcInfo.file,
        line: srcInfo.line,
      }
    }

    // Last fallback: use first available source info.
    const first = all[0]
    if (first) {
      return {
        name: preferredRootComponentName,
        file: first.file,
        line: first.line,
      }
    }

    // Still no source info? return synthetic root with safe defaults.
    return {
      name: preferredRootComponentName,
      file: '',
      line: 1,
    }
  }

  // Prefer owners from files in /pages/ or /components/.
  for (const info of all) {
    const f = normalizeSlashes(info.file)
    if (
      isLikelyReactComponentName(info.ownerComponentName) &&
      (f.includes('/pages/') || f.includes('/components/'))
    ) {
      return {
        name: info.ownerComponentName as string,
        file: info.file,
        line: info.ownerLine ?? info.line,
      }
    }
  }

  // Fallback: first valid owner we see.
  for (const info of all) {
    if (isLikelyReactComponentName(info.ownerComponentName)) {
      return {
        name: info.ownerComponentName as string,
        file: info.file,
        line: info.ownerLine ?? info.line,
      }
    }
  }

  return null
}

function toMixedTree(
  node: RawDomNode,
  depth: number,
  parentOwnerName: string | null,
  keyPrefix: string
): DisplayNode {
  const ownerName = isLikelyReactComponentName(node.sourceInfo?.ownerComponentName)
    ? node.sourceInfo?.ownerComponentName ?? null
    : null

  const effectiveOwnerName = ownerName
  const currentOwnerName = effectiveOwnerName ?? parentOwnerName

  const domNode: DisplayDomNode = {
    kind: 'dom',
    key: `${keyPrefix}-dom`,
    el: node.el,
    tag: node.tag,
    sourceInfo: node.sourceInfo,
    depth,
    children: node.children.map((child, i) =>
      toMixedTree(child, depth + 1, currentOwnerName, `${keyPrefix}-${i}`)
    ),
  }

  // If ownership changes at this node, insert a synthetic component node
  // above the DOM node so the UI shows React + DOM hierarchy.
  // Use the element's own file (node.sourceInfo.file) — this IS the component's
  // definition file. ownerFile points to where the component is *used* (e.g.
  // ComponentLoader), which is wrong for navigation.
  if (effectiveOwnerName && effectiveOwnerName !== parentOwnerName) {
    return {
      kind: 'component',
      key: `${keyPrefix}-comp-${effectiveOwnerName}`,
      name: effectiveOwnerName,
      file: node.sourceInfo?.file ?? '',
      line: node.sourceInfo?.line ?? 1,
      depth,
      children: [domNode],
    }
  }

  return domNode
}

function buildMixedTree(root: Element, preferredRootComponentName?: string): DisplayNode[] {
  const rawRoots: RawDomNode[] = []
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i]
    rawRoots.push(buildRawDomTree(child))
  }

  const pageRoot = inferPageRoot(rawRoots, preferredRootComponentName)

  const out: DisplayNode[] = rawRoots.map((raw, i) =>
    toMixedTree(raw, pageRoot ? 1 : 0, pageRoot?.name ?? null, `root-${i}`)
  )

  if (pageRoot) {
    return [
      {
        kind: 'component',
        key: `page-root-${pageRoot.name}`,
        name: pageRoot.name,
        file: pageRoot.file,
        line: pageRoot.line,
        depth: 0,
        children: out,
      },
    ]
  }

  return out
}

function firstDomElement(node: DisplayNode): Element | null {
  if (node.kind === 'dom') return node.el
  for (const child of node.children) {
    const el = firstDomElement(child)
    if (el) return el
  }
  return null
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
}

function TreeRow({ node, selected, onSelect, hoveredElement, multiCompFiles, multiSelectedKeys, onMultiToggle, onRowContextMenu, hoveredWrapKey }: RowProps) {
  // Root component (depth 0) and all DOM nodes start open;
  // child component nodes (depth > 0) start collapsed.
  const [open, setOpen] = useState(node.kind !== 'component' || node.depth === 0)
  const [ghostHovered, setGhostHovered] = useState(false)
  const nodeElement = firstDomElement(node)
  const isSelected = nodeElement !== null && nodeElement === selected
  const isMultiSelected = multiSelectedKeys.has(node.key)
  const hasChildren = node.children.length > 0

  const isDom = node.kind === 'dom'
  const el = isDom ? node.el : null
  const classes =
    el && typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).join('.')
      : ''

  // This row is highlighted when canvas mouse hovers its element.
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
          onDoubleClick={() => setOpen(o => !o)}
        >
          <span
            style={{ color: '#6c7086', fontSize: 10, width: 12, flexShrink: 0, visibility: hasChildren ? 'visible' : 'hidden' }}
            onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
          >{open ? '▾' : '▸'}</span>
          <span style={{ color: '#a6e3a1' }}>{'{ }'}</span>
          <span style={{ color: '#a6e3a1', fontWeight: 600 }}> JSExpression</span>
          <span style={{ color: '#585b70', fontSize: 10, marginLeft: 4 }}>:{node.sourceLine}</span>
          <span style={{ color: '#585b70', fontSize: 10, marginLeft: 4 }}>×{node.count}</span>
        </div>
        {open && node.children.map((child, i) => (
          <TreeRow key={i} node={child} selected={selected} onSelect={onSelect}
            hoveredElement={hoveredElement} multiCompFiles={multiCompFiles}
            multiSelectedKeys={multiSelectedKeys} onMultiToggle={onMultiToggle}
            onRowContextMenu={onRowContextMenu} hoveredWrapKey={hoveredWrapKey} />
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
          onDoubleClick={() => setOpen(o => !o)}
        >
          <span
            style={{ color: '#6c7086', fontSize: 10, width: 12, flexShrink: 0, visibility: hasChildren ? 'visible' : 'hidden' }}
            onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
          >{open ? '▾' : '▸'}</span>
          <span style={{ color: '#f9e2af' }}>{'<>'}</span>
          <span style={{ color: '#f9e2af', fontWeight: 600 }}>{node.name}</span>
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
        {open && hasChildren && node.children.map((child, i) => (
          <TreeRow key={i} node={child} selected={selected} onSelect={onSelect}
            hoveredElement={hoveredElement} multiCompFiles={multiCompFiles}
            multiSelectedKeys={multiSelectedKeys} onMultiToggle={onMultiToggle}
            onRowContextMenu={onRowContextMenu} hoveredWrapKey={hoveredWrapKey} />
        ))}
      </div>
    )
  }

  return (
    <div>
      <div
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
        onDoubleClick={() => setOpen(o => !o)}
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
            setOpen((o) => !o)
          }}
        >
          {open ? '▾' : '▸'}
        </span>

        {node.kind === 'component' ? (
          <>
            <span style={{ color: '#f9e2af' }}>{'<>'}</span>
            <span style={{ color: '#f9e2af', fontWeight: 600 }} title={node.name}>
              {node.name}
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

      {open &&
        hasChildren &&
        node.children.map((child, i) => (
          <TreeRow key={i} node={child} selected={selected} onSelect={onSelect} hoveredElement={hoveredElement} multiCompFiles={multiCompFiles} multiSelectedKeys={multiSelectedKeys} onMultiToggle={onMultiToggle} onRowContextMenu={onRowContextMenu} hoveredWrapKey={hoveredWrapKey} />
        ))}
    </div>
  )
}

function countNodes(nodes: DisplayNode[]): number {
  function countOne(node: DisplayNode): number {
    return 1 + node.children.reduce((s, c) => s + countOne(c), 0)
  }
  return nodes.reduce((sum, n) => sum + countOne(n), 0)
}

// ---- component ----

// Serialisable snapshot of the selected node — passed up to Inspector after selection.
export interface SelectedNodeSnapshot {
  tag: string
  locatorId: string | null
  locatorFile: string | null
  locatorLine: number | null
  ownerComponentName: string | null
  domAttributes: Array<{ name: string; value: string }>
}

interface PageEntry {
  id: string
  label: string
  root: string
}

interface ComponentEntry {
  id: string
  label: string
  name: string
}

interface DOMTreePanelProps {
  canvasRef: React.RefObject<HTMLDivElement | null>
  onLocate: (
    file: string,
    line: number,
    inspectMode?: 'node' | 'component' | 'file' | 'expression',
    componentName?: string
  ) => void
  /** Called after a DOM node is selected in the tree. Does NOT change locate/navigation behaviour. */
  onNodeSelect?: (snapshot: SelectedNodeSnapshot | null) => void
  preferredRootComponentName?: string
  /** Controls which section is shown in the panel. */
  activeSection?: 'pages' | 'components' | 'expressions'
  /** Optional list of pages to display at the top of the panel. */
  pages?: PageEntry[]
  activePage?: string
  onPageChange?: (id: string) => void
  onAddPage?: () => void
  onDeletePage?: (id: string, root: string) => void
  /** Optional list of components to display in the panel. */
  components?: ComponentEntry[]
  activeComponent?: string
  onComponentClick?: (id: string, name: string) => void
  onAddComponent?: () => void
  onDeleteComponent?: (id: string, name: string) => void
  /** Optional list of expression files */
  expressions?: ExpressionMeta[]
  activeExpression?: string
  onExpressionSelect?: (expr: ExpressionMeta) => void
  onAddExpression?: () => void
  onDeleteExpression?: (name: string) => void
  /** Called when the user selects nodes to wrap with an expression. Handed off to App to render the assignment panel. */
  onWrapIntent?: (nodes: WrapIntentNode[]) => void
  /** Called when the user clicks an existing expression node (active or inactive) in the tree. */
  onExpressionNodeClick?: (nodes: WrapIntentNode[], exprName: string) => void
  /** When set, highlights the tree row (and DOM element in preview) for that node key. */
  hoveredWrapNodeKey?: string | null
  /** Called whenever the user drags the panel resize handle. */
  onWidthChange?: (width: number) => void
}

// ── Helpers for source-location extraction ──────────────────────────────────

function getNodeFile(node: DisplayNode): string | null {
  if (node.kind === 'component') return node.file || null
  if (node.kind === 'loop') return node.sourceFile
  if (node.kind === 'ghost') return node.file
  return node.sourceInfo?.file ?? null
}

function getNodeLine(node: DisplayNode): number | null {
  if (node.kind === 'component') return node.line
  if (node.kind === 'loop') return node.sourceLine || null
  if (node.kind === 'ghost') return node.line
  return node.sourceInfo?.line ?? null
}

/** Recursively increment depth of a node and all its descendants (used when wrapping in a loop node). */
function bumpDepth(node: DisplayNode): DisplayNode {
  return { ...node, depth: node.depth + 1, children: node.children.map(bumpDepth) } as DisplayNode
}

/** Returns a stable key for grouping siblings that originate from the same source line. */
function nodeSourceKey(node: DisplayNode): string | null {
  if (node.kind === 'component' && node.usageFile && node.usageLine != null) {
    return `${node.usageFile}:${node.usageLine}`
  }
  if (node.kind === 'ghost' && node.file && node.line != null) {
    return `${node.file}:${node.line}`
  }
  if (node.kind === 'dom' && node.sourceInfo) {
    return `${node.sourceInfo.file}:${node.sourceInfo.line}`
  }
  return null
}

/**
 * Group consecutive siblings that share the same source location (file:line)
 * under a synthetic DisplayLoopNode. Only groups runs of 2+.
 */
function groupSiblingLoops(
  children: DisplayNode[],
  _fileSources: Map<string, string>,
): DisplayNode[] {
  if (children.length < 2) return children
  const result: DisplayNode[] = []
  let i = 0
  while (i < children.length) {
    const key = nodeSourceKey(children[i])
    if (!key) { result.push(children[i]); i++; continue }
    let j = i + 1
    while (j < children.length && nodeSourceKey(children[j]) === key) j++
    if (j - i < 2) { result.push(children[i]); i++; continue }
    const sepIdx = key.lastIndexOf(':')
    const file = key.slice(0, sepIdx)
    const line = parseInt(key.slice(sepIdx + 1), 10)
    const groupDepth = children[i].depth
    result.push({
      kind: 'loop',
      key: `loop-${i}-${file.slice(-20)}-${line}`,
      depth: groupDepth,
      sourceLine: line,
      sourceFile: file || null,
      count: j - i,
      children: children.slice(i, j).map(bumpDepth),
    })
    i = j
  }
  return result
}

function computeRelativeImportPath(fromFile: string, toFile: string): string {
  const from = fromFile.replace(/\\/g, '/').split('/')
  const to = toFile.replace(/\\/g, '/').split('/')
  const toBase = to[to.length - 1].replace(/\.tsx?$/, '')
  const fromDir = from.slice(0, -1)
  const toDir = to.slice(0, -1)
  let common = 0
  const n = Math.min(fromDir.length, toDir.length)
  for (let i = 0; i < n; i++) {
    if (fromDir[i].toLowerCase() === toDir[i].toLowerCase()) common++
    else break
  }
  const ups = fromDir.length - common
  const downs = toDir.slice(common)
  const rel = [...Array(ups).fill('..'), ...downs, toBase].join('/')
  return rel.startsWith('.') ? rel : './' + rel
}

// ─────────────────────────────────────────────────────────────────────────────

function findNodeByKey(nodes: DisplayNode[], key: string): DisplayNode | null {
  for (const node of nodes) {
    if (node.key === key) return node
    const found = findNodeByKey(node.children, key)
    if (found) return found
  }
  return null
}

// ── Expression instance helpers ────────────────────────────────────

function propsToStrings(props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(props)) {
    if (k === 'children') continue
    if (v == null) out[k] = String(v)
    else if (typeof v === 'boolean' || typeof v === 'number') out[k] = String(v)
    else if (typeof v === 'string') out[k] = `"${v}"`
    else if (typeof v === 'function') out[k] = 'fn()'
    else if (typeof v === 'object' && '$$typeof' in (v as object)) {
      const t = (v as any).type
      out[k] = `<${typeof t === 'string' ? t : (t?.name ?? '?')}>`
    }
    else out[k] = '{\u2026}'
  }
  return out
}

function buildGhostChildren(children: unknown, depth: number): DisplayNode[] {
  if (!children) return []
  const arr: unknown[] = Array.isArray(children) ? children : [children]
  const result: DisplayNode[] = []
  arr.forEach((child, i) => {
    if (!child || typeof child !== 'object') return
    const el = child as any
    if (!el.type) return
    const tag = typeof el.type === 'string' ? el.type : (el.type.displayName || el.type.name || '?')
    result.push({
      kind: 'ghost',
      key: `ghost-child-${tag}-${i}-${depth}`,
      name: tag,
      exprProps: {},
      file: null,
      line: null,
      depth,
      children: buildGhostChildren(el.props?.children, depth + 1),
    })
  })
  return result
}

function mergeExpressionData(
  nodes: DisplayNode[],
  instances: ExpressionInstance[],
  fileSources: Map<string, string>,
): DisplayNode[] {
  const activeCounters: Record<string, number> = {}
  const activeByName: Record<string, ExpressionInstance[]> = {}
  const inactiveByParent = new Map<Element, ExpressionInstance[]>()
  for (const inst of instances) {
    if (inst.active) {
      ;(activeByName[inst.name] ??= []).push(inst)
    } else if (inst.parentDomEl) {
      let arr = inactiveByParent.get(inst.parentDomEl)
      if (!arr) { arr = []; inactiveByParent.set(inst.parentDomEl, arr) }
      arr.push(inst)
    }
  }

  function process(nodes: DisplayNode[]): DisplayNode[] {
    const mapped = nodes.map(node => {
      if (node.kind === 'component') {
        const idx = activeCounters[node.name] ?? 0
        activeCounters[node.name] = idx + 1
        const inst = activeByName[node.name]?.[idx]
        return {
          ...node,
          exprProps: inst ? propsToStrings(inst.props) : {},
          usageFile: inst?.source?.fileName ?? null,
          usageLine: inst?.source?.lineNumber ?? null,
          children: groupSiblingLoops(process(node.children), fileSources),
        }
      }
      if (node.kind === 'dom') {
        const inactiveHere = inactiveByParent.get(node.el)
        if (!inactiveHere || inactiveHere.length === 0) {
          return { ...node, children: groupSiblingLoops(process(node.children), fileSources) }
        }

        const ghosts: Array<{ ghost: DisplayGhostNode; nextEl: Element | null }> =
          inactiveHere.map((inst, i) => ({
            ghost: {
              kind: 'ghost',
              key: `ghost-${inst.name}-${inst.source?.lineNumber ?? i}-${node.key}`,
              name: inst.name,
              exprProps: propsToStrings(inst.props),
              file: inst.source?.fileName ?? null,
              line: inst.source?.lineNumber ?? null,
              depth: node.depth + 1,
              children: buildGhostChildren(inst.props.children, node.depth + 2),
            } satisfies DisplayGhostNode,
            nextEl: inst.nextDomSiblingEl,
          }))

        const processedChildren = process(node.children)
        const result: DisplayNode[] = []
        for (const child of processedChildren) {
          const childFirstEl = firstDomElement(child)
          for (const { ghost, nextEl } of ghosts) {
            if (nextEl !== null && nextEl === childFirstEl) result.push(ghost)
          }
          result.push(child)
        }
        // Append ghosts whose next sibling wasn’t found (they go at the end).
        for (const { ghost, nextEl } of ghosts) {
          if (nextEl === null) result.push(ghost)
        }
        return { ...node, children: groupSiblingLoops(result, fileSources) }
      }
      return { ...node, children: groupSiblingLoops(process(node.children as DisplayNode[]), fileSources) }
    })
    return groupSiblingLoops(mapped, fileSources)
  }

  return process(nodes)
}

export function DOMTreePanel({
  canvasRef,
  onLocate,
  onNodeSelect,
  preferredRootComponentName,
  activeSection,
  pages,
  activePage,
  onPageChange,
  onAddPage,
  onDeletePage,
  components,
  activeComponent,
  onComponentClick,
  onAddComponent,
  onDeleteComponent,
  expressions,
  activeExpression,
  onExpressionSelect,
  onAddExpression,
  onDeleteExpression,
  onWrapIntent,
  onExpressionNodeClick,
  hoveredWrapNodeKey,
}: DOMTreePanelProps) {
  const [tree, setTree] = useState<DisplayNode[]>([])
  const [selected, setSelected] = useState<Element | null>(null)
  const [hoveredCanvasElement, setHoveredCanvasElement] = useState<Element | null>(null)
  const rafRef = useRef<number>(0)
  const fileMultiCacheRef = useRef<Map<string, boolean>>(new Map())
  const fileSourcesRef = useRef<Map<string, string>>(new Map())
  const [fileSourcesVersion, setFileSourcesVersion] = useState(0)
  const [multiCompFiles, setMultiCompFiles] = useState<Set<string>>(new Set())

  // ── Multi-select state ───────────────────────────────────────────────────
  interface MultiItem { key: string; file: string; line: number; tag: string }
  const [multiSelected, setMultiSelected] = useState<MultiItem[]>([])
  const multiSelectedKeys = useMemo(() => new Set(multiSelected.map(s => s.key)), [multiSelected])
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [applyExprState, setApplyExprState] = useState<{
    expr: ExpressionMeta | null
    propValues: Record<string, string>
    nodeAssignments: Record<string, number>  // prop name → index in multiSelected
    openNodePickerProp: string | null
    applying: boolean
    error: string | null
  } | null>(null)

  // ── Expression section state ─────────────────────────────────────────────
  const [expressionsOpen, setExpressionsOpen] = useState(true)
  const [confirmDeleteExprName, setConfirmDeleteExprName] = useState<string | null>(null)
  const [hoveredExprName, setHoveredExprName] = useState<string | null>(null)
  const [exprInstances, setExprInstances] = useState<ExpressionInstance[]>([])
  const exprNamesRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    exprNamesRef.current = new Set((expressions ?? []).map(e => e.name))
  }, [expressions])

  // Highlight the DOM element for a hovered wrap-node chip.
  // Only runs when the prop is explicitly passed (wrap mode). When it's
  // undefined (normal mode) we do nothing — TreeRow manages highlight via
  // onMouseEnter/onMouseLeave and we must not interfere.
  useEffect(() => {
    if (hoveredWrapNodeKey === undefined) return
    if (!hoveredWrapNodeKey) { clearHighlight(); return }
    const node = findNodeByKey(tree, hoveredWrapNodeKey)
    if (node) highlightElement(firstDomElement(node))
    else clearHighlight()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredWrapNodeKey])

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenuPos) return
    function onDown() { setContextMenuPos(null) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [contextMenuPos])

  // ── Handlers ─────────────────────────────────────────────────────────────

  function nodeTag(node: DisplayNode): string {
    if (node.kind === 'ghost') return node.name
    return node.kind === 'component' ? node.name : node.tag
  }

  function handleMultiToggle(_e: React.MouseEvent, node: DisplayNode) {
    if (node.kind === 'ghost' || node.kind === 'loop') return
    const file = getNodeFile(node)
    const line = getNodeLine(node)
    if (!file || line == null) return
    const tag = nodeTag(node)
    setMultiSelected(prev => {
      const idx = prev.findIndex(s => s.key === node.key)
      if (idx !== -1) return prev.filter((_, i) => i !== idx)
      // Different file → restart selection
      if (prev.length > 0 && prev[0].file.toLowerCase() !== file.toLowerCase()) {
        return [{ key: node.key, file, line, tag }]
      }
      return [...prev, { key: node.key, file, line, tag }]
    })
  }

  function handleRowContextMenu(e: React.MouseEvent, node: DisplayNode) {
    e.preventDefault()
    const file = getNodeFile(node)
    const line = getNodeLine(node)
    // Auto-add clicked node to empty selection
    if (file && line != null && multiSelected.length === 0) {
      setMultiSelected([{ key: node.key, file, line, tag: nodeTag(node) }])
    }
    setContextMenuPos({ x: e.clientX, y: e.clientY })
  }

  const treeWithGhosts = useMemo(() => {
    if (!exprInstances.length) return tree
    return mergeExpressionData(tree, exprInstances, fileSourcesRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, exprInstances, fileSourcesVersion])

  async function applyWrapping() {
    if (!applyExprState?.expr || multiSelected.length === 0) return
    const { expr, propValues, nodeAssignments } = applyExprState
    const file = multiSelected[0].file
    const lines = multiSelected.map(s => s.line)

    // Build nodePropLines: prop name → line numbers of nodes assigned to that prop
    const nodePropLines: Record<string, number[]> = {}
    for (const [prop, idx] of Object.entries(nodeAssignments)) {
      if (idx >= 0 && idx < multiSelected.length) {
        nodePropLines[prop] = [multiSelected[idx].line]
      }
    }

    setApplyExprState(prev => prev ? { ...prev, applying: true, error: null } : null)
    try {
      const srcRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
      if (!srcRes.ok) throw new Error('Could not read source file')
      const source = await srcRes.text()

      const importPath = computeRelativeImportPath(file, expr.file)
      const newSource = wrapNodesWithExpression(source, lines, expr.name, propValues, importPath, nodePropLines)
      if (!newSource) throw new Error('Could not wrap nodes — make sure they are sibling JSX elements.')

      const saveRes = await fetch('/__source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, content: newSource }),
      })
      if (!saveRes.ok) throw new Error('Could not save file')

      setMultiSelected([])
      setApplyExprState(null)
    } catch (err: unknown) {
      setApplyExprState(prev =>
        prev ? { ...prev, applying: false, error: err instanceof Error ? err.message : 'Unknown error' } : null
      )
    }
  }

  // Track which element the mouse is over in the preview canvas so the
  // corresponding tree row can glow amber (canvas hover → tree highlight).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    function onMouseMove(e: MouseEvent) {
      const el = e.target as Element | null
      if (el && canvas!.contains(el) && el !== canvas) {
        setHoveredCanvasElement(el)
      } else {
        setHoveredCanvasElement(null)
      }
    }

    function onMouseLeave() { setHoveredCanvasElement(null) }

    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseleave', onMouseLeave)
    return () => {
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [canvasRef])

  // Poll via rAF — cheap, catches every HMR re-render without MutationObserver setup.
  useEffect(() => {
    let lastHTML = ''
    function tick() {
      const root = canvasRef.current
      if (root && root.children.length > 0) {
        const html = root.innerHTML
        if (html !== lastHTML) {
          lastHTML = html
          const newTree = buildMixedTree(root, preferredRootComponentName)
          setTree(newTree)
          const newInstances = collectExpressionInstances(root)
          setExprInstances(newInstances)
          // Check component files for multiple-component declarations and collect sources.
          const allFiles = new Set<string>()
          collectComponentFiles(newTree, allFiles)
          for (const inst of newInstances) {
            if (inst.source?.fileName) allFiles.add(inst.source.fileName)
          }
          for (const f of allFiles) {
            if (fileMultiCacheRef.current.has(f)) continue
            fileMultiCacheRef.current.set(f, false) // mark as in-flight
            fetch(`/__source?file=${encodeURIComponent(f)}`)
              .then(r => r.ok ? r.text() : '')
              .then(text => {
                const isMulti = hasMultipleComponents(text)
                fileMultiCacheRef.current.set(f, isMulti)
                if (isMulti) setMultiCompFiles(prev => new Set([...prev, f]))
                fileSourcesRef.current.set(f, text)
                setFileSourcesVersion(v => v + 1)
              })
              .catch(() => {})
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [canvasRef, preferredRootComponentName])

  function handleSelect(node: DisplayNode) {
    if (node.kind === 'loop') {
      if (node.sourceFile) onLocate(node.sourceFile, node.sourceLine, 'expression')
      return
    }
    if (node.kind === 'ghost') {
      onExpressionNodeClick?.(
        [{ key: node.key, file: node.file ?? '', line: node.line ?? 1, tag: node.name }],
        node.name,
      )
      return
    }
    if (node.kind === 'component') {
      // If this is an expression component node (has exprProps), open binding view.
      if (node.exprProps !== undefined) {
        onExpressionNodeClick?.(
          [{ key: node.key, file: node.usageFile ?? node.file, line: node.usageLine ?? node.line, tag: node.name }],
          node.name,
        )
        return
      }
      if (node.file) {
        onLocate(node.file, node.line, 'file', node.name)
      }
      const el = firstDomElement(node)
      if (el) {
        setSelected(el)
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
      onNodeSelect?.({
        tag: node.name,
        locatorId: null,
        locatorFile: node.file,
        locatorLine: node.line,
        ownerComponentName: node.name,
        domAttributes: [],
      })
      return
    }

    setSelected(node.el)
    // Use fiber source info to navigate to source
    const info = node.sourceInfo
    if (info) {
      onLocate(info.file, info.line, 'node')
    }
    node.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })

    if (onNodeSelect) {
      const domAttrs: Array<{ name: string; value: string }> = []
      for (const attr of Array.from(node.el.attributes)) {
        domAttrs.push({ name: attr.name, value: attr.value })
      }
      onNodeSelect({
        tag: node.tag,
        locatorId: null,
        locatorFile: info?.file ?? null,
        locatorLine: info?.line ?? null,
        ownerComponentName: info?.ownerComponentName ?? null,
        domAttributes: domAttrs,
      })
    }
  }

  const total = countNodes(tree)
  const [pagesOpen, setPagesOpen] = useState(true)
  const [pageSearch, setPageSearch] = useState('')
  const [treeOpen, setTreeOpen] = useState(true)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [hoveredPageId, setHoveredPageId] = useState<string | null>(null)
  const [componentsOpen, setComponentsOpen] = useState(true)
  const [componentSearch, setComponentSearch] = useState('')
  const [confirmDeleteCompId, setConfirmDeleteCompId] = useState<string | null>(null)
  const [hoveredCompId, setHoveredCompId] = useState<string | null>(null)

  // Panel resize
  const [panelWidth, setPanelWidth] = useState(280)
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = panelWidth
    const onMove = (ev: PointerEvent) => setPanelWidth(Math.max(180, Math.min(600, startWidth + ev.clientX - startX)))
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Selection status bar
  const selectionFile = multiSelected[0]?.file ?? null
  const selectionFileName = selectionFile ? selectionFile.replace(/\\/g, '/').split('/').pop() ?? '' : ''

  const filteredPages = pages
    ? pages.filter(
        (p) =>
          p.root.toLowerCase().includes(pageSearch.toLowerCase()) ||
          p.label.toLowerCase().includes(pageSearch.toLowerCase())
      )
    : []

  const filteredComponents = components
    ? components.filter(
        (c) =>
          c.name.toLowerCase().includes(componentSearch.toLowerCase()) ||
          c.label.toLowerCase().includes(componentSearch.toLowerCase())
      )
    : []

  return (
    <div style={{ ...styles.panel, width: panelWidth, position: 'relative' }} onClick={() => setContextMenuPos(null)}>
      {/* Right-edge resize handle */}
      <div
        onPointerDown={startResize}
        style={{
          position: 'absolute', right: 0, top: 0, bottom: 0, width: 5,
          cursor: 'col-resize', zIndex: 10, background: 'transparent',
        }}
        title="Drag to resize panel"
      />
      {activeSection === 'pages' && pages && pages.length > 0 && (
        <>
          <div
            style={{ ...styles.sectionHeader, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={() => setPagesOpen(o => !o)}
          >
            <span style={{ fontSize: 9, color: '#6c7086', transition: 'transform 0.15s', display: 'inline-block', transform: pagesOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
            Pages
            <InfoIcon text="Your app's page-level components. Click a page to preview it in the canvas. Use '+ Add page' to scaffold a new one." />
            <span style={{ color: '#6c7086', fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: 'auto' }}>{pages.length}</span>
          </div>
          {pagesOpen && (
            <div style={styles.pagesSection}>
              <div style={styles.pageSearch}>
                <div style={styles.pageSearchBox}>
                  <span style={styles.pageSearchIcon}>⌕</span>
                  <input
                    style={styles.pageSearchInput}
                    placeholder="Filter pages…"
                    value={pageSearch}
                    onChange={(e) => setPageSearch(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  {pageSearch && (
                    <span
                      style={{ ...styles.pageSearchIcon, cursor: 'pointer', marginLeft: 0 }}
                      onClick={() => setPageSearch('')}
                    >×</span>
                  )}
                </div>
              </div>
              <div style={styles.pagesScroll}>
                {filteredPages.length === 0 ? (
                  <div style={{ color: '#6c7086', fontSize: 11, padding: '0.4rem 0.75rem', fontFamily: 'system-ui, sans-serif' }}>No pages match</div>
                ) : filteredPages.map((p) => {
                  const isActive = activePage === p.id
                  const isHovered = hoveredPageId === p.id
                  const isConfirming = confirmDeleteId === p.id
                  return (
                    <div
                      key={p.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        paddingLeft: 8,
                        paddingTop: 3,
                        paddingBottom: 3,
                        paddingRight: 6,
                        background: isActive ? '#313244' : isHovered ? 'rgba(250,179,135,0.12)' : 'transparent',
                        borderLeft: isActive ? '2px solid #89b4fa' : isHovered ? '2px solid #fab387' : '2px solid transparent',
                        cursor: 'pointer',
                        userSelect: 'none',
                        whiteSpace: 'nowrap',
                        fontFamily: 'monospace',
                        fontSize: 12,
                        transition: 'background 0.12s, border-left-color 0.12s',
                      }}
                      onMouseEnter={() => setHoveredPageId(p.id)}
                      onMouseLeave={() => { setHoveredPageId(null); if (confirmDeleteId === p.id) setConfirmDeleteId(null) }}
                      onClick={() => { if (!isConfirming) onPageChange?.(p.id) }}
                    >
                      <span style={{ color: '#6c7086', fontSize: 10, width: 12, flexShrink: 0 }}>▸</span>
                      <span style={{ color: '#f9e2af' }}>{'<>'}</span>
                      <span style={{ color: isActive ? '#f9e2af' : '#cdd6f4', fontWeight: isActive ? 600 : 400, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {p.root}
                      </span>
                      <span style={{ color: '#6c7086', fontSize: 11, marginLeft: 2 }}>(page)</span>

                      {/* Fixed-width right slot — trash or confirm, always reserves space */}
                      <span style={{ marginLeft: 4, flexShrink: 0, display: 'flex', alignItems: 'center', minWidth: 20 }}>
                        {isConfirming ? (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                            <span style={{ color: '#f38ba8', fontSize: 10, fontFamily: 'system-ui', whiteSpace: 'nowrap' }}>Delete?</span>
                            <span
                              title="Confirm delete"
                              style={{ fontSize: 10, color: '#f38ba8', cursor: 'pointer', fontFamily: 'system-ui', fontWeight: 700, padding: '1px 4px', borderRadius: 3, border: '1px solid #f38ba8', lineHeight: 1.4 }}
                              onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); onDeletePage?.(p.id, p.root) }}
                            >Yes</span>
                            <span
                              title="Cancel"
                              style={{ fontSize: 10, color: '#6c7086', cursor: 'pointer', fontFamily: 'system-ui', padding: '1px 4px', borderRadius: 3, border: '1px solid #45475a', lineHeight: 1.4 }}
                              onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null) }}
                            >No</span>
                          </span>
                        ) : (
                          <span
                            title="Delete page"
                            style={{ fontSize: 14, color: '#6c7086', cursor: 'pointer', lineHeight: 1, padding: '1px 3px', borderRadius: 3, transition: 'color 0.1s, opacity 0.1s', visibility: isHovered ? 'visible' : 'hidden', opacity: isHovered ? 1 : 0 }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLSpanElement).style.color = '#f38ba8' }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLSpanElement).style.color = '#6c7086' }}
                            onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(p.id) }}
                          >🗑</span>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
              <div style={styles.addPageOuter}>
                <div
                  style={styles.addPageBtn}
                  onClick={() => onAddPage?.()}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(166,227,161,0.08)'; (e.currentTarget as HTMLDivElement).style.borderColor = '#a6e3a1' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; (e.currentTarget as HTMLDivElement).style.borderColor = '#45475a' }}
                >
                  <span style={{ fontSize: 14, lineHeight: 1, color: '#a6e3a1' }}>+</span>
                  <span>Add page</span>
                </div>
              </div>
            </div>
          )}
          <div style={styles.pageSectionDivider} />
        </>
      )}

      {/* ── Expressions section ── */}
      {activeSection === 'expressions' && expressions !== undefined && (
        <>
          <div
            style={{ ...styles.sectionHeader, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={() => setExpressionsOpen(o => !o)}
          >
            <span style={{ fontSize: 9, color: '#6c7086', transition: 'transform 0.15s', display: 'inline-block', transform: expressionsOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
            Expressions
            <InfoIcon text="Logical wrapper components (if/else/loop). Select tree nodes + right-click to apply. Create custom ones with '+ Add expression'." />
            <span style={{ color: '#6c7086', fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: 'auto' }}>{expressions.length}</span>
          </div>
          {expressionsOpen && (
            <div style={styles.pagesSection}>
              <div style={styles.pagesScroll}>
                {expressions.length === 0 ? (
                  <div style={{ color: '#6c7086', fontSize: 11, padding: '0.4rem 0.75rem', fontFamily: 'system-ui, sans-serif' }}>No expressions yet</div>
                ) : expressions.map((expr) => {
                  const isHovered = hoveredExprName === expr.name
                  const isConfirming = confirmDeleteExprName === expr.name
                  return (
                    <div
                      key={expr.name}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        paddingLeft: 8,
                        paddingTop: 4,
                        paddingBottom: 4,
                        paddingRight: 6,
                        background: activeExpression === expr.name ? 'rgba(148,226,213,0.15)' : isHovered ? 'rgba(148,226,213,0.10)' : 'transparent',
                        borderLeft: activeExpression === expr.name ? '2px solid #94e2d5' : isHovered ? '2px solid rgba(148,226,213,0.4)' : '2px solid transparent',
                        cursor: 'pointer',
                        userSelect: 'none',
                        whiteSpace: 'nowrap',
                        fontFamily: 'monospace',
                        fontSize: 12,
                        transition: 'background 0.12s, border-left-color 0.12s',
                      }}
                      onMouseEnter={() => setHoveredExprName(expr.name)}
                      onMouseLeave={() => { setHoveredExprName(null); if (confirmDeleteExprName === expr.name) setConfirmDeleteExprName(null) }}
                      onClick={() => { if (!isConfirming) onExpressionSelect?.(expr) }}
                    >
                      <span style={{ color: '#6c7086', fontSize: 10, width: 12, flexShrink: 0 }}>ƒ</span>
                      <span style={{ color: '#94e2d5', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {expr.name}
                      </span>
                      {expr.props.length > 0 && (
                        <span style={{ color: '#6c7086', fontSize: 10, marginLeft: 2 }}>
                          {expr.props.join(', ')}
                        </span>
                      )}
                      <span style={{ marginLeft: 4, flexShrink: 0, display: 'flex', alignItems: 'center', minWidth: 20 }}>
                        {isConfirming ? (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                            <span style={{ color: '#f38ba8', fontSize: 10, fontFamily: 'system-ui', whiteSpace: 'nowrap' }}>Delete?</span>
                            <span
                              title="Confirm delete"
                              style={{ fontSize: 10, color: '#f38ba8', cursor: 'pointer', fontFamily: 'system-ui', fontWeight: 700, padding: '1px 4px', borderRadius: 3, border: '1px solid #f38ba8', lineHeight: 1.4 }}
                              onClick={(e) => { e.stopPropagation(); setConfirmDeleteExprName(null); onDeleteExpression?.(expr.name) }}
                            >Yes</span>
                            <span
                              title="Cancel"
                              style={{ fontSize: 10, color: '#6c7086', cursor: 'pointer', fontFamily: 'system-ui', padding: '1px 4px', borderRadius: 3, border: '1px solid #45475a', lineHeight: 1.4 }}
                              onClick={(e) => { e.stopPropagation(); setConfirmDeleteExprName(null) }}
                            >No</span>
                          </span>
                        ) : (
                          <span
                            title="Delete expression"
                            style={{ fontSize: 14, color: '#6c7086', cursor: 'pointer', lineHeight: 1, padding: '1px 3px', borderRadius: 3, transition: 'color 0.1s, opacity 0.1s', visibility: isHovered ? 'visible' : 'hidden', opacity: isHovered ? 1 : 0 }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLSpanElement).style.color = '#f38ba8' }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLSpanElement).style.color = '#6c7086' }}
                            onClick={(e) => { e.stopPropagation(); setConfirmDeleteExprName(expr.name) }}
                          >🗑</span>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
              <div style={styles.addPageOuter}>
                <div
                  style={{ ...styles.addPageBtn, color: '#94e2d5' }}
                  onClick={() => onAddExpression?.()}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(148,226,213,0.08)'; (e.currentTarget as HTMLDivElement).style.borderColor = '#94e2d5' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; (e.currentTarget as HTMLDivElement).style.borderColor = '#45475a' }}
                >
                  <span style={{ fontSize: 14, lineHeight: 1, color: '#94e2d5' }}>+</span>
                  <span>Add expression</span>
                </div>
              </div>
            </div>
          )}
          <div style={styles.pageSectionDivider} />
        </>
      )}

      {/* ── Components section ── */}
      {activeSection === 'components' && components !== undefined && (
        <>
          <div
            style={{ ...styles.sectionHeader, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={() => setComponentsOpen(o => !o)}
          >
            <span style={{ fontSize: 9, color: '#6c7086', transition: 'transform 0.15s', display: 'inline-block', transform: componentsOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
            Components
            <InfoIcon text="Reusable UI components shared across pages. Click a component to preview and edit it. Use '+ Add component' to create a new one." />
            <span style={{ color: '#6c7086', fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: 'auto' }}>{components.length}</span>
          </div>
          {componentsOpen && (
            <div style={styles.pagesSection}>
              <div style={styles.pageSearch}>
                <div style={styles.pageSearchBox}>
                  <span style={styles.pageSearchIcon}>⌕</span>
                  <input
                    style={styles.pageSearchInput}
                    placeholder="Filter components…"
                    value={componentSearch}
                    onChange={(e) => setComponentSearch(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  {componentSearch && (
                    <span
                      style={{ ...styles.pageSearchIcon, cursor: 'pointer', marginLeft: 0 }}
                      onClick={() => setComponentSearch('')}
                    >×</span>
                  )}
                </div>
              </div>
              <div style={styles.pagesScroll}>
                {filteredComponents.length === 0 ? (
                  <div style={{ color: '#6c7086', fontSize: 11, padding: '0.4rem 0.75rem', fontFamily: 'system-ui, sans-serif' }}>
                    {components.length === 0 ? 'No components yet' : 'No components match'}
                  </div>
                ) : filteredComponents.map((c) => {
                  const isActive = activeComponent === c.name
                  const isHovered = hoveredCompId === c.id
                  const isConfirming = confirmDeleteCompId === c.id
                  return (
                    <div
                      key={c.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        paddingLeft: 8,
                        paddingTop: 3,
                        paddingBottom: 3,
                        paddingRight: 6,
                        background: isActive ? '#2d2040' : isHovered ? 'rgba(203,166,247,0.10)' : 'transparent',
                        borderLeft: isActive ? '2px solid #cba6f7' : isHovered ? '2px solid rgba(203,166,247,0.4)' : '2px solid transparent',
                        cursor: 'pointer',
                        userSelect: 'none',
                        whiteSpace: 'nowrap',
                        fontFamily: 'monospace',
                        fontSize: 12,
                        transition: 'background 0.12s, border-left-color 0.12s',
                      }}
                      onMouseEnter={() => setHoveredCompId(c.id)}
                      onMouseLeave={() => { setHoveredCompId(null); if (confirmDeleteCompId === c.id) setConfirmDeleteCompId(null) }}
                      onClick={() => { if (!isConfirming) onComponentClick?.(c.id, c.name) }}
                    >
                      <span style={{ color: '#6c7086', fontSize: 10, width: 12, flexShrink: 0 }}>▸</span>
                      <span style={{ color: '#cba6f7' }}>{'fn'}</span>
                      <span style={{ color: isActive ? '#cba6f7' : '#cdd6f4', fontWeight: isActive ? 600 : 400, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {c.name}
                      </span>
                      <span style={{ color: '#6c7086', fontSize: 11, marginLeft: 2 }}>(cmp)</span>

                      {/* Fixed-width right slot — trash or confirm, always reserves space */}
                      <span style={{ marginLeft: 4, flexShrink: 0, display: 'flex', alignItems: 'center', minWidth: 20 }}>
                        {isConfirming ? (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                            <span style={{ color: '#f38ba8', fontSize: 10, fontFamily: 'system-ui', whiteSpace: 'nowrap' }}>Delete?</span>
                            <span
                              title="Confirm delete"
                              style={{ fontSize: 10, color: '#f38ba8', cursor: 'pointer', fontFamily: 'system-ui', fontWeight: 700, padding: '1px 4px', borderRadius: 3, border: '1px solid #f38ba8', lineHeight: 1.4 }}
                              onClick={(e) => { e.stopPropagation(); setConfirmDeleteCompId(null); onDeleteComponent?.(c.id, c.name) }}
                            >Yes</span>
                            <span
                              title="Cancel"
                              style={{ fontSize: 10, color: '#6c7086', cursor: 'pointer', fontFamily: 'system-ui', padding: '1px 4px', borderRadius: 3, border: '1px solid #45475a', lineHeight: 1.4 }}
                              onClick={(e) => { e.stopPropagation(); setConfirmDeleteCompId(null) }}
                            >No</span>
                          </span>
                        ) : (
                          <span
                            title="Delete component"
                            style={{ fontSize: 14, color: '#6c7086', cursor: 'pointer', lineHeight: 1, padding: '1px 3px', borderRadius: 3, transition: 'color 0.1s, opacity 0.1s', visibility: isHovered ? 'visible' : 'hidden', opacity: isHovered ? 1 : 0 }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLSpanElement).style.color = '#f38ba8' }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLSpanElement).style.color = '#6c7086' }}
                            onClick={(e) => { e.stopPropagation(); setConfirmDeleteCompId(c.id) }}
                          >🗑</span>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
              <div style={styles.addPageOuter}>
                <div
                  style={{ ...styles.addPageBtn, color: '#cba6f7' }}
                  onClick={() => onAddComponent?.()}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(203,166,247,0.08)'; (e.currentTarget as HTMLDivElement).style.borderColor = '#cba6f7' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; (e.currentTarget as HTMLDivElement).style.borderColor = '#45475a' }}
                >
                  <span style={{ fontSize: 14, lineHeight: 1, color: '#cba6f7' }}>+</span>
                  <span>Add component</span>
                </div>
              </div>
            </div>
          )}
          <div style={styles.pageSectionDivider} />
        </>
      )}

      {/* ── Multi-select status bar ── (hidden in expressions mode) */}
      {activeSection !== 'expressions' && multiSelected.length > 0 && (
        <div style={{
          padding: '4px 8px',
          background: 'rgba(137,180,250,0.1)',
          borderBottom: '1px solid rgba(137,180,250,0.25)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
          fontFamily: 'system-ui, sans-serif',
          fontSize: 10,
          color: '#89b4fa',
        }}>
          <span style={{ fontWeight: 600 }}>{multiSelected.length} selected</span>
          {selectionFileName && <span style={{ color: '#6c7086' }}>in {selectionFileName}</span>}
          <span style={{ marginLeft: 'auto', cursor: 'pointer', color: '#6c7086' }} onClick={() => setMultiSelected([])}>✕ Clear</span>
        </div>
      )}

      {activeSection !== 'expressions' && <div
        style={{ ...styles.sectionHeader, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        onClick={() => setTreeOpen(o => !o)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 9, color: '#6c7086', transition: 'transform 0.15s', display: 'inline-block', transform: treeOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
          React + DOM Tree
          <InfoIcon text="Live component hierarchy of the current preview. Click any node to inspect its source, props, and bindings in the right panel. Ctrl+click to multi-select, then right-click → Wrap with expression." />
        </span>
        {treeOpen && <span style={styles.nodeCount}>{total} node{total !== 1 ? 's' : ''}</span>}
      </div>}
      {activeSection !== 'expressions' && treeOpen && (
        <div style={styles.scroll}>
          {treeWithGhosts.length > 0 ? (
            treeWithGhosts.map((child) => (
              <TreeRow
                key={child.key}
                node={child}
                selected={selected}
                onSelect={handleSelect}
                hoveredElement={hoveredCanvasElement}
                multiCompFiles={multiCompFiles}
                multiSelectedKeys={multiSelectedKeys}
                onMultiToggle={handleMultiToggle}
                onRowContextMenu={handleRowContextMenu}
                hoveredWrapKey={hoveredWrapNodeKey}
              />
            ))
          ) : (
            <div style={styles.empty}>Waiting for render…</div>
          )}
        </div>
      )}

      {/* ── Context menu ── */}
      {contextMenuPos && (
        <div
          style={{
            position: 'fixed',
            top: contextMenuPos.y,
            left: contextMenuPos.x,
            zIndex: 9999,
            background: '#1e1e2e',
            border: '1px solid #45475a',
            borderRadius: 6,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            minWidth: 180,
            overflow: 'hidden',
            fontFamily: 'system-ui, sans-serif',
            fontSize: 12,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {multiSelected.length > 0 && (
            <div
              style={{ padding: '7px 12px', color: '#cdd6f4', cursor: 'pointer', borderBottom: '1px solid #313244' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(137,180,250,0.12)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
              onClick={() => {
                onWrapIntent?.(multiSelected)
                setMultiSelected([])
                setContextMenuPos(null)
              }}
            >
              Wrap {multiSelected.length} node{multiSelected.length !== 1 ? 's' : ''} with expression…
            </div>
          )}
          <div
            style={{ padding: '7px 12px', color: '#6c7086', cursor: 'pointer' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(137,180,250,0.08)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
            onClick={() => { setMultiSelected([]); setContextMenuPos(null) }}
          >
            Clear selection
          </div>
        </div>
      )}

      {/* ── Apply expression modal ── */}
      {applyExprState !== null && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setApplyExprState(null)}
        >
          <div
            style={{
              background: '#1e1e2e', border: '1px solid #313244', borderRadius: 10,
              width: 420, maxHeight: '80vh', display: 'flex', flexDirection: 'column',
              boxShadow: '0 8px 40px rgba(0,0,0,0.5)', overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', borderBottom: '1px solid #313244', background: '#181825' }}>
              <span style={{ color: '#cdd6f4', fontWeight: 600, fontSize: 13, fontFamily: 'system-ui, sans-serif' }}>
                Wrap {multiSelected.length} node{multiSelected.length !== 1 ? 's' : ''} with expression
              </span>
              <button style={{ background: 'none', border: 'none', color: '#6c7086', fontSize: 18, cursor: 'pointer', lineHeight: 1, padding: '0 2px' }} onClick={() => setApplyExprState(null)}>×</button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem' }}>
              {/* Expression picker */}
              <div style={{ marginBottom: 10, fontFamily: 'system-ui, sans-serif', fontSize: 11, color: '#6c7086', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.06em' }}>Choose expression</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
                {(expressions ?? []).map((expr) => {
                  const isChosen = applyExprState.expr?.name === expr.name
                  return (
                    <div
                      key={expr.name}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                        border: isChosen ? '1px solid #94e2d5' : '1px solid #313244',
                        background: isChosen ? 'rgba(148,226,213,0.10)' : '#181825',
                        fontFamily: 'monospace', fontSize: 12,
                      }}
                      onClick={() => {
                        const propValues: Record<string, string> = {}
                        for (const p of expr.props) propValues[p] = applyExprState.propValues[p] ?? ''
                        setApplyExprState(prev => prev ? { ...prev, expr, propValues, nodeAssignments: {}, openNodePickerProp: null, error: null } : null)
                      }}
                    >
                      <span style={{ color: '#94e2d5', fontWeight: 700 }}>ƒ</span>
                      <span style={{ color: '#cdd6f4', fontWeight: 600 }}>{expr.name}</span>
                      {expr.props.length > 0 && <span style={{ color: '#6c7086', fontSize: 11 }}>({expr.props.join(', ')})</span>}
                    </div>
                  )
                })}
                {(expressions ?? []).length === 0 && (
                  <div style={{ color: '#6c7086', fontSize: 11, fontFamily: 'system-ui, sans-serif' }}>No expressions available. Add some in the Expressions tab.</div>
                )}
              </div>

              {/* Props form */}
              {applyExprState.expr && applyExprState.expr.props.length > 0 && (
                <>
                  <div style={{ marginBottom: 8, fontFamily: 'system-ui, sans-serif', fontSize: 11, color: '#6c7086', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.06em' }}>Props</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {applyExprState.expr.props.map((prop) => {
                      const assignedIdx = applyExprState.nodeAssignments[prop]
                      const assignedNode = assignedIdx != null ? multiSelected[assignedIdx] : null
                      const isPickerOpen = applyExprState.openNodePickerProp === prop
                      return (
                        <div key={prop} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#89b4fa' }}>{prop}</span>

                          {assignedNode ? (
                            /* Node chip – shows the assigned tree node */
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 6, background: 'rgba(148,226,213,0.10)', border: '1px solid #94e2d5' }}>
                              <span style={{ fontSize: 10, color: '#94e2d5' }}>🌳</span>
                              <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#cdd6f4', flex: 1 }}>
                                &lt;{assignedNode.tag} /&gt;
                                <span style={{ color: '#6c7086', fontSize: 10, marginLeft: 6 }}>line {assignedNode.line}</span>
                              </span>
                              <button
                                style={{ background: 'none', border: 'none', color: '#6c7086', fontSize: 14, cursor: 'pointer', lineHeight: 1, padding: 0 }}
                                title="Remove node assignment"
                                onClick={() => setApplyExprState(prev => {
                                  if (!prev) return null
                                  const na = { ...prev.nodeAssignments }
                                  delete na[prop]
                                  return { ...prev, nodeAssignments: na, openNodePickerProp: null }
                                })}
                              >×</button>
                            </div>
                          ) : (
                            /* Text input + node-picker button */
                            <div style={{ position: 'relative', display: 'flex', gap: 4 }}>
                              <input
                                style={{
                                  flex: 1, background: '#181825', border: '1px solid #45475a', borderRadius: 6,
                                  color: '#cdd6f4', fontSize: 12, fontFamily: 'monospace',
                                  padding: '0.4rem 0.6rem', outline: 'none',
                                }}
                                placeholder="{expression}"
                                value={applyExprState.propValues[prop] ?? ''}
                                onChange={(e) => setApplyExprState(prev => prev ? { ...prev, propValues: { ...prev.propValues, [prop]: e.target.value } } : null)}
                              />
                              {multiSelected.length > 0 && (
                                <div style={{ position: 'relative', flexShrink: 0 }}>
                                  <button
                                    title="Assign a tree node to this prop"
                                    style={{
                                      height: '100%', padding: '0 8px', background: '#181825',
                                      border: '1px solid #45475a', borderRadius: 6,
                                      color: '#6c7086', fontSize: 11, cursor: 'pointer',
                                      display: 'flex', alignItems: 'center', gap: 3,
                                      whiteSpace: 'nowrap',
                                    }}
                                    onClick={() => setApplyExprState(prev => prev
                                      ? { ...prev, openNodePickerProp: isPickerOpen ? null : prop }
                                      : null)}
                                  >
                                    🌳 <span style={{ fontSize: 9 }}>▾</span>
                                  </button>
                                  {isPickerOpen && (
                                    <div style={{
                                      position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 1000,
                                      background: '#181825', border: '1px solid #45475a', borderRadius: 6,
                                      boxShadow: '0 4px 16px rgba(0,0,0,0.5)', minWidth: 160,
                                      overflow: 'hidden',
                                    }}>
                                      {multiSelected.map((item, idx) => (
                                        <div
                                          key={item.key}
                                          style={{ padding: '6px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, borderBottom: idx < multiSelected.length - 1 ? '1px solid #313244' : 'none' }}
                                          onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(148,226,213,0.10)' }}
                                          onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                                          onClick={() => setApplyExprState(prev => prev
                                            ? { ...prev, nodeAssignments: { ...prev.nodeAssignments, [prop]: idx }, openNodePickerProp: null }
                                            : null)}
                                        >
                                          <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#cdd6f4' }}>&lt;{item.tag}&gt;</span>
                                          <span style={{ fontSize: 10, color: '#6c7086' }}>line {item.line}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}

              {applyExprState.error && (
                <div style={{ marginTop: 10, background: '#3b1f2e', border: '1px solid #f38ba8', borderRadius: 6, color: '#f38ba8', fontSize: 11, fontFamily: 'system-ui, sans-serif', padding: '0.4rem 0.6rem' }}>
                  {applyExprState.error}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '0.75rem 1rem', borderTop: '1px solid #313244', background: '#181825' }}>
              <button
                style={{ background: 'transparent', border: '1px solid #45475a', borderRadius: 6, color: '#9ca3af', fontSize: 12, fontFamily: 'system-ui, sans-serif', padding: '0.35rem 0.9rem', cursor: 'pointer' }}
                onClick={() => setApplyExprState(null)}
              >Cancel</button>
              <button
                style={{
                  background: applyExprState.expr && !applyExprState.applying ? '#94e2d5' : '#45475a',
                  border: 'none', borderRadius: 6,
                  color: '#1e1e2e', fontSize: 12, fontFamily: 'system-ui, sans-serif',
                  fontWeight: 700, padding: '0.35rem 0.9rem', cursor: applyExprState.expr && !applyExprState.applying ? 'pointer' : 'not-allowed',
                }}
                disabled={!applyExprState.expr || applyExprState.applying}
                onClick={applyWrapping}
              >{applyExprState.applying ? 'Applying…' : 'Apply'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 260,
    minWidth: 260,
    flexShrink: 0,
    background: '#1e1e2e',
    borderRight: '1px solid #313244',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  nodeCount: {
    color: '#6c7086',
    fontWeight: 400,
    textTransform: 'none',
    letterSpacing: 0,
    fontSize: 10,
  },
  sectionHeader: {
    padding: '0.5rem 0.75rem',
    background: '#181825',
    borderBottom: '1px solid #313244',
    color: '#6c7086',
    fontWeight: 600,
    fontSize: 10,
    flexShrink: 0,
    fontFamily: 'system-ui, sans-serif',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.07em',
  },
  pageSectionDivider: {
    height: 1,
    background: '#313244',
    flexShrink: 0,
  },
  pagesSection: {
    display: 'flex',
    flexDirection: 'column' as const,
    maxHeight: '50vh',
    flexShrink: 0,
    borderBottom: '1px solid #313244',
  },
  pagesScroll: {
    overflowY: 'auto' as const,
    flex: 1,
  },
  addPageOuter: {
    padding: '0.45rem 0.6rem',
    background: '#181825',
    borderTop: '1px solid #313244',
    flexShrink: 0,
  },
  addPageBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '0.3rem 0.5rem',
    cursor: 'pointer',
    color: '#a6e3a1',
    fontSize: 11,
    fontFamily: 'system-ui, sans-serif',
    fontWeight: 500,
    background: 'transparent',
    border: '1px solid #45475a',
    borderRadius: 6,
    userSelect: 'none' as const,
    transition: 'background 0.12s, border-color 0.12s',
  },
  pageSearch: {
    padding: '0.45rem 0.6rem',
    background: '#181825',
    borderBottom: '1px solid #313244',
    flexShrink: 0,
  },
  pageSearchBox: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0.3rem 0.5rem',
    background: '#1e1e2e',
    border: '1px solid #45475a',
    borderRadius: 6,
  },
  pageSearchIcon: {
    color: '#6c7086',
    fontSize: 13,
    flexShrink: 0,
    userSelect: 'none' as const,
    lineHeight: 1,
  },
  pageSearchInput: {
    flex: 1,
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: '#cdd6f4',
    fontSize: 11,
    fontFamily: 'system-ui, sans-serif',
    padding: 0,
  },
  scroll: {
    overflowY: 'auto',
    flex: 1,
    paddingBottom: 8,
  },
  empty: {
    color: '#6c7086',
    fontSize: 11,
    padding: '1rem',
    fontFamily: 'system-ui, sans-serif',
  },
}
