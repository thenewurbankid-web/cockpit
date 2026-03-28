import { useEffect, useRef, useState } from 'react'
import { highlightElement, clearHighlight } from '../highlight'
import { getElementSourceInfo, type ElementSourceInfo } from '../fiberSource'

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
}

type DisplayNode = DisplayDomNode | DisplayComponentNode

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
}

function TreeRow({ node, selected, onSelect, hoveredElement }: RowProps) {
  // Root component (depth 0) and all DOM nodes start open;
  // child component nodes (depth > 0) start collapsed.
  const [open, setOpen] = useState(node.kind !== 'component' || node.depth === 0)
  const nodeElement = firstDomElement(node)
  const isSelected = nodeElement !== null && nodeElement === selected
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

  const rowEl = nodeElement

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
          background: isSelected ? '#313244' : isCanvasHovered ? 'rgba(250,179,135,0.12)' : 'transparent',
          borderLeft: isSelected ? '2px solid #89b4fa' : isCanvasHovered ? '2px solid #fab387' : '2px solid transparent',
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
        onClick={() => onSelect(node)}
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
            <span style={{ color: '#6c7086', fontSize: 11 }}>(component)</span>
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
          <TreeRow key={i} node={child} selected={selected} onSelect={onSelect} hoveredElement={hoveredElement} />
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
    inspectMode?: 'node' | 'component' | 'file',
    componentName?: string
  ) => void
  /** Called after a DOM node is selected in the tree. Does NOT change locate/navigation behaviour. */
  onNodeSelect?: (snapshot: SelectedNodeSnapshot | null) => void
  preferredRootComponentName?: string
  /** Controls which section is shown in the panel. */
  activeSection?: 'pages' | 'components'
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
}: DOMTreePanelProps) {
  const [tree, setTree] = useState<DisplayNode[]>([])
  const [selected, setSelected] = useState<Element | null>(null)
  const [hoveredCanvasElement, setHoveredCanvasElement] = useState<Element | null>(null)
  const rafRef = useRef<number>(0)

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
          setTree(buildMixedTree(root, preferredRootComponentName))
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [canvasRef, preferredRootComponentName])

  function handleSelect(node: DisplayNode) {
    if (node.kind === 'component') {
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
    <div style={styles.panel}>
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

      <div
        style={{ ...styles.sectionHeader, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        onClick={() => setTreeOpen(o => !o)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 9, color: '#6c7086', transition: 'transform 0.15s', display: 'inline-block', transform: treeOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
          React + DOM Tree
          <InfoIcon text="Live component hierarchy of the current preview. Click any node to inspect its source, props, and bindings in the right panel." />
        </span>
        {treeOpen && <span style={styles.nodeCount}>{total} node{total !== 1 ? 's' : ''}</span>}
      </div>
      {treeOpen && (
        <div style={styles.scroll}>
          {tree.length > 0 ? (
            tree.map((child) => (
              <TreeRow key={child.key} node={child} selected={selected} onSelect={handleSelect} hoveredElement={hoveredCanvasElement} />
            ))
          ) : (
            <div style={styles.empty}>Waiting for render…</div>
          )}
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
