export interface ServerDiagnostic {
  code: number
  message: string
  severity: number
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

// ── selected-node context (passed in from DOMTreePanel after selection) ───────

export interface SelectedNodeContext {
  tag: string
  locatorId: string | null
  locatorFile: string | null
  locatorLine: number | null
  ownerComponentName: string | null
  /** File where the owner component is itself invoked (its parent's file). */
  ownerFile?: string | null
  /** Line in ownerFile where the owner component's JSX tag appears. */
  ownerLine?: number | null
  domAttributes: Array<{ name: string; value: string }>
}

// An attribute row parsed from JSX source AST.
export interface JsxAttr {
  name: string
  /** Stringified representation of the value as it appears in source. */
  rawValue: string
  /** True when value is already a JSX expression binding, e.g. {foo}. */
  isExpression: boolean
  /** True for boolean shorthand attributes, e.g. `disabled`. */
  isBoolean: boolean
  /** True for spread attributes — shown read-only. */
  isSpread: boolean
  /** 0-indexed line in the FULL file where this attribute starts. */
  startLine: number
}

// A prop available in the owning component signature.
export interface ComponentProp {
  name: string
  typeStr: string
  /** Default value from destructure, e.g. `type = 'text'` → `'text'`. */
  defaultValue?: string
  /** Where this prop originated — for visual badge in dropdown. */
  source: 'owner' | 'element'
}

/** One named variable in a component scope (prop or state/local). */
export interface ScopeItem {
  name: string
  typeStr: string
  /** True when this item is actually used by the currently selected node's JSX. */
  usedInNode: boolean
  /** Default value from the component's destructure signature, e.g. `"Sign In"`. */
  defaultValue?: string
}

/** One level of the component hierarchy with its available scope. */
export interface ScopeLayer {
  componentName: string
  /** Whether this is the component that directly renders the selected node. */
  isCurrent: boolean
  props: ScopeItem[]
  state: ScopeItem[]
  /** Binding links: which parent variable is passed to which child prop. */
  links?: Array<{ parentVar: string; childProp: string }>
  /**
   * Downstream bindings: child components that receive this component's
   * props/state as JSX expression bindings. Only populated for the root layer.
   * Used by ScopePanel to show a color-coded "used by" downstream view.
   */
  childBindings?: Array<{ componentName: string; bindings: Array<{ rootVar: string; childProp: string }> }>
}

export interface InspectorPanelProps {
  file: string
  line: number
  inspectMode?: 'node' | 'component' | 'file' | 'expression' | 'component-usage'
  componentName?: string
  /** Populated by DOMTreePanel after a DOM node is selected — drives the Bindings tab. */
  selectedNode?: SelectedNodeContext | null
  /** Name of the root/page component that is allowed to be edited (e.g. "LoginPage").
   *  Any node belonging to a different component is shown read-only. */
  rootComponentName?: string
  onClose: () => void
  /** Called whenever the user resizes the panel so the caller can adjust layout. */
  onWidthChange?: (width: number) => void
  /** Called when the user clicks the navigate icon on a read-only child component tab. */
  onNavigateToComponent?: (componentName: string) => void
  /** When true (expression selected), hides scope panel and non-source tabs. */
  expressionMode?: boolean
  /** Pages + components for the expression picker, shown above source in expression mode. */
  expressionPages?: { id: string; label: string; root: string }[]
  expressionComponents?: { id: string; label: string; name: string }[]
  /** Called when user clicks a chip in the expression picker. */
  onInsertComponent?: (tag: string) => void
  /** When true, the panel is in wrap-node mode — hides close btn and tabs, shows expression chooser. */
  wrapMode?: boolean
  wrapExpressions?: { name: string; file: string; props: string[] }[]
  wrapChosenExpr?: { name: string; file: string; props: string[] } | null
  onWrapChooseExpr?: (expr: { name: string; file: string; props: string[] }) => void
  /** When true, the preview has a runtime error — only the source tab is shown. */
  hasRuntimeError?: boolean
  /** Which top-level section is active ('pages' | 'components' | 'expressions'). */
  activeSection?: 'pages' | 'components' | 'expressions'
  /** The name of the active page (used to show StatesPanel). */
  activePage?: string
  /** Root path of the active project. */
  projectRoot?: string
}

export type Tab = 'source' | 'props' | 'bindings' | 'expression' | 'changes'

// ── block extraction ──────────────────────────────────────────────────────────

export interface BlockRange {
  startLine: number // 0-indexed within the full file
  endLine: number   // 0-indexed, inclusive
}

export interface AstLoc {
  start: { line: number }
  end: { line: number }
}

export interface AstNode {
  type: string
  loc?: AstLoc | null
  [key: string]: unknown
}

export interface BareModuleUsage {
  hasDefault: boolean
  hasNamespace: boolean
  named: Set<string>
}

export interface AstLocFull {
  start: { line: number; column: number }
  end: { line: number; column: number }
}

/** JSX text or expression child */
export interface JsxTextChild {
  /** 'text' = JSXText literal, 'expr' = expression child (identifier / literal) */
  kind: 'text' | 'expr'
  index: number
  /** Editable display value: trimmed text or the expression source string */
  value: string
  /** 0-indexed line/col in the full source */
  startLine: number
  startCol: number
  endLine: number
  endCol: number
}

export interface ScopePanelProps {
  layers: ScopeLayer[]
  inspectingComponent: boolean
  ownerProps: ComponentProp[]
  parentLocals: string[]
  parentSource: string
  parentComponentName: string
  usageAttrs: JsxAttr[]
  currentTag: string
  onAddProp?: (layerComponentName: string) => void
  onRemoveProp?: (layerComponentName: string, propName: string) => void
  onAddState?: (layerComponentName: string) => void
  onRemoveState?: (layerComponentName: string, varName: string) => void
  readOnly?: boolean
}

export interface PropDraft {
  name: string
  type: string
  hasExplicit: boolean
}

/** One file's before/after content for the diff viewer. */
export interface PendingDiffEntry {
  file: string
  original: string
  modified: string
}

/** Pending code diff awaiting user review before applying. */
export interface PendingDiff {
  entries: PendingDiffEntry[]
  /** Human-readable summary lines describing each change. */
  summary: string[]
}
