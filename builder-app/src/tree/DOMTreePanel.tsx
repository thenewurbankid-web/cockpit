import { useEffect, useRef, useState } from 'react'

interface ResolvedLocator {
  file: string
  line: number
  expressionName: string | null
  ownerComponentName: string | null
  ownerComponentLine: number | null
}

function isLikelyReactComponentName(name: string | null | undefined): boolean {
  if (!name) return false
  return /^[A-Z]/.test(name)
}

interface RawDomNode {
  kind: 'dom'
  el: Element
  tag: string
  locatorId: string | null
  locator: ResolvedLocator | null
  children: RawDomNode[]
}

interface DisplayDomNode {
  kind: 'dom'
  key: string
  el: Element
  tag: string
  locatorId: string | null
  locator: ResolvedLocator | null
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
  const locatorId = root.getAttribute('data-locatorjs-id')
  const locator = locatorId ? resolveLocatorId(locatorId) : null
  const children: RawDomNode[] = []
  for (const child of Array.from(root.children)) {
    children.push(buildRawDomTree(child))
  }
  return {
    kind: 'dom',
    el: root,
    tag: root.tagName.toLowerCase(),
    locatorId,
    locator,
    children,
  }
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

function collectLocators(node: RawDomNode, out: ResolvedLocator[]): void {
  if (node.locator) out.push(node.locator)
  for (const child of node.children) collectLocators(child, out)
}

function inferPageRoot(
  rawRoots: RawDomNode[],
  preferredRootComponentName?: string
): { name: string; file: string; line: number } | null {
  const all: ResolvedLocator[] = []
  for (const root of rawRoots) collectLocators(root, all)

  // If caller provides a preferred root name (e.g. LoginPage), use it first.
  if (preferredRootComponentName && isLikelyReactComponentName(preferredRootComponentName)) {
    // Best case: exact owner match from /pages/ file.
    for (const loc of all) {
      if (
        loc.ownerComponentName === preferredRootComponentName &&
        normalizeSlashes(loc.file).includes('/pages/')
      ) {
        return {
          name: preferredRootComponentName,
          file: loc.file,
          line: loc.ownerComponentLine ?? loc.line,
        }
      }
    }

    // Fallback: no exact owner metadata, but we still force this name as root.
    // Pick a useful file/line anchor from page file if possible.
    const pageLoc = all.find((loc) => normalizeSlashes(loc.file).includes('/pages/'))
    if (pageLoc) {
      return {
        name: preferredRootComponentName,
        file: pageLoc.file,
        line: pageLoc.line,
      }
    }

    // Last fallback: use first available locator anchor.
    const first = all[0]
    if (first) {
      return {
        name: preferredRootComponentName,
        file: first.file,
        line: first.line,
      }
    }

    // Still no locators? return synthetic root with safe defaults.
    return {
      name: preferredRootComponentName,
      file: '',
      line: 1,
    }
  }

  // Prefer owners from files in /pages/ so root matches the loaded page component.
  for (const loc of all) {
    if (
      isLikelyReactComponentName(loc.ownerComponentName) &&
      normalizeSlashes(loc.file).includes('/pages/')
    ) {
      return {
        name: loc.ownerComponentName as string,
        file: loc.file,
        line: loc.ownerComponentLine ?? loc.line,
      }
    }
  }

  // Fallback: first valid owner we see.
  for (const loc of all) {
    if (isLikelyReactComponentName(loc.ownerComponentName)) {
      return {
        name: loc.ownerComponentName as string,
        file: loc.file,
        line: loc.ownerComponentLine ?? loc.line,
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
  const ownerName = isLikelyReactComponentName(node.locator?.ownerComponentName)
    ? node.locator?.ownerComponentName ?? null
    : null
  const expressionComponent = isLikelyReactComponentName(node.locator?.expressionName)
    ? node.locator?.expressionName ?? null
    : null

  // Prefer explicit owner component. If locator owner is invalid (e.g.
  // lowercase helper function like handleSubmit), fall back to expression name
  // when it looks like a React component (<Input />, <Button />).
  const effectiveOwnerName = ownerName ?? expressionComponent
  const currentOwnerName = effectiveOwnerName ?? parentOwnerName

  const domNode: DisplayDomNode = {
    kind: 'dom',
    key: `${keyPrefix}-dom`,
    el: node.el,
    tag: node.tag,
    locatorId: node.locatorId,
    locator: node.locator,
    depth,
    children: node.children.map((child, i) =>
      toMixedTree(child, depth + 1, currentOwnerName, `${keyPrefix}-${i}`)
    ),
  }

  // If ownership changes at this node, insert a synthetic component node
  // above the DOM node so the UI shows React + DOM hierarchy.
  if (effectiveOwnerName && effectiveOwnerName !== parentOwnerName) {
    return {
      kind: 'component',
      key: `${keyPrefix}-comp-${effectiveOwnerName}`,
      name: effectiveOwnerName,
      file: node.locator?.file ?? '',
      // Prefer explicit owner line when owner is valid; otherwise use expression line.
      line:
        ownerName && node.locator?.ownerComponentLine
          ? node.locator.ownerComponentLine
          : (node.locator?.line ?? 1),
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
}

function TreeRow({ node, selected, onSelect }: RowProps) {
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
          background: isSelected ? '#313244' : 'transparent',
          borderLeft: isSelected ? '2px solid #89b4fa' : '2px solid transparent',
          cursor: 'pointer',
          userSelect: 'none',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          fontFamily: 'monospace',
          fontSize: 12,
          transition: 'background 0.1s',
        }}
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
            <span style={{ color: node.locatorId ? '#89b4fa' : '#cdd6f4' }}>{node.tag}</span>

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
        {(node.kind === 'component' || node.locatorId) && (
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
          <TreeRow key={i} node={child} selected={selected} onSelect={onSelect} />
        ))}
    </div>
  )
}

// ---- locatorjs path resolution (mirrors useLocator.ts) ----

declare global {
  interface Window {
    __LOCATOR_DATA__?: Record<
      string,
      {
        filePath: string
        projectPath: string
        expressions: Array<{
          name: string
          loc: { start: { line: number; column: number } }
          wrappingComponentId?: number | null
        }>
        components?: Array<{
          name: string
          loc: { start: { line: number; column: number } }
        }>
      }
    >
  }
}

function normalizeConcatenatedPath(raw: string): string {
  const hits = [...raw.matchAll(/[A-Za-z]:[\\/]/g)]
  if (hits.length >= 2 && hits[1].index !== undefined) return raw.slice(hits[1].index)
  return raw
}

function resolveLocatorId(
  locatorId: string
): ResolvedLocator | null {
  const sep = locatorId.lastIndexOf('::')
  if (sep === -1) return null
  const rawKey = locatorId.slice(0, sep)
  const key = normalizeConcatenatedPath(rawKey)
  const idx = parseInt(locatorId.slice(sep + 2), 10)
  const locatorData = window.__LOCATOR_DATA__ ?? {}
  let fileData: (typeof locatorData)[string] | undefined = locatorData[key] ?? locatorData[rawKey]

  if (!fileData) {
    const hit = Object.entries(locatorData).find(([k, v]) => {
      return (
        normalizeConcatenatedPath(k) === key ||
        normalizeConcatenatedPath(v.filePath) === key
      )
    })
    fileData = hit?.[1]
  }

  const expr = fileData?.expressions[idx]
  const compId = expr?.wrappingComponentId
  const ownerComp =
    typeof compId === 'number' && compId >= 0 ? fileData?.components?.[compId] : undefined
  let file = key
  if (fileData) {
    const fp = normalizeConcatenatedPath(fileData.filePath)
    file = /^[A-Za-z]:[\\/]|^\//.test(fp) ? fp : `${fileData.projectPath}${fp}`
  }
  return {
    file,
    line: expr?.loc.start.line ?? 1,
    expressionName: expr?.name ?? null,
    ownerComponentName: isLikelyReactComponentName(ownerComp?.name) ? ownerComp?.name ?? null : null,
    ownerComponentLine: ownerComp?.loc?.start?.line ?? null,
  }
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
}

function findNearestLocatorId(el: Element): string | null {
  let current: Element | null = el
  while (current) {
    const id = current.getAttribute('data-locatorjs-id')
    if (id) return id
    current = current.parentElement
  }
  return null
}

export function DOMTreePanel({
  canvasRef,
  onLocate,
  onNodeSelect,
  preferredRootComponentName,
}: DOMTreePanelProps) {
  const [tree, setTree] = useState<DisplayNode[]>([])
  const [selected, setSelected] = useState<Element | null>(null)
  const rafRef = useRef<number>(0)

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
      // Pass a component-level snapshot so the Inspector bindings tab can show
      // the component's declared props. Tag is capitalised to signal component mode.
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
    const locatorId = node.locatorId ?? findNearestLocatorId(node.el)
    if (locatorId) {
      const loc = resolveLocatorId(locatorId)
      if (loc) onLocate(loc.file, loc.line, 'node')
    }
    node.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })

    // --- Post-selection: build snapshot for the inspector bindings panel.
    // This is additive and runs AFTER all existing navigate/locate logic above.
    if (onNodeSelect) {
      const domAttrs: Array<{ name: string; value: string }> = []
      for (const attr of Array.from(node.el.attributes)) {
        // Skip internal locator attributes — not useful to expose in the UI.
        if (attr.name === 'data-locatorjs-id') continue
        domAttrs.push({ name: attr.name, value: attr.value })
      }
      onNodeSelect({
        tag: node.tag,
        locatorId: node.locatorId,
        locatorFile: node.locator?.file ?? null,
        locatorLine: node.locator?.line ?? null,
        ownerComponentName: node.locator?.ownerComponentName ?? null,
        domAttributes: domAttrs,
      })
    }
  }

  const total = countNodes(tree)

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span>React + DOM Tree</span>
        <span style={styles.nodeCount}>{total} node{total !== 1 ? 's' : ''}</span>
      </div>
      <div style={styles.scroll}>
        {tree.length > 0 ? (
          tree.map((child) => (
            <TreeRow key={child.key} node={child} selected={selected} onSelect={handleSelect} />
          ))
        ) : (
          <div style={styles.empty}>Waiting for render…</div>
        )}
      </div>
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
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.5rem 0.75rem',
    background: '#181825',
    borderBottom: '1px solid #313244',
    color: '#cdd6f4',
    fontWeight: 600,
    fontSize: 11,
    flexShrink: 0,
    fontFamily: 'system-ui, sans-serif',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  nodeCount: {
    color: '#6c7086',
    fontWeight: 400,
    textTransform: 'none',
    letterSpacing: 0,
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
