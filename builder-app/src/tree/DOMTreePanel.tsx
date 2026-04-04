import { useEffect, useMemo, useRef, useState } from 'react'
import { highlightElement, clearHighlight } from '../highlight'
import { collectExpressionInstances, type ExpressionInstance } from '../fiberSource'
import { wrapNodesWithExpression } from './expressionRewriter'
import type { ExpressionMeta, WrapIntentNode, DisplayNode, SelectedNodeSnapshot, DOMTreePanelProps } from './types'
import { hasMultipleComponents, collectComponentFiles, buildMixedTree, firstDomElement, mergeExpressionData } from './treeBuilders'
import { countNodes, findPathToEl, findNodeByKey, getNodeFile, getNodeLine, computeRelativeImportPath } from './helpers'
import { TreeRow } from './TreeRow'
import { styles } from './styles'

export type { ExpressionMeta, WrapIntentNode, SelectedNodeSnapshot }

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
  onWidthChange,
  onAutoSelect,
  hasLoadError,
  loadErrorComponentName,
  pagesDir,
  componentsDir,
}: DOMTreePanelProps) {
  const [tree, setTree] = useState<DisplayNode[]>([])
  const prevRootNameRef = useRef<string | undefined>(undefined)
  const needsInitialExpandRef = useRef(true)
  const needsInitialSelectRef = useRef(true)
  const [selected, setSelected] = useState<Element | null>(null)
  const [hoveredCanvasElement, setHoveredCanvasElement] = useState<Element | null>(null)
  const rafRef = useRef<number>(0)
  const fileMultiCacheRef = useRef<Map<string, boolean>>(new Map())
  const fileSourcesRef = useRef<Map<string, string>>(new Map())
  const treeWithGhostsRef = useRef<DisplayNode[]>([])
  const handleSelectRef = useRef<(node: DisplayNode) => void>(() => {})
  const [fileSourcesVersion, setFileSourcesVersion] = useState(0)
  const [multiCompFiles, setMultiCompFiles] = useState<Set<string>>(new Set())
  const [pickerMode, setPickerMode] = useState(false)
  const pickerModeRef = useRef(false)
  pickerModeRef.current = pickerMode

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
    if (node.kind === 'loop') return `loop(${node.count})`
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
  treeWithGhostsRef.current = treeWithGhosts

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
        if (e.altKey || pickerModeRef.current) {
          highlightElement(el)
        } else {
          clearHighlight()
        }
      } else {
        setHoveredCanvasElement(null)
        clearHighlight()
      }
    }

    function onMouseLeave() {
      setHoveredCanvasElement(null)
      clearHighlight()
    }

    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseleave', onMouseLeave)

    function onCanvasAltMousedown(e: MouseEvent) {
      if (!e.altKey && !pickerModeRef.current) return
      // Prevent the preview component from receiving this mousedown / the
      // subsequent click (e.g. button navigation) when picker mode is active.
      e.stopPropagation()
      e.preventDefault()
      let current: Element | null = e.target as Element
      while (current && canvas!.contains(current)) {
        const path = findPathToEl(current, treeWithGhostsRef.current)
        if (path?.length) {
          const targetKey = path[path.length - 1]
          setExpandedAncestors(new Set(path.slice(0, -1)))
          setScrollToKey(targetKey)
          const found = findNodeByKey(treeWithGhostsRef.current, targetKey)
          if (found) handleSelectRef.current(found)
          break
        }
        current = current.parentElement
      }
    }
    // Use capture phase so inner elements cannot stopPropagation before us.
    canvas.addEventListener('mousedown', onCanvasAltMousedown, true)

    // Block the click event in picker mode so preview component handlers
    // (buttons, links, etc.) don't fire after we've already handled it.
    function onCanvasPickerBlockClick(e: MouseEvent) {
      if (pickerModeRef.current) {
        e.stopPropagation()
        e.preventDefault()
      }
    }
    canvas.addEventListener('click', onCanvasPickerBlockClick, true)

    return () => {
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseleave', onMouseLeave)
      canvas.removeEventListener('mousedown', onCanvasAltMousedown, true)
      canvas.removeEventListener('click', onCanvasPickerBlockClick, true)
    }
  }, [canvasRef])

  // Apply crosshair cursor on canvas when picker mode is active.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.style.cursor = pickerMode ? 'crosshair' : ''
    return () => { if (canvasRef.current) canvasRef.current.style.cursor = '' }
  }, [pickerMode, canvasRef])

  // Poll via rAF — cheap, catches every HMR re-render without MutationObserver setup.
  useEffect(() => {
    let lastHTML = ''
    let lastInstancesKey = ''
    // True after the tree was rebuilt but we haven't yet collected a stable set
    // of expression instances for it (ghost nodes are null-rendering so they
    // don't affect innerHTML — we must keep collecting until the key stabilises).
    let pendingFirstInstances = false

    function collectAndDiffInstances(root: Element, newTree?: DisplayNode[]) {
      const newInstances = collectExpressionInstances(root)
      const newKey = newInstances
        .map(i => `${i.name}:${i.active ? 1 : 0}:${i.source?.lineNumber ?? ''}`)
        .join('|')
      if (newKey === lastInstancesKey) return
      lastInstancesKey = newKey
      setExprInstances(newInstances)
      // Fetch source files for any new instances (for multi-component badge).
      if (newTree) {
        const allFiles = new Set<string>()
        collectComponentFiles(newTree, allFiles)
        for (const inst of newInstances) {
          if (inst.source?.fileName) allFiles.add(inst.source.fileName)
        }
        for (const f of allFiles) {
          if (f.includes('node_modules') || f.includes('/@fs/') || f.includes('@vite') || f.includes('\0')) continue
          if (fileMultiCacheRef.current.has(f)) continue
          fileMultiCacheRef.current.set(f, false)
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

    function tick() {
      const root = canvasRef.current
      if (root && root.children.length > 0) {
        // If the canvas is showing a load error, stop tree rebuilding —
        // the tree content is driven by hasLoadError prop instead.
        if (root.querySelector('[data-load-error]')) {
          rafRef.current = requestAnimationFrame(tick)
          return
        }
        const html = root.innerHTML
        if (html !== lastHTML) {
          const projectDirs = [pagesDir, componentsDir].filter(Boolean) as string[]
          const newTree = buildMixedTree(root, preferredRootComponentName, projectDirs.length > 0 ? projectDirs : undefined)
          if (newTree === null) {
            // Canvas doesn't have the expected page yet (still loading / showing
            // previous page). Don't update lastHTML so we retry every frame until
            // the right component appears, keeping the tree cleared in the meantime.
            rafRef.current = requestAnimationFrame(tick)
            return
          }
          lastHTML = html
          setTree(newTree)
          if (needsInitialExpandRef.current) {
            needsInitialExpandRef.current = false
            setExpandGen(g => g + 1)
          }
          // Collect instances in same tick as tree rebuild.
          collectAndDiffInstances(root, newTree)
          // Keep spinner on for one more frame so ghost nodes can settle.
          pendingFirstInstances = true
        } else if (pendingFirstInstances) {
          // One frame after the tree rebuild: collect again to pick up any
          // null-rendering ghost nodes that didn't affect innerHTML.
          pendingFirstInstances = false
          collectAndDiffInstances(root)
          setTreeLoading(false)
        } else {
          // Steady-state: keep diffing instances so HMR additions/removals
          // of null-rendering expressions show up without requiring a full reload.
          collectAndDiffInstances(root)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [canvasRef, preferredRootComponentName])

  function handleSelect(node: DisplayNode) {
    handleSelectRef.current = handleSelect
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
      // If this is an expression component node (has exprProps AND its name is a known expression), open binding view.
      if (node.exprProps !== undefined && exprNamesRef.current.has(node.name)) {
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
        ownerFile: node.usageFile ?? null,
        ownerLine: node.usageLine ?? null,
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
        ownerFile: info?.ownerFile ?? null,
        ownerLine: info?.ownerLine ?? null,
        domAttributes: domAttrs,
      })
    }
  }

  // Auto-select the first (root component) node after each page/component switch.
  useEffect(() => {
    if (!needsInitialSelectRef.current || tree.length === 0 || !onAutoSelect) return
    needsInitialSelectRef.current = false
    const first = tree[0]
    if (first.kind === 'component' && first.file) {
      const el = firstDomElement(first)
      if (el) setSelected(el)
      onAutoSelect(
        { tag: first.name, locatorId: null, locatorFile: first.file, locatorLine: first.line, ownerComponentName: first.name, domAttributes: [] },
        first.file, first.line, first.name
      )
    } else if (first.kind === 'dom') {
      setSelected(first.el)
      const info = first.sourceInfo
      if (info) {
        const domAttrs: Array<{ name: string; value: string }> = []
        for (const attr of Array.from(first.el.attributes)) {
          domAttrs.push({ name: attr.name, value: attr.value })
        }
        onAutoSelect(
          { tag: first.tag, locatorId: null, locatorFile: info.file, locatorLine: info.line, ownerComponentName: info.ownerComponentName ?? null, domAttributes: domAttrs },
          info.file, info.line, info.ownerComponentName ?? first.tag
        )
      }
    }
  }, [tree]) // eslint-disable-line react-hooks/exhaustive-deps

  const total = countNodes(tree)
  const [pagesOpen, setPagesOpen] = useState(true)
  const [pageSearch, setPageSearch] = useState('')
  const [treeOpen, setTreeOpen] = useState(true)
  const [treeLoading, setTreeLoading] = useState(true)
  const [expandGen, setExpandGen] = useState(0)
  const [collapseGen, setCollapseGen] = useState(0)
  const [forceExpandAll, setForceExpandAll] = useState(false)
  const [expandedAncestors, setExpandedAncestors] = useState<Set<string> | null>(null)
  const [scrollToKey, setScrollToKey] = useState<string | null>(null)

  // Reset tree + show spinner whenever the active page/component changes.
  // We key on the full selection identity (page id + component + root name)
  // so switching between two pages with the same root component name still resets.
  const selectionKey = `${activePage ?? ''}|${activeComponent ?? ''}|${preferredRootComponentName ?? ''}`
  useEffect(() => {
    if (prevRootNameRef.current !== selectionKey) {
      prevRootNameRef.current = selectionKey
      needsInitialExpandRef.current = true
      needsInitialSelectRef.current = true
      setTree([])
      setTreeLoading(true)
      setForceExpandAll(false)
      setExpandedAncestors(null)
      setScrollToKey(null)
    }
  }, [selectionKey])
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
          Element Tree
          <InfoIcon text="Live component hierarchy of the current preview. Click any node to inspect its source, props, and bindings in the right panel. Ctrl+click to multi-select, then right-click → Wrap with expression." />
          {treeLoading && treeOpen && <span className="cockpit-spinner" />}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {treeOpen && <span style={styles.nodeCount}>{total} node{total !== 1 ? 's' : ''}</span>}
          {treeOpen && (
            <>
              <span
                title={pickerMode ? 'Picker mode on — click any preview element to reveal it in the tree' : 'Picker mode — click to toggle'}
                style={{ fontSize: 10, cursor: 'pointer', padding: '1px 4px', borderRadius: 3, border: `1px solid ${pickerMode ? '#89b4fa' : '#45475a'}`, lineHeight: 1.6, userSelect: 'none', color: pickerMode ? '#89b4fa' : '#6c7086', background: pickerMode ? 'rgba(137,180,250,0.12)' : 'transparent', transition: 'color 0.12s, border-color 0.12s, background 0.12s' }}
                onClick={(e) => { e.stopPropagation(); setPickerMode(m => !m) }}
                onMouseEnter={(e) => { if (!pickerMode) (e.currentTarget as HTMLSpanElement).style.color = '#cdd6f4' }}
                onMouseLeave={(e) => { if (!pickerMode) (e.currentTarget as HTMLSpanElement).style.color = '#6c7086' }}
              >⊕</span>
              <span
                title="Expand all"
                style={{ fontSize: 10, color: '#6c7086', cursor: 'pointer', padding: '1px 4px', borderRadius: 3, border: '1px solid #45475a', lineHeight: 1.6, userSelect: 'none' }}
                onClick={(e) => { e.stopPropagation(); setForceExpandAll(true) }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLSpanElement).style.color = '#cdd6f4' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLSpanElement).style.color = '#6c7086' }}
              >⊞</span>
              <span
                title="Collapse all"
                style={{ fontSize: 10, color: '#6c7086', cursor: 'pointer', padding: '1px 4px', borderRadius: 3, border: '1px solid #45475a', lineHeight: 1.6, userSelect: 'none' }}
                onClick={(e) => { e.stopPropagation(); setForceExpandAll(false); setExpandedAncestors(null); setCollapseGen(g => g + 1) }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLSpanElement).style.color = '#cdd6f4' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLSpanElement).style.color = '#6c7086' }}
              >⊟</span>
            </>
          )}
        </span>
      </div>}
      {activeSection !== 'expressions' && treeOpen && (
        <div style={styles.scroll}>
          {hasLoadError ? (
            <div style={{ padding: '6px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', color: '#f38ba8', fontSize: '0.8rem' }}>
                <span style={{ fontSize: 10 }}>⚠</span>
                <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{loadErrorComponentName ?? 'Component'}</span>
                <span style={{ color: '#6c7086', fontWeight: 400 }}>— failed to render</span>
              </div>
            </div>
          ) : treeWithGhosts.length > 0 ? (
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
                expandGen={expandGen}
                collapseGen={collapseGen}
                forceExpandAll={forceExpandAll}
                onClearForceExpand={() => { setForceExpandAll(false); setExpandedAncestors(null) }}
                expandedAncestors={expandedAncestors}
                scrollToKey={scrollToKey}
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

