import type { ElementSourceInfo, ExpressionInstance } from '../fiberSource'

export interface ExpressionMeta {
  name: string
  file: string
  props: string[]
}

/** A tree node selected for wrapping — passed to App via onWrapIntent. */
export interface WrapIntentNode { key: string; file: string; line: number; tag: string }

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
  /** Fiber-derived function name — used for AST lookups (e.g. "Input"). */
  name: string
  /** Qualified JSX tag for display (e.g. "TextField.Input"). Set by async enrichment. */
  displayName?: string
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
  /** When true, this node is treated as a page root even if depth > 0 (e.g. page inside a layout). */
  isPageRoot?: boolean
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

export type DisplayNode = DisplayDomNode | DisplayComponentNode | DisplayGhostNode | DisplayLoopNode

export type { RawDomNode, DisplayDomNode, DisplayComponentNode, DisplayGhostNode, DisplayLoopNode }

// Serialisable snapshot of the selected node — passed up to Inspector after selection.
export interface SelectedNodeSnapshot {
  tag: string
  locatorId: string | null
  locatorFile: string | null
  locatorLine: number | null
  ownerComponentName: string | null
  ownerFile?: string | null
  ownerLine?: number | null
  /**
   * Full fiber ancestry chain for multi-level scope walking without locatorjs.
   * chain[0] = immediate owner (same as ownerFile/ownerLine).
   * chain[N] = the Nth ancestor component, each entry's file/line pointing to
   * WHERE that component is used in its parent's JSX.
   */
  ownerChain?: Array<{ componentName: string; file: string | null; line: number | null }>
  domAttributes: Array<{ name: string; value: string }>
}

export interface PageEntry {
  id: string
  label: string
  root: string
}

export interface ComponentEntry {
  id: string
  label: string
  name: string
}

export interface LayoutEntry {
  id: string
  label: string
  name: string
  file?: string
}

export interface DOMTreePanelProps {
  /** The live DOM element that contains the preview content (iframe body or expression div). */
  canvasEl: HTMLElement | null
  onLocate: (
    file: string,
    line: number,
    inspectMode?: 'node' | 'component' | 'file' | 'expression' | 'component-usage',
    componentName?: string
  ) => void
  /** Called after a DOM node is selected in the tree. Does NOT change locate/navigation behaviour. */
  onNodeSelect?: (snapshot: SelectedNodeSnapshot | null) => void
  preferredRootComponentName?: string
  /** Controls which section is shown in the panel. */
  activeSection?: 'pages' | 'components' | 'expressions' | 'layouts'
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
  /** Called when the user drags the panel resize handle. */
  onWidthChange?: (width: number) => void
  /** Called once after the first tree build for each page/component, with the root node pre-selected. */
  onAutoSelect?: (snapshot: SelectedNodeSnapshot, file: string, line: number, componentName: string) => void
  /** When true, the canvas failed to render — show a stub node instead of the frozen last tree. */
  hasLoadError?: boolean
  /** Component name to display in the stub node when hasLoadError is true. */
  loadErrorComponentName?: string
  /** Configured pages directory for this project (used to correctly identify page files in inferPageRoot). */
  pagesDir?: string
  /** Configured components directory for this project. */
  componentsDir?: string
  /** Optional list of layouts to display below pages in the panel. */
  layouts?: LayoutEntry[]
  /** The id of the currently active (selected) layout. */
  activeLayoutId?: string | null
  /** Called when the user clicks a layout row. */
  onLayoutClick?: (layout: LayoutEntry) => void
  /** Called when the user clicks "+ Add layout". */
  onAddLayout?: () => void
  /** Called when the user confirms deleting a layout. */
  onDeleteLayout?: (id: string, name: string) => void
  /** Project root path — passed to RoutePanel for route management. */
  projectRoot?: string
  /** Active page id — passed to RoutePanel. */
  pageId?: string
  /** Layouts available for route assignment in RoutePanel. */
  routeLayouts?: { id: string; name: string }[]
  /** Called when the user saves or removes a route assignment. */
  onRouteChange?: (route: string | null, layoutId: string | null) => void
}
