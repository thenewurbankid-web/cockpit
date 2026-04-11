import { useCallback, useEffect, useRef, useState } from 'react'
import Editor, { DiffEditor, type Monaco } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import type { IDisposable } from 'monaco-editor'
import { parse } from '@babel/parser'

import { notifyPreviewRefresh } from '../preview/ComponentLoader'
import { InfoIcon } from './InfoIcon'
import type {
  ServerDiagnostic,
  SelectedNodeContext,
  JsxAttr,
  ComponentProp,
  ScopeItem,
  ScopeLayer,
  InspectorPanelProps,
  Tab,
  BlockRange,
  AstNode,
  AstLocFull,
  BareModuleUsage,
  JsxTextChild,
  PendingDiff,
} from './types'
import { extractBlock, extractChildBindings } from './astHelpers'
import { extractImports, countReactComponentsInSource, collectModuleUsages, normalizePath, candidateImportFiles, filePathToModelUri, buildBareModuleDeclarations } from './importHelpers'
import { extractJsxAttrs, extractJsxTextChildren, rewriteJsxTextChild, findLocatorUsages, collectAllJsxExpressionIdentifiers } from './jsxExtraction'
import { enrichWithTypeDeclaration, stringifyTSType, inferTypeFromExpression, inferTypeFromValueString, inferTypeOfLocal, extractComponentLocals, inferOwnerComponentName, componentHasPropTypeDef, extractOwnerProps } from './typeInference'
import { rewriteAttrValue, removeAttr, removePropFromOwnerSignature, addStateVariable, removeStateVariable, removePropUsagesInBody, insertAttr, addPropToOwnerSignature, rewritePropType, rewriteDefaultValue, reorderPropsInSource, rewriteJsxChildrenAsExpression } from './astRewriters'
import { ScopePanel, scopeStyles } from './ScopePanel'
import { StatesPanel } from './StatesPanel'
import { notifyPropsChange } from '../preview/ComponentLoader'
import { WrapExpressionChooser, ExpressionPickerPanel } from './ExpressionPicker'
import { styles } from './styles'

// Re-export types used by other parts of the app
export type { SelectedNodeContext, ComponentProp }

// ── inline single-line Monaco editor ──────────────────────────────────────────

function InlineMonaco({
  value,
  onChange,
  readOnly,
}: {
  value: string
  onChange: (v: string) => void
  readOnly?: boolean
}) {
  const [height, setHeight] = useState(60)
  const dragging = useRef(false)
  const startY = useRef(0)
  const startH = useRef(0)

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragging.current = true
    startY.current = e.clientY
    startH.current = height
    const onMove = (ev: PointerEvent) => {
      if (!dragging.current) return
      const newH = Math.max(22, Math.min(400, startH.current + (ev.clientY - startY.current)))
      setHeight(newH)
    }
    const onUp = () => {
      dragging.current = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [height])

  return (
    <div style={{
      flex: 1,
      minWidth: 0,
      border: '1px solid #45475a',
      borderRadius: 4,
      overflow: 'hidden',
      position: 'relative',
    }}>
      <Editor
        height={`${height}px`}
        language="typescript"
        value={value}
        onChange={(v) => onChange(v ?? '')}
        theme="vs-dark"
        options={{
          minimap: { enabled: false },
          lineNumbers: 'off',
          glyphMargin: false,
          folding: false,
          lineDecorationsWidth: 0,
          lineNumbersMinChars: 0,
          scrollbar: { vertical: 'hidden', horizontal: 'hidden', handleMouseWheel: false },
          overviewRulerBorder: false,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          wordWrap: 'on',
          scrollBeyondLastLine: false,
          renderLineHighlight: 'none',
          readOnly,
          fontSize: 12,
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          padding: { top: 2, bottom: 2 },
          contextmenu: false,
          tabSize: 2,
          automaticLayout: true,
          fixedOverflowWidgets: true,
        }}
      />
      <div
        onPointerDown={onPointerDown}
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 5,
          cursor: 'ns-resize',
          background: 'rgba(99,102,120,0.35)',
        }}
      />
    </div>
  )
}

// ── component ─────────────────────────────────────────────────────────────────

export function InspectorPanel({
  file,
  line,
  inspectMode,
  componentName,
  selectedNode,
  rootComponentName,
  onClose,
  onWidthChange,
  onNavigateToComponent,
  expressionMode,
  expressionPages = [],
  expressionComponents = [],
  onInsertComponent,
  wrapMode,
  wrapExpressions = [],
  wrapChosenExpr,
  onWrapChooseExpr,
  hasRuntimeError,
  activeSection,
  activePage,
  projectRoot,
}: InspectorPanelProps) {
  const [panelWidth, setPanelWidth] = useState(480)
  const [codeExpanded, setCodeExpanded] = useState(false)
  const [editorFullscreen, setEditorFullscreen] = useState(false)

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelWidth
    function onMove(ev: PointerEvent) {
      const newW = Math.max(320, Math.min(900, startW - (ev.clientX - startX)))
      setPanelWidth(newW)
      onWidthChange?.(newW)
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    if (wrapMode) return 'expression'
    if (expressionMode || inspectMode === 'expression') return 'source'
    const saved = sessionStorage.getItem('cockpit:activeTab')
    return (saved === 'props' || saved === 'bindings') ? saved : 'bindings'
  })

  useEffect(() => {
    if (!expressionMode && !wrapMode && inspectMode !== 'expression' && activeTab !== 'changes' && activeTab !== 'source') sessionStorage.setItem('cockpit:activeTab', activeTab)
  }, [activeTab])
  useEffect(() => {
    if (expressionMode || inspectMode === 'expression') setActiveTab('source')
  }, [expressionMode, inspectMode])
  useEffect(() => {
    if (wrapMode) setActiveTab('expression')
  }, [wrapMode])
  useEffect(() => {
    if (hasRuntimeError) setActiveTab('source')
  }, [hasRuntimeError])

  // ── wrap mode: load chosen expression source for read-only view ─────────────
  const [wrapExprSource, setWrapExprSource] = useState<string>('')
  const [wrapExprLoading, setWrapExprLoading] = useState(false)
  useEffect(() => {
    if (!wrapMode || !wrapChosenExpr) { setWrapExprSource(''); return }
    setWrapExprLoading(true)
    fetch(`/__source?file=${encodeURIComponent(wrapChosenExpr.file)}`)
      .then(r => r.ok ? r.text() : '')
      .then(src => { setWrapExprSource(src); setWrapExprLoading(false) })
      .catch(() => { setWrapExprLoading(false) })
  }, [wrapMode, wrapChosenExpr?.file])

  // True when the inspected node belongs to a child component — all edits are disabled.
  // Read-only only for DOM nodes explicitly owned by a non-root child component.
  // Component nodes (uppercase tag) are always editable — selecting one edits the props
  // passed TO it from the root's JSX, which is fair game regardless of which component it is.
  const isReadOnly = inspectMode !== 'component-usage' && !!rootComponentName && !!selectedNode && (
    !/^[A-Z]/.test(selectedNode.tag) &&
    !!selectedNode.ownerComponentName &&
    selectedNode.ownerComponentName !== rootComponentName
  )
  // True when the selected component IS the root — it has no parent, so binding makes no sense.
  // Root props only support default values; child props support binding + default values.
  const isRootComponent = !!(rootComponentName && selectedNode && /^[A-Z]/.test(selectedNode.tag) && selectedNode.tag === rootComponentName)
  // True when the inspected child component lives in the shared components folder —
  // these are read-only with a navigate icon; other child components are inline-editable.
  // The root component itself is always editable even if it's from the components folder.
  const isFromComponentsFolder = !!(selectedNode?.locatorFile && /[\/]components[\/]/.test(selectedNode.locatorFile) && !isRootComponent)
  const [displayCode, setDisplayCode] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [bindingsLoading, setBindingsLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [saveErrorMsg, setSaveErrorMsg] = useState<string>('')
  const [blockName, setBlockName] = useState<string>('')
  const [fileImports, setFileImports] = useState<string[]>([])
  const [importsExpanded, setImportsExpanded] = useState(true)
  // Scope hierarchy — replaces the imports panel.
  const [scopeLayers, setScopeLayers] = useState<ScopeLayer[]>([])

  // ── bindings tab state ──────────────────────────────────────────────────────
  const [jsxAttrs, setJsxAttrs] = useState<JsxAttr[]>([])
  const [ownerProps, setOwnerProps] = useState<ComponentProp[]>([])
  const [attrEdits, setAttrEdits] = useState<Record<string, string>>({})
  const [propTypeEdits, setPropTypeEdits] = useState<Record<string, string>>({})
  const [propValueEdits, setPropValueEdits] = useState<Record<string, string>>({})
  const [propDefaultEdits, setPropDefaultEdits] = useState<Record<string, string>>({})
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  // Attrs passed to this component at usage sites in the parent (e.g. <Input value={email}>)
  const [usageAttrs, setUsageAttrs] = useState<JsxAttr[]>([])
  // Which parent file + line the usage was found at (needed to write back value edits).
  const [usageInfo, setUsageInfo] = useState<{ file: string; line: number } | null>(null)
  // Local variable names from the parent component — used as datalist options for value fields.
  const [parentLocals, setParentLocals] = useState<string[]>([])
  // Parent source + component name, kept so type inference can run without an extra fetch.
  const [parentSource, setParentSource] = useState('')
  const [parentComponentName, setParentComponentName] = useState('')
  // Live input text while an attr field is focused (cleared on focus so datalist shows all options).
  const [focusedAttr, setFocusedAttr] = useState<string | null>(null)
  const [textChildren, setTextChildren] = useState<JsxTextChild[]>([])
  const [textChildEdits, setTextChildEdits] = useState<Record<number, string>>({})
  /** Per-text-child value/expression mode. */
  const [textChildModes, setTextChildModes] = useState<Record<number, 'value' | 'expression' | 'scope'>>({})
  /** Per-attr value/expression mode for DOM element attr rows. */
  const [attrModes, setAttrModes] = useState<Record<string, 'value' | 'expression' | 'scope'>>({})
  const [bindingsSaving, setBindingsSaving] = useState(false)
  // New-prop creation state
  const [newPropName, setNewPropName] = useState('')
  const [newPropType, setNewPropType] = useState('string')
  const [newPropValue, setNewPropValue] = useState('')
  const [newPropMode, setNewPropMode] = useState<'variable' | 'entry'>('entry')
  const [newPropAsExpr, setNewPropAsExpr] = useState(false)
  const [newPropTypeInferred, setNewPropTypeInferred] = useState(false)
  const [showAddProp, setShowAddProp] = useState(false)
  const [showAddAttr, setShowAddAttr] = useState(false)
  const [newAttrName, setNewAttrName] = useState('')
  const [newAttrValue, setNewAttrValue] = useState('')
  const [newAttrIsExpr, setNewAttrIsExpr] = useState(false)
  const [showListenerDropdown, setShowListenerDropdown] = useState(false)
  /** Per-prop value mode for existing binding rows. */
  const [propValueMode, setPropValueMode] = useState<Record<string, 'scope' | 'expression' | 'value'>>({})
  /** Per-prop default value mode (expression vs literal). */
  const [propDefaultMode, setPropDefaultMode] = useState<Record<string, 'value' | 'expression' | 'scope'>>({})
  /** True when the selected tree node is a React component (not a raw DOM element). */
  const [inspectingComponent, setInspectingComponent] = useState(false)
  /** True when the inspected component has a named props interface/type registered. */
  const [hasPropTypeDef, setHasPropTypeDef] = useState(true)
  const [deletingProp, setDeletingProp] = useState<string | null>(null)
  const [propOrder, setPropOrder] = useState<string[]>([])
  // State for the "add state variable" inline dialog in the Scope panel.
  const [addStateOpen, setAddStateOpen] = useState(false)
  const [newStateName, setNewStateName] = useState('')
  const [newStateInitial, setNewStateInitial] = useState('')
  const [newStateHook, setNewStateHook] = useState<'useState' | 'useRef'>('useState')
  // Shared save status used by both source tab and bindings mutations.
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  // True when the current file contains more than one React component definition.
  const [multipleComponentsInFile, setMultipleComponentsInFile] = useState(false)
  // Pending diff awaiting user review — shown as git-style diff in changes tab.
  const [pendingDiff, setPendingDiff] = useState<PendingDiff | null>(null)
  // Which file accordions are expanded in the Changes tab.
  const [expandedDiffFiles, setExpandedDiffFiles] = useState<Set<number>>(new Set([0]))

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const fullSourceRef = useRef<string>('')
  const blockRangeRef = useRef<BlockRange | null>(null)
  const prevFileRef = useRef<string>('')
  const fetchAbortRef = useRef<AbortController | null>(null)
  const lastValidSourceRef = useRef<string>('')
  const modelChangeDisposableRef = useRef<IDisposable | null>(null)
  const extraLibDisposableRef = useRef<IDisposable | null>(null)
  const contextLoadSeqRef = useRef(0)
  const diagnosticsTimerRef = useRef<number | null>(null)


  function buildFullSourceFromEditorValue(editedValue: string): string {
    const range = blockRangeRef.current
    const full = fullSourceRef.current
    if (!range || !full) return editedValue

    const lines = full.split('\n')
    return [
      ...lines.slice(0, range.startLine),
      editedValue,
      ...lines.slice(range.endLine + 1),
    ].join('\n')
  }

  function configureMonacoForInspector(monaco: Monaco) {
    const compilerOptions = {
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
      allowNonTsExtensions: true,
      allowJs: true,
      esModuleInterop: true,
      skipLibCheck: true,
      strict: false,
    }

    monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions)
    monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions)

    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSyntaxValidation: false,
      noSemanticValidation: true,
      noSuggestionDiagnostics: false,
    })
  }

  async function syncServerDiagnostics(filePath: string, content: string) {
    const monaco = monacoRef.current
    const ed = editorRef.current
    if (!monaco || !ed) return
    const model = ed.getModel()
    if (!model) return

    try {
      const res = await fetch('/__diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: filePath, content }),
      })
      const payload = await res.json()
      if (!res.ok) return

      const currentRange = blockRangeRef.current
      const isFileMode = inspectMode === 'file' || !currentRange
      const markers: editor.IMarkerData[] = ((payload.diagnostics as ServerDiagnostic[]) ?? [])
        .filter((d) => {
          if (isFileMode) return true
          return d.endLineNumber >= currentRange.startLine + 1 && d.startLineNumber <= currentRange.endLine + 1
        })
        .map((d) => {
          if (isFileMode) {
            return {
              code: String(d.code),
              message: d.message,
              severity: d.severity,
              startLineNumber: d.startLineNumber,
              startColumn: d.startColumn,
              endLineNumber: d.endLineNumber,
              endColumn: d.endColumn,
            }
          }

          const startLineNumber = Math.max(1, d.startLineNumber - currentRange.startLine)
          const endLineNumber = Math.max(startLineNumber, d.endLineNumber - currentRange.startLine)
          return {
            code: String(d.code),
            message: d.message,
            severity: d.severity,
            startLineNumber,
            startColumn: d.startColumn,
            endLineNumber,
            endColumn: d.endColumn,
          }
        })

      monaco.editor.setModelMarkers(model, 'server-tsc', markers)
    } catch {
      // Keep existing markers when diagnostics endpoint is temporarily unavailable.
    }
  }

  function scheduleDiagnostics(filePath: string, content: string) {
    if (diagnosticsTimerRef.current != null) {
      window.clearTimeout(diagnosticsTimerRef.current)
    }
    diagnosticsTimerRef.current = window.setTimeout(() => {
      void syncServerDiagnostics(filePath, content)
    }, 220)
  }

  async function fetchSourceFile(filePath: string): Promise<string | null> {
    // Never fetch or expose builder-app source files.
    if (filePath.toLowerCase().replace(/\\/g, '/').includes('builder-app/src/')) return null
    try {
      const res = await fetch(`/__source?file=${encodeURIComponent(filePath)}`)
      if (!res.ok) return null
      return await res.text()
    } catch {
      return null
    }
  }

  async function syncContextModels(entryFile: string, entrySource: string) {
    const monaco = monacoRef.current
    if (!monaco) return

    const seq = ++contextLoadSeqRef.current
    const moduleUsage = new Map<string, BareModuleUsage>()
    const attempted = new Set<string>()

    async function walk(filePath: string, source: string, depth: number) {
      if (depth > 3 || seq !== contextLoadSeqRef.current) return

      const relativeImports = collectModuleUsages(source, moduleUsage)
      for (const specifier of relativeImports) {
        for (const candidate of candidateImportFiles(filePath, specifier)) {
          const normalized = normalizePath(candidate)
          if (attempted.has(normalized)) continue
          attempted.add(normalized)

          const text = await fetchSourceFile(normalized)
          if (text == null) continue

          const uri = monaco.Uri.parse(filePathToModelUri(normalized))
          const existing = monaco.editor.getModel(uri)
          if (existing) existing.setValue(text)
          else monaco.editor.createModel(text, 'typescript', uri)

          await walk(normalized, text, depth + 1)
          break
        }
      }
    }

    await walk(normalizePath(entryFile), entrySource, 0)
    if (seq !== contextLoadSeqRef.current) return

    extraLibDisposableRef.current?.dispose()
    const declarations = buildBareModuleDeclarations(moduleUsage)
    extraLibDisposableRef.current = monaco.languages.typescript.typescriptDefaults.addExtraLib(
      declarations,
      'inmemory://model/inspector-external-modules.d.ts'
    )
  }

  // ── Monaco undo/redo wrapper ─────────────────────────────────────────────────
  // Writes a new full-source snapshot into the Monaco model as a single undoable
  // edit, updates fullSourceRef, re-syncs bindings, then immediately persists to
  // disk.  All bindings mutations funnel through here so Monaco's history covers
  // prop/attr adds, deletes and value changes without any custom stack.

  /**
   * Ask Vite to flush its transform cache for one or more files, then trigger
   * a preview remount. Must be called AFTER the files are written to disk.
   *
   * The `/__cockpit/invalidate` endpoint (served directly by the Vite plugin,
   * not proxied to Express) calls `server.moduleGraph.invalidateModule()` so
   * the very next dynamic import gets fresh content from disk rather than a
   * stale cached transform. The `?t=` timestamp in the import URL then busts
   * the browser's own module registry for good measure.
   */
  async function invalidateAndRefresh(files: string[]): Promise<void> {
    await Promise.all(
      files.map((f) =>
        fetch(`/__cockpit/invalidate?file=${encodeURIComponent(f)}`).catch(() => {/* best-effort */})
      )
    )
    notifyPreviewRefresh()
  }

  async function pushToMonacoAndSave(newFullSource: string): Promise<boolean> {
    fullSourceRef.current = newFullSource

    // Update Monaco model — this creates an undo point.
    const ed = editorRef.current
    const model = ed?.getModel()
    if (ed && model) {
      const newBlockContent = (() => {
        const r = blockRangeRef.current
        if (!r) return newFullSource
        return newFullSource.split('\n').slice(r.startLine, r.endLine + 1).join('\n')
      })()
      const fullRange = model.getFullModelRange()
      model.pushEditOperations(
        [],
        [{ range: fullRange, text: newBlockContent }],
        () => null
      )
      setDisplayCode(newBlockContent)
      // Keep blockRangeRef in sync with the new block's actual line count so that
      // buildFullSourceFromEditorValue always splices the correct tail from fullSourceRef.
      if (blockRangeRef.current) {
        const newLineCount = newBlockContent.split('\n').length
        blockRangeRef.current = {
          startLine: blockRangeRef.current.startLine,
          endLine: blockRangeRef.current.startLine + newLineCount - 1,
        }
      }
    }

    // Persist to disk.
    try {
      const res = await fetch('/__source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, content: newFullSource }),
      })
      if (!res.ok) { setSaveStatus('error'); return false }
      setSaveStatus('saved')
      refreshBindings(newFullSource, selectedNode)
      void invalidateAndRefresh([file])
      return true
    } catch {
      setSaveStatus('error')
      return false
    }
  }

  function triggerUndo() {
    const ed = editorRef.current
    if (!ed) return
    ed.trigger('keyboard', 'undo', null)
    const model = ed.getModel()
    if (model) {
      const newFull = buildFullSourceFromEditorValue(model.getValue())
      fullSourceRef.current = newFull
      const newBlockContent = (() => {
        const r = blockRangeRef.current
        if (!r) return newFull
        return newFull.split('\n').slice(r.startLine, r.endLine + 1).join('\n')
      })()
      setDisplayCode(newBlockContent)
      refreshBindings(newFull, selectedNode)
      void (async () => {
        const res = await fetch('/__source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file, content: newFull }),
        })
        if (res.ok) setSaveStatus('saved')
      })()
    }
  }

  function triggerRedo() {
    const ed = editorRef.current
    if (!ed) return
    ed.trigger('keyboard', 'redo', null)
    const model = ed.getModel()
    if (model) {
      const newFull = buildFullSourceFromEditorValue(model.getValue())
      fullSourceRef.current = newFull
      const newBlockContent = (() => {
        const r = blockRangeRef.current
        if (!r) return newFull
        return newFull.split('\n').slice(r.startLine, r.endLine + 1).join('\n')
      })()
      setDisplayCode(newBlockContent)
      refreshBindings(newFull, selectedNode)
      void (async () => {
        const res = await fetch('/__source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file, content: newFull }),
        })
        if (res.ok) setSaveStatus('saved')
      })()
    }
  }

  // ── bindings: extract attrs + owner props from source after node selection ──
  // Called after source is loaded OR after selectedNode changes.
  function refreshBindings(source: string, node: SelectedNodeContext | null | undefined) {
    setPendingDiff(null)
    if (!node) {
      setJsxAttrs([])
      setOwnerProps([])
      setAttrEdits({})
      setAttrModes({})
      setTextChildModes({})
      setPropDefaultMode({})
      setInspectingComponent(false)
      setHasPropTypeDef(true)
      setScopeLayers([])
      setBindingsLoading(false)
      return
    }

    // Clear stale data immediately and show loader
    setBindingsLoading(true)
    setJsxAttrs([])
    setOwnerProps([])
    setAttrEdits({})
    setAttrModes({})
    setTextChildModes({})
    setPropDefaultMode({})
    setPropTypeEdits({})
    setPropValueEdits({})
    setPropDefaultEdits({})
    setExpandedRows(new Set())
    setPropValueMode({})
    setUsageAttrs([])
    setParentLocals([])
    setParentSource('')
    setParentComponentName('')
    setUsageInfo(null)
    setTextChildren([])
    setTextChildEdits({})

    // A capitalised tag means the tree selected a React component node, not a raw DOM element.
    const isComponentNode = /^[A-Z]/.test(node.tag)
    setInspectingComponent(isComponentNode)

    if (isComponentNode) {
      // ── component-usage mode ───────────────────────────────────────────────
      // source = page/usage file; attrs are directly available; own component
      // file (locatorFile) must be fetched separately for declared props.
      if (inspectMode === 'component-usage') {
        const tag = node.tag
        const usageLineHere = line
        const rawAttrsHere = extractJsxAttrs(source, usageLineHere)
        const slotChildrenHere = extractJsxTextChildren(source, usageLineHere)
        const usageAttrsHere: JsxAttr[] = rawAttrsHere.some(a => a.name === 'children') || slotChildrenHere.length === 0
          ? rawAttrsHere
          : [...rawAttrsHere, {
              name: 'children',
              rawValue: slotChildrenHere.map(c => c.value.trim()).filter(Boolean).join(' '),
              isExpression: slotChildrenHere.length === 1 && slotChildrenHere[0].kind === 'expr',
              isBoolean: false, isSpread: false,
              startLine: slotChildrenHere[0].startLine,
            }]
        const locatorFile = node.locatorFile
        void (async () => {
          let ownSource = ''
          if (locatorFile) {
            try {
              const res = await fetch(`/__source?file=${encodeURIComponent(locatorFile)}`)
              if (res.ok) ownSource = await res.text()
            } catch { /* skip */ }
          }
          const ownerP = ownSource ? extractOwnerProps(ownSource, tag) : []
          setOwnerProps(ownerP)
          setHasPropTypeDef(ownSource ? componentHasPropTypeDef(ownSource, tag) : true)
          // Always set usageInfo so saves work even when the element has no attrs yet.
          setUsageAttrs(usageAttrsHere)
          setUsageInfo({ file, line: usageLineHere })
          // Store slot children so save/clear can rewrite them correctly.
          setTextChildren(slotChildrenHere)
          const initModes: Record<string, 'scope' | 'expression' | 'value'> = {}
          for (const a of usageAttrsHere) {
            if (!a.isSpread) initModes[a.name] = a.isExpression ? 'expression' : 'value'
          }
          setPropValueMode(initModes)
          // Build scope layers using page source for parent, own source for child.
          const allUsed = ownSource ? collectAllJsxExpressionIdentifiers(ownSource, tag) : new Set<string>()
          const childProps = ownerP.filter(p => p.source === 'owner')
            .map(p => ({ name: p.name, typeStr: p.typeStr, usedInNode: allUsed.has(p.name), defaultValue: p.defaultValue }))
          const childState = ownSource
            ? extractComponentLocals(ownSource, tag)
                .filter(n => !ownerP.find(p => p.name === n))
                .map(n => ({ name: n, typeStr: inferTypeOfLocal(ownSource, tag, n), usedInNode: allUsed.has(n) }))
            : []
          const parentName = inferOwnerComponentName(source, usageLineHere)
          if (parentName) {
            const passedValues = new Set(
              usageAttrsHere.filter(a => !a.isSpread).flatMap(a => {
                const stripped = a.rawValue.replace(/^\{|\}$/g, '').trim()
                const base = stripped.split(/[.\[(]/)[0].trim()
                return base && base !== stripped ? [stripped, base] : [stripped]
              })
            )
            const pLocals = extractComponentLocals(source, parentName)
            setParentLocals(pLocals)
            setParentSource(source)
            setParentComponentName(parentName)
            const parentPropsArr = extractOwnerProps(source, parentName)
            const parentPropItems = parentPropsArr.filter(p => p.source === 'owner')
              .map(p => ({ name: p.name, typeStr: p.typeStr, usedInNode: passedValues.has(p.name), defaultValue: p.defaultValue }))
            const parentStateItems = pLocals
              .filter(n => !parentPropsArr.find(p => p.name === n))
              .map(n => ({ name: n, typeStr: inferTypeOfLocal(source, parentName, n), usedInNode: passedValues.has(n) }))
            const links = usageAttrsHere.filter(a => !a.isSpread && a.isExpression)
              .map(a => ({ parentVar: a.rawValue.replace(/^\{|\}$/g, '').trim().split(/[.\[(]/)[0], childProp: a.name }))
              .filter(l => l.parentVar)
            setScopeLayers([
              { componentName: parentName, isCurrent: false, props: parentPropItems, state: parentStateItems },
              { componentName: tag, isCurrent: true, props: childProps, state: childState, links },
            ])
          } else {
            setScopeLayers([{ componentName: tag, isCurrent: true, props: childProps, state: childState }])
          }
          setBindingsLoading(false)
        })()
        return
      }

      // Show the component's own declared props (signature + interface/type).
      // No JSX attr extraction needed — we don't have the usage-site source here.
      const ownerP = extractOwnerProps(source, node.tag)
      setOwnerProps(ownerP)
      setHasPropTypeDef(componentHasPropTypeDef(source, node.tag))
    // Component mode: build an initial scope layer from just the child's own props (no usage data yet).
    const ownerPCapture = ownerP
    const sourceCapture = source
    const tagCapture = node.tag
    // Highlight props that are referenced anywhere as JSX expression values in this component's source.
    const allUsed = collectAllJsxExpressionIdentifiers(sourceCapture, tagCapture)
    const initialChildProps = ownerPCapture.filter(p => p.source === 'owner').map(p => ({ name: p.name, typeStr: p.typeStr, usedInNode: allUsed.has(p.name), defaultValue: p.defaultValue }))
    const initialChildState = extractComponentLocals(sourceCapture, tagCapture)
      .filter(n => !ownerPCapture.find(p => p.name === n))
      .map(n => ({ name: n, typeStr: inferTypeOfLocal(sourceCapture, tagCapture, n), usedInNode: allUsed.has(n) }))
    const isRootComp = tagCapture === rootComponentName
    const rootVarNamesComp = new Set([...initialChildProps.map(p => p.name), ...initialChildState.map(s => s.name)])
    const childBindingsComp = isRootComp ? extractChildBindings(sourceCapture, tagCapture, rootVarNamesComp) : undefined
    setScopeLayers([{
      componentName: tagCapture,
      isCurrent: true,
      props: initialChildProps,
      state: initialChildState,
      childBindings: childBindingsComp,
    }])
      // Asynchronously find the usage site of this component to:
      // 1. populate the "currently passed" value column
      // 2. build the parent scope layer
      // Use fiber-supplied ownerFile/ownerLine first; fall back to locatorjs.
      const tag = node.tag
      const directOwnerFile = node.ownerFile ?? null
      const directOwnerLine = node.ownerLine ?? null
      void (async () => {
        const usages: Array<{ file: string; line: number }> =
          directOwnerFile && directOwnerLine
            ? [{ file: directOwnerFile, line: directOwnerLine }]
            : findLocatorUsages(tag)
        if (usages.length === 0) { setBindingsLoading(false); return }
        // Try each usage file until we get a non-empty attr set.
        for (const { file: usageFile, line: usageLine } of usages) {
          try {
            const usageFetchT0 = performance.now()
            const res = await fetch(`/__source?file=${encodeURIComponent(usageFile)}`)
            console.log(`[inspector] fetch usage-file ${(performance.now() - usageFetchT0).toFixed(1)}ms  ${usageFile.replace(/.*[/\\]/, '')}`)
            if (!res.ok) continue
            const usageSource = await res.text()
            const rawAttrs = extractJsxAttrs(usageSource, usageLine)
            // Synthesize a 'children' attr from JSX slot text/expression children when not already an explicit attr.
            const slotChildren = extractJsxTextChildren(usageSource, usageLine)
            const attrs: JsxAttr[] = rawAttrs.some(a => a.name === 'children') || slotChildren.length === 0
              ? rawAttrs
              : [...rawAttrs, {
                  name: 'children',
                  rawValue: slotChildren.map(c => c.value.trim()).filter(Boolean).join(' '),
                  isExpression: slotChildren.length === 1 && slotChildren[0].kind === 'expr',
                  isBoolean: false, isSpread: false,
                  startLine: slotChildren[0].startLine,
                }]
            if (attrs.length > 0 || slotChildren.length > 0) {
              setUsageAttrs(attrs)
              setUsageInfo({ file: usageFile, line: usageLine })
              // Initialize per-prop value mode from whether the attr is currently an expression.
              const initModes: Record<string, 'scope' | 'expression' | 'value'> = {}
              for (const a of attrs) {
                if (!a.isSpread) initModes[a.name] = a.isExpression ? 'expression' : 'value'
              }
              setPropValueMode(initModes)
              // Extract local variables from the wrapping component in the parent file.
              const parentName = inferOwnerComponentName(usageSource, usageLine)
              if (parentName) {
                const pLocals = extractComponentLocals(usageSource, parentName)
                setParentLocals(pLocals)
                setParentSource(usageSource)
                setParentComponentName(parentName)
                // Rebuild scope layers now that we have parent data.
                const passedNames = new Set(attrs.filter(a => !a.isSpread).map(a => a.name))
                const passedValues = new Set(
                  attrs.filter(a => !a.isSpread).flatMap(a => {
                    const stripped = a.rawValue.replace(/^\{|\}$/g, '').trim()
                    // Extract all identifier-like tokens so ternaries like `loading?'A':'B'` register `loading`
                    return [...stripped.matchAll(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g)].map(m => m[1])
                  })
                )
                const childProps = ownerPCapture.filter(p => p.source === 'owner')
                  .map(p => ({ name: p.name, typeStr: p.typeStr, usedInNode: allUsed.has(p.name), defaultValue: p.defaultValue }))
                const childState = extractComponentLocals(sourceCapture, tagCapture)
                  .filter(n => !ownerPCapture.find(p => p.name === n))
                  .map(n => ({ name: n, typeStr: inferTypeOfLocal(sourceCapture, tagCapture, n), usedInNode: allUsed.has(n) }))
                const parentPropsArr = extractOwnerProps(usageSource, parentName)
                const parentPropItems = parentPropsArr.filter(p => p.source === 'owner')
                  .map(p => ({ name: p.name, typeStr: p.typeStr, usedInNode: passedValues.has(p.name), defaultValue: p.defaultValue }))
                const parentStateItems = pLocals
                  .filter(n => !parentPropsArr.find(p => p.name === n))
                  .map(n => ({ name: n, typeStr: inferTypeOfLocal(usageSource, parentName, n), usedInNode: passedValues.has(n) }))
                // Build binding links: parentVar → childProp
                const links = attrs.filter(a => !a.isSpread && a.isExpression)
                  .map(a => ({
                    parentVar: /^([a-zA-Z_$][a-zA-Z0-9_$]*)/.exec(a.rawValue.replace(/^\{|\}$/g, '').trim())?.[1] ?? '',
                    childProp: a.name,
                  }))
                  .filter(l => l.parentVar)
                setScopeLayers([
                  { componentName: parentName, isCurrent: false, props: parentPropItems, state: parentStateItems },
                  { componentName: tagCapture, isCurrent: true, props: childProps, state: childState, links },
                ])
              }
              break
            }
          } catch { /* skip */ }
        }
        setBindingsLoading(false)
      })()
      return
    }

    // DOM node: extract JSX attrs at the locator line + owner props for the dropdown.
    const locLine = node.locatorLine ?? line
    const attrs = extractJsxAttrs(source, locLine)
    setJsxAttrs(attrs)

    const initialEdits: Record<string, string> = {}
    const initialModes: Record<string, 'value' | 'expression' | 'scope'> = {}
    for (const a of attrs) {
      if (!a.isSpread) {
        initialEdits[a.name] = a.rawValue
        initialModes[a.name] = a.isExpression ? 'scope' : 'value'
      }
    }
    setAttrEdits(initialEdits)
    setAttrModes(initialModes)
    setExpandedRows(new Set())
    setFocusedAttr(null)

    const tChildren = extractJsxTextChildren(source, locLine)
    setTextChildren(tChildren)
    setTextChildEdits({})

    const ownerName = node.ownerComponentName ?? componentName
      ?? (node.locatorFile ? inferOwnerComponentName(source, locLine) : '')
    const ownerP = ownerName ? extractOwnerProps(source, ownerName) : []

    // Merge: element-bound attrs not already in owner props become extra dropdown options.
    const elementOnly: ComponentProp[] = attrs
      .filter((a) => !a.isSpread && !ownerP.find((p) => p.name === a.name))
      .map((a) => ({ name: a.name, typeStr: '', source: 'element' as const }))

    setOwnerProps([...ownerP, ...elementOnly])

    // Build scope layers for the hierarchy panel.
    // usedNames: variable names referenced by this node's attrs (strip {}, also extract base
    // identifier from member-access expressions like {formData.email} → 'formData').
    const usedNames = new Set(
      attrs.filter(a => !a.isSpread).flatMap(a => {
        const stripped = a.rawValue.replace(/^\{|\}$/g, '').trim()
        const base = stripped.split(/[.\[(]/)[0].trim()
        return base && base !== stripped ? [stripped, base] : [stripped]
      })
    )
    const makeItems = (props: ComponentProp[], localNames: string[], src: string, compName: string): { props: ScopeItem[]; state: ScopeItem[] } => {
      const propItems: ScopeItem[] = props
        .filter(p => p.source === 'owner')
        .map(p => ({ name: p.name, typeStr: p.typeStr, usedInNode: usedNames.has(p.name), defaultValue: p.defaultValue }))
      const stateItems: ScopeItem[] = localNames
        .filter(n => !props.find(p => p.name === n))
        .map(n => ({ name: n, typeStr: inferTypeOfLocal(src, compName, n), usedInNode: usedNames.has(n) }))
      return { props: propItems, state: stateItems }
    }
    const ownerLocals = ownerName ? extractComponentLocals(source, ownerName) : []
    const { props: op, state: os } = makeItems(ownerP, ownerLocals, source, ownerName)
    // For the root component, compute downstream child bindings synchronously.
    const isRoot = !ownerName || ownerName === rootComponentName
    const rootVarNames = new Set([...op.map(p => p.name), ...os.map(s => s.name)])
    const childBindings = isRoot && ownerName ? extractChildBindings(source, ownerName, rootVarNames) : undefined
    setScopeLayers([{ componentName: ownerName || node.tag, isCurrent: true, props: op, state: os, childBindings }])
    setHasPropTypeDef(true) // DOM nodes don't need prop type defs
    setBindingsLoading(false)

    // Async: add a parent scope layer using React fiber ownerFile/ownerLine data
    // (direct, no locatorjs dependency). Fall back to findLocatorUsages if missing.
    // Skip if ownerName is the root component (no meaningful parent to show).
    if (ownerName && ownerName !== rootComponentName) {
      const ownerNameCapture = ownerName
      const directOwnerFile = node.ownerFile ?? null
      const directOwnerLine = node.ownerLine ?? null
      // Never use builder-app files as parent scope sources — ComponentLoader.tsx calls
      // the page component, so its ownerFile points there rather than any project file.
      const isBuilderOwnerFile = !!directOwnerFile && directOwnerFile.toLowerCase().replace(/\\/g, '/').includes('builder-app/src/')
      const candidateUsages: Array<{ file: string; line: number }> =
        directOwnerFile && directOwnerLine && !isBuilderOwnerFile
          ? [{ file: directOwnerFile, line: directOwnerLine }]
          : findLocatorUsages(ownerNameCapture)
      void (async () => {
        for (const { file: usageFile, line: usageLine } of candidateUsages) {
          try {
            const res = await fetch(`/__source?file=${encodeURIComponent(usageFile)}`)
            if (!res.ok) continue
            const usageSource = await res.text()
            const parentName = inferOwnerComponentName(usageSource, usageLine)
            if (!parentName) continue
            const parentPropsArr = extractOwnerProps(usageSource, parentName)
            const parentLocalsArr = extractComponentLocals(usageSource, parentName)
            // What values are passed to ownerName at this usage site?
            const passedToOwner = extractJsxAttrs(usageSource, usageLine)
            const passedValues = new Set(
              passedToOwner.filter(a => !a.isSpread).flatMap(a => {
                const stripped = a.rawValue.replace(/^\{|\}$/g, '').trim()
                return [...stripped.matchAll(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g)].map(m => m[1])
              })
            )
            const parentPropItems = parentPropsArr.filter(p => p.source === 'owner')
              .map(p => ({ name: p.name, typeStr: p.typeStr, usedInNode: passedValues.has(p.name), defaultValue: p.defaultValue }))
            const parentStateItems = parentLocalsArr
              .filter(n => !parentPropsArr.find(p => p.name === n))
              .map(n => ({ name: n, typeStr: inferTypeOfLocal(usageSource, parentName, n), usedInNode: passedValues.has(n) }))
            // Build binding links: parentVar → childProp
            const links = passedToOwner.filter(a => !a.isSpread && a.isExpression)
              .map(a => ({
                parentVar: /^([a-zA-Z_$][a-zA-Z0-9_$]*)/.exec(a.rawValue.replace(/^\{|\}$/g, '').trim())?.[1] ?? '',
                childProp: a.name,
              }))
              .filter(l => l.parentVar)
            setParentSource(usageSource)
            setParentLocals(parentLocalsArr)
            setParentComponentName(parentName)
            setScopeLayers([
              { componentName: parentName, isCurrent: false, props: parentPropItems, state: parentStateItems },
              { componentName: ownerNameCapture, isCurrent: true, props: op, state: os, links },
            ])
            break
          } catch { /* skip */ }
        }
      })()
    }
  }

  function applyBlock(source: string, targetLine: number) {
    const block = extractBlock(source, targetLine, { inspectMode, componentName })
    const isFileMode = inspectMode === 'file'
    blockRangeRef.current = block.range
    setBlockName(block.name)
    setDisplayCode(block.code)
    lastValidSourceRef.current = block.code
    // Scroll to the clicked line but don't select anything.
    requestAnimationFrame(() => {
      const ed = editorRef.current
      const monaco = monacoRef.current
      if (!ed || !monaco) return
      const lineInModel = isFileMode
        ? Math.max(targetLine, 1)
        : Math.max(targetLine - block.range.startLine, 1)
      ed.revealLineInCenter(lineInModel)
      ed.deltaDecorations([], [{
        range: new monaco.Range(lineInModel, 1, lineInModel, 1),
        options: { isWholeLine: true, className: 'highlighted-line' },
      }])
    })
  }

  useEffect(() => {
    if (!file) return
    setSaveStatus('idle')
    if (file !== prevFileRef.current) {
      // New file — fetch then extract.
      prevFileRef.current = file
      setLoading(true)
      setBindingsLoading(true)
      setBlockName(componentName ?? '')
      // Clear stale source/bindings immediately so Monaco doesn't show the
      // previous file's content while the new one is in flight.
      fullSourceRef.current = ''
      setDisplayCode('')
      // Scroll to top immediately so the old scroll position doesn't persist.
      editorRef.current?.revealLine(1)
      // Cancel any in-flight fetch from a previous file switch.
      fetchAbortRef.current?.abort()
      const abortCtrl = new AbortController()
      fetchAbortRef.current = abortCtrl
      const fetchT0 = performance.now()
      fetch(`/__source?file=${encodeURIComponent(file)}`, { signal: abortCtrl.signal })
        .then((r) => {
          console.log(`[inspector] fetch /__source ${(performance.now() - fetchT0).toFixed(1)}ms  status=${r.status}`)
          if (!r.ok) throw new Error(`Server error ${r.status}`)
          return r.text()
        })
        .then((text) => {
          const parseT0 = performance.now()
          fullSourceRef.current = text
          setFileImports(extractImports(text))
          setMultipleComponentsInFile(countReactComponentsInSource(text) > 1)
          void syncContextModels(file, text)
          scheduleDiagnostics(file, text)
          applyBlock(text, line)
          refreshBindings(text, selectedNode)
          console.log(`[inspector] parse+refreshBindings ${(performance.now() - parseT0).toFixed(1)}ms`)
          // Load stored diff from the last agent write (if any).
          fetch(`/__source/diff?file=${encodeURIComponent(file)}`)
            .then((r) => r.ok ? r.json() : null)
            .then((diff: { original: string; modified: string } | null) => {
              if (diff && diff.original !== diff.modified) {
                setPendingDiff({ entries: [{ file, original: diff.original, modified: diff.modified }], summary: ['Last agent write'] })
                setExpandedDiffFiles(new Set([0]))
                if (inspectMode === 'file') setActiveTab('changes')
              }
            })
            .catch(() => {})
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === 'AbortError') return
          setDisplayCode(`// Error loading file\n// ${err.message}`)
        })
        .finally(() => setLoading(false))
    } else if (fullSourceRef.current) {
      // Same file, different element — re-extract without a network round-trip.
      setMultipleComponentsInFile(countReactComponentsInSource(fullSourceRef.current) > 1)
      void syncContextModels(file, fullSourceRef.current)
      scheduleDiagnostics(file, fullSourceRef.current)
      applyBlock(fullSourceRef.current, line)
      refreshBindings(fullSourceRef.current, selectedNode)
    } else {
      setFileImports([])
    }
  }, [file, line, inspectMode, componentName]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-run bindings extraction when selectedNode changes (DOM selection in tree)
  // without re-fetching source.
  useEffect(() => {
    if (fullSourceRef.current) refreshBindings(fullSourceRef.current, selectedNode)
    if (!selectedNode) return
    setActiveTab('bindings')
    setCodeExpanded(true)
  }, [selectedNode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep Monaco readOnly in sync when the selected node changes
  const sourceReadOnly = !isRootComponent && inspectingComponent && isFromComponentsFolder && inspectMode !== 'component-usage'
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: sourceReadOnly })
  }, [sourceReadOnly])

  // Sync local prop display order whenever ownerProps is refreshed (e.g. after save or selection change).
  useEffect(() => {
    setPropOrder(ownerProps.filter(p => p.source === 'owner').map(p => p.name))
  }, [ownerProps])

  useEffect(() => {
    return () => {
      modelChangeDisposableRef.current?.dispose()
      extraLibDisposableRef.current?.dispose()
      if (diagnosticsTimerRef.current != null) {
        window.clearTimeout(diagnosticsTimerRef.current)
      }
    }
  }, [])

  // ── bindings mutations — all route through pushToMonacoAndSave ─────────────

  /** Clears the value passed to a child component prop at the usage site (removes the JSX attr). */
  async function handleClearPropValue(propName: string) {
    if (!usageInfo) return
    setDeletingProp(propName)
    try {
      const res = await fetch(`/__source?file=${encodeURIComponent(usageInfo.file)}`)
      if (!res.ok) return
      const src = await res.text()
      // 'children' as a slot text child cannot be safely cleared — bail out.
      if (propName === 'children' && textChildren.length > 0) return
      const updated = removeAttr(src, usageInfo.line, propName)
      if (usageInfo.file === file) {
        await pushToMonacoAndSave(updated)
      } else {
        await fetch('/__source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: usageInfo.file, content: updated }),
        })
        setSaveStatus('saved')
        void invalidateAndRefresh([usageInfo.file])
      }
      setUsageAttrs(extractJsxAttrs(updated, usageInfo.line))
      setPropValueEdits(prev => { const n = { ...prev }; delete n[propName]; return n })
    } finally {
      setDeletingProp(null)
    }
  }

  async function handleDeleteProp(propName: string) {
    setDeletingProp(propName)
    try {
      const freshRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
      if (!freshRes.ok) return
      let modified = await freshRes.text()

      const ownerName = selectedNode?.ownerComponentName ?? componentName ?? ''
      if (inspectingComponent) {
        // Remove from signature + interface, then remove all {propName} usages in JSX body.
        if (ownerName) {
          modified = removePropFromOwnerSignature(modified, ownerName, propName)
          modified = removePropUsagesInBody(modified, ownerName, propName)
        }
      } else {
        // Remove the JSX attribute from the element.
        const attrInfo = jsxAttrs.find(a => a.name === propName)
        modified = removeAttr(modified, selectedNode?.locatorLine ?? line, propName)
        // If the removed attribute was a direct prop reference (value={propName}),
        // also remove the prop from the owner component's signature.
        if (ownerName && attrInfo && attrInfo.isExpression && !attrInfo.isSpread && attrInfo.rawValue === propName) {
          modified = removePropFromOwnerSignature(modified, ownerName, propName)
        }
      }
      await pushToMonacoAndSave(modified)
    } finally {
      setDeletingProp(null)
    }
  }

  // ── Scope panel: add/remove prop ───────────────────────────────────────────
  function handleScopeAddProp(_componentName: string) {
    // Open the existing "Add prop" form (in the props or bindings tab).
    setShowAddProp(true)
    // Switch to a tab that shows the add-prop form.
    if (isRootComponent) {
      setActiveTab('props')
    } else {
      setActiveTab('bindings')
    }
  }

  async function handleScopeRemoveProp(targetComponent: string, propName: string) {
    const freshRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
    if (!freshRes.ok) return
    let modified = await freshRes.text()
    modified = removePropFromOwnerSignature(modified, targetComponent, propName)
    modified = removePropUsagesInBody(modified, targetComponent, propName)
    await pushToMonacoAndSave(modified)
  }

  // ── Scope panel: add/remove state ──────────────────────────────────────────
  function handleScopeAddState(_componentName: string) {
    setAddStateOpen(true)
    setNewStateName('')
    setNewStateInitial('')
    setNewStateHook('useState')
  }

  async function handleScopeRemoveState(targetComponent: string, varName: string) {
    const ownerName = targetComponent || (selectedNode?.ownerComponentName ?? selectedNode?.tag ?? componentName ?? '')
    const freshRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
    if (!freshRes.ok) return
    let modified = await freshRes.text()
    modified = removeStateVariable(modified, ownerName, varName)
    await pushToMonacoAndSave(modified)
  }

  async function handleCreateState() {
    const name = newStateName.trim()
    if (!name || !/^[a-zA-Z_$][\w$]*$/.test(name)) return
    const currentLayer = scopeLayers.find(l => l.isCurrent)
    const ownerName = currentLayer?.componentName ?? selectedNode?.ownerComponentName ?? selectedNode?.tag ?? componentName ?? ''
    const freshRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
    if (!freshRes.ok) return
    let modified = await freshRes.text()
    modified = addStateVariable(modified, ownerName, name, newStateInitial.trim() || (newStateHook === 'useRef' ? 'null' : "''"), newStateHook)
    const ok = await pushToMonacoAndSave(modified)
    if (ok) {
      setAddStateOpen(false)
      setNewStateName('')
      setNewStateInitial('')
      setNewStateHook('useState')
    }
  }

  async function handlePropTypeSave() {
    const propOrderChanged = propOrder.length > 0 && propOrder.some((name, i) => ownerProps.filter(p => p.source === 'owner')[i]?.name !== name)
    if (!fullSourceRef.current || (Object.keys(propTypeEdits).length === 0 && Object.keys(propValueEdits).length === 0 && Object.keys(propDefaultEdits).length === 0 && !propOrderChanged)) return
    // Snapshot edits immediately and clear state to prevent double-saves on rapid clicks.
    const valueEditsSnapshot = { ...propValueEdits }
    const typeEditsSnapshot = { ...propTypeEdits }
    const defaultEditsSnapshot = { ...propDefaultEdits }
    const propOrderSnapshot = [...propOrder]
    const propOrderChangedSnapshot = propOrderChanged
    setPropValueEdits({})
    setPropTypeEdits({})
    setPropDefaultEdits({})
    setBindingsSaving(true)
    try {
      const ownerName = selectedNode?.ownerComponentName ?? componentName ?? ''

      // ── Value edits: write to the PARENT file's JSX usage site ─────────────
      if (Object.keys(valueEditsSnapshot).length > 0 && usageInfo) {
        const parentRes = await fetch(`/__source?file=${encodeURIComponent(usageInfo.file)}`)
        if (!parentRes.ok) throw new Error('Fetch parent failed')
        let parentSrc = await parentRes.text()
        for (const [propName, newVal] of Object.entries(valueEditsSnapshot)) {
          const original = usageAttrs.find((a) => a.name === propName)
          // Skip if unchanged from what the parent is already passing.
          if (original && newVal === original.rawValue) continue
          // Use propValueMode to determine whether to write as expression or string literal.
          const propMode = propValueMode[propName] ?? (original?.isExpression ? 'expression' : 'value')
          const modeIsVar = propMode === 'scope' || propMode === 'expression'
          // 'children' as a text node — only when staying in plain-value mode.
          if (propName === 'children' && textChildren.length > 0 && !modeIsVar) {
            for (const tc of textChildren) {
              // The JSXText node may span multiple lines (e.g. "\n  Sign in\n").
              // Search all lines in the span for the actual trimmed content.
              const trimmedOld = tc.value.trim()
              if (!trimmedOld) continue
              const srcLines = parentSrc.split('\n')
              let found = false
              for (let li = tc.startLine; li <= tc.endLine; li++) {
                const ln = srcLines[li] ?? ''
                const col = li === tc.startLine ? tc.startCol : 0
                const idx = ln.indexOf(trimmedOld, col)
                if (idx !== -1) {
                  srcLines[li] = ln.slice(0, idx) + newVal + ln.slice(idx + trimmedOld.length)
                  parentSrc = srcLines.join('\n')
                  found = true
                  break
                }
              }
              if (!found) {
                parentSrc = rewriteJsxTextChild(parentSrc, tc, newVal)
              }
            }
            continue
          }
          // 'children' switching from text-node to expression — replace content between tags with {expr}
          if (propName === 'children' && textChildren.length > 0 && modeIsVar) {
            parentSrc = rewriteJsxChildrenAsExpression(parentSrc, usageInfo.line, newVal)
            continue
          }
          if (original) {
            parentSrc = rewriteAttrValue(parentSrc, usageInfo.line, propName, newVal, modeIsVar)
          } else {
            // Attr was cleared (or never set) — insert it fresh.
            parentSrc = insertAttr(parentSrc, usageInfo.line, propName, newVal, modeIsVar)
          }
        }
        // Persist parent file — if it's the same file being viewed (component-usage mode),
        // route through Monaco so the editor, fullSourceRef, blockRangeRef and preview stay in sync.
        if (usageInfo.file === file) {
          const ok = await pushToMonacoAndSave(parentSrc)
          if (!ok) return
        } else {
          const res = await fetch('/__source', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: usageInfo.file, content: parentSrc }),
          })
          if (!res.ok) throw new Error('Save failed')
          setSaveStatus('saved')
          void invalidateAndRefresh([usageInfo.file])
        }
        // Refresh usageAttrs from the updated source — re-synthesize slot children entry.
        const refreshedRawAttrs = extractJsxAttrs(parentSrc, usageInfo.line)
        const refreshedSlotChildren = extractJsxTextChildren(parentSrc, usageInfo.line)
        const refreshedAttrs: JsxAttr[] = refreshedRawAttrs.some(a => a.name === 'children') || refreshedSlotChildren.length === 0
          ? refreshedRawAttrs
          : [...refreshedRawAttrs, {
              name: 'children',
              rawValue: refreshedSlotChildren.map(c => c.value.trim()).filter(Boolean).join(' '),
              isExpression: refreshedSlotChildren.length === 1 && refreshedSlotChildren[0].kind === 'expr',
              isBoolean: false, isSpread: false,
              startLine: refreshedSlotChildren[0].startLine,
            }]
        setUsageAttrs(refreshedAttrs)
        setTextChildren(refreshedSlotChildren)
      }

      // ── Type + default edits + reorder: write to the CHILD component file ──
      if (Object.keys(typeEditsSnapshot).length > 0 || Object.keys(defaultEditsSnapshot).length > 0 || propOrderChangedSnapshot) {
        const freshRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
        if (!freshRes.ok) throw new Error('Fetch failed')
        let modified = await freshRes.text()
        for (const [propName, newType] of Object.entries(typeEditsSnapshot)) {
          const original = ownerProps.find((p) => p.name === propName)
          if (!original || newType === original.typeStr) continue
          modified = rewritePropType(modified, ownerName, propName, newType)
        }
        for (const [propName, newDefault] of Object.entries(defaultEditsSnapshot)) {
          const original = ownerProps.find((p) => p.name === propName)
          if (newDefault === (original?.defaultValue ?? '')) continue
          modified = rewriteDefaultValue(modified, ownerName, propName, newDefault)
        }
        if (propOrderChangedSnapshot) {
          // Guard: if any prop's default value references a prop that would come after it,
          // the destructure would cause a temporal dead zone at runtime (JS evaluates
          // parameter defaults left-to-right; referencing a later param is a TDZ error).
          const ownerOrdered = propOrderSnapshot.map(n => ownerProps.find(p => p.name === n)).filter(Boolean)
          for (let i = 0; i < ownerOrdered.length; i++) {
            const p = ownerOrdered[i]!
            const defVal = defaultEditsSnapshot[p.name] ?? p.defaultValue ?? ''
            if (!defVal) continue
            for (let j = i + 1; j < ownerOrdered.length; j++) {
              const laterName = ownerOrdered[j]!.name
              // Simple identifier match: word boundary to avoid false positives
              if (new RegExp(`\\b${laterName}\\b`).test(defVal)) {
                const msg = `Reorder blocked: '${p.name}' default references '${laterName}' which would come after it — this would cause a runtime error (temporal dead zone).`
                setSaveErrorMsg(msg)
                setSaveStatus('error')
                console.error('%c[Cockpit] Save blocked%c\n' + msg, 'background:#f38ba8;color:#1e1e2e;font-weight:bold;padding:2px 6px;border-radius:4px', 'color:#f38ba8')
                setBindingsSaving(false)
                return
              }
            }
          }
          modified = reorderPropsInSource(modified, propOrderSnapshot)
        }
        // Diagnostics check — don't save if the modified source has TS errors.
        // Fast path: Monaco TS worker for syntactic errors only (no project types needed, instant).
        const monacoInst = monacoRef.current
        let diagBlocked = false
        if (monacoInst) {
          try {
            const tempUri = monacoInst.Uri.parse(`file:///cockpit-preflight-${Date.now()}.tsx`)
            const tempModel = monacoInst.editor.createModel(modified, 'typescript', tempUri)
            const getWorker = await monacoInst.languages.typescript.getTypeScriptWorker()
            const proxy = await getWorker(tempUri)
            const syntacticDiags = await proxy.getSyntacticDiagnostics(tempUri.toString())
            tempModel.dispose()
            if (syntacticDiags.length > 0) {
              const modLines = modified.split('\n')
              const offsetToLine = (offset: number) => {
                let rem = offset
                for (let i = 0; i < modLines.length; i++) {
                  if (rem <= modLines[i].length) return i + 1
                  rem -= modLines[i].length + 1
                }
                return modLines.length
              }
              const msg = syntacticDiags.map(d => {
                const text = typeof d.messageText === 'string' ? d.messageText : (d.messageText as { messageText: string }).messageText
                const ln = d.start != null ? offsetToLine(d.start) : '?'
                return `L${ln}: ${text}`
              }).join('\n')
              setSaveErrorMsg(msg)
              setSaveStatus('error')
              console.error('%c[Cockpit] Save blocked — TypeScript errors:%c\n' + msg, 'background:#f38ba8;color:#1e1e2e;font-weight:bold;padding:2px 6px;border-radius:4px', 'color:#f38ba8')
              diagBlocked = true
            }
          } catch {
            // Monaco worker unavailable — fall through to server check
          }
        }
        if (diagBlocked) { setBindingsSaving(false); return }
        // Slow path: server-side tsc for semantic / cross-file errors.
        // Skip when the only change is a reorder — existing props can't introduce new type errors.
        const hasContentEdits = Object.keys(typeEditsSnapshot).length > 0 || Object.keys(defaultEditsSnapshot).length > 0
        if (hasContentEdits) {
          try {
            const diagRes = await fetch('/__diagnostics', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ file, content: modified }),
            })
            if (diagRes.ok) {
              const diagPayload = await diagRes.json()
              const errs = ((diagPayload.diagnostics as ServerDiagnostic[]) ?? []).filter(d => d.severity >= 8)
              if (errs.length > 0) {
                const msg = errs.map(e => `L${e.startLineNumber}: ${e.message}`).join('\n')
                setSaveErrorMsg(msg)
                setSaveStatus('error')
                console.error('%c[Cockpit] Save blocked — TypeScript errors:%c\n' + msg, 'background:#f38ba8;color:#1e1e2e;font-weight:bold;padding:2px 6px;border-radius:4px', 'color:#f38ba8')
                setBindingsSaving(false)
                return
              }
            }
          } catch { /* if diagnostics endpoint is unavailable, proceed with save */ }
        }
        const ok = await pushToMonacoAndSave(modified)
        if (!ok) return
      }
    } catch {
      setSaveStatus('error')
    } finally {
      setBindingsSaving(false)
    }
  }

  async function handleBindingsSave() {
    if (!fullSourceRef.current) return
    setBindingsSaving(true)
    try {
      const freshRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
      if (!freshRes.ok) throw new Error('Fetch failed')
      let modified = await freshRes.text()
      const nodeLocLine = selectedNode?.locatorLine ?? line

      // Apply text-child edits first (in reverse order to preserve offsets)
      const textEditsToApply = textChildren
        .filter(c => textChildEdits[c.index] !== undefined && textChildEdits[c.index] !== c.value)
        .sort((a, b) => b.startLine - a.startLine || b.startCol - a.startCol)
      for (const child of textEditsToApply) {
        modified = rewriteJsxTextChild(modified, child, textChildEdits[child.index])
      }

      for (const [attrName, val] of Object.entries(attrEdits)) {
        const original = jsxAttrs.find((a) => a.name === attrName)
        if (!original) continue
        const mode = attrModes[attrName] ?? (original.isExpression ? 'expression' : 'value')
        const asExpr = mode === 'expression' || mode === 'scope'
        if (val === original.rawValue && asExpr === original.isExpression) continue
        modified = rewriteAttrValue(modified, nodeLocLine, attrName, val, asExpr)
      }
      await pushToMonacoAndSave(modified)
    } catch {
      setSaveStatus('error')
    } finally {
      setBindingsSaving(false)
    }
  }

  // ── Diff preview: compute changes without persisting ───────────────────────
  // These build a PendingDiff and show it in the Changes tab.

  const hasEdits = Object.keys(attrEdits).length > 0 || Object.keys(propTypeEdits).length > 0 || Object.keys(propValueEdits).length > 0 || Object.keys(propDefaultEdits).length > 0 || Object.keys(textChildEdits).length > 0

  async function computePendingDiff() {
    const hasPropEdits = Object.keys(propTypeEdits).length > 0 || Object.keys(propValueEdits).length > 0 || Object.keys(propDefaultEdits).length > 0
    const hasBindingEdits = Object.keys(attrEdits).length > 0 || Object.keys(textChildEdits).length > 0
    if (hasPropEdits) {
      await previewPropTypeSave()
    } else if (hasBindingEdits) {
      await previewBindingsSave()
    }
  }

  function countDiffLines(original: string, modified: string): { added: number; removed: number } {
    const origLines = original.split('\n')
    const modLines = modified.split('\n')
    let added = 0, removed = 0
    const maxLen = Math.max(origLines.length, modLines.length)
    for (let i = 0; i < maxLen; i++) {
      if (origLines[i] !== modLines[i]) {
        if (i < origLines.length) removed++
        if (i < modLines.length) added++
      }
    }
    return { added, removed }
  }

  async function previewPropTypeSave() {
    if (!fullSourceRef.current || (Object.keys(propTypeEdits).length === 0 && Object.keys(propValueEdits).length === 0 && Object.keys(propDefaultEdits).length === 0)) return
    setBindingsSaving(true)
    try {
      const ownerName = selectedNode?.ownerComponentName ?? componentName ?? ''
      const entries: PendingDiff['entries'] = []
      const summary: string[] = []

      // ── Value edits: diff for the PARENT file ─────────────
      if (Object.keys(propValueEdits).length > 0 && usageInfo) {
        const parentRes = await fetch(`/__source?file=${encodeURIComponent(usageInfo.file)}`)
        if (!parentRes.ok) throw new Error('Fetch parent failed')
        const originalParent = await parentRes.text()
        let parentSrc = originalParent
        for (const [propName, newVal] of Object.entries(propValueEdits)) {
          const original = usageAttrs.find((a) => a.name === propName)
          if (original && newVal === original.rawValue) continue
          const propMode = propValueMode[propName] ?? (original?.isExpression ? 'expression' : 'value')
          const modeIsVar = propMode === 'scope' || propMode === 'expression'
          parentSrc = rewriteAttrValue(parentSrc, usageInfo.line, propName, newVal, modeIsVar)
          summary.push(`Set ${propName}=${modeIsVar ? `{${newVal}}` : `"${newVal}"`}`)
        }
        if (parentSrc !== originalParent) {
          entries.push({ file: usageInfo.file, original: originalParent, modified: parentSrc })
        }
      }

      // ── Type + default edits: diff for the CHILD file ────────────
      if (Object.keys(propTypeEdits).length > 0 || Object.keys(propDefaultEdits).length > 0) {
        const freshRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
        if (!freshRes.ok) throw new Error('Fetch failed')
        const originalChild = await freshRes.text()
        let modified = originalChild
        for (const [propName, newType] of Object.entries(propTypeEdits)) {
          const original = ownerProps.find((p) => p.name === propName)
          if (!original || newType === original.typeStr) continue
          modified = rewritePropType(modified, ownerName, propName, newType)
          summary.push(`Change ${propName} type → ${newType}`)
        }
        for (const [propName, newDefault] of Object.entries(propDefaultEdits)) {
          const original = ownerProps.find((p) => p.name === propName)
          if (newDefault === (original?.defaultValue ?? '')) continue
          modified = rewriteDefaultValue(modified, ownerName, propName, newDefault)
          summary.push(`Set ${propName} default → ${newDefault || '(none)'}`)
        }
        if (modified !== originalChild) {
          entries.push({ file, original: originalChild, modified })
        }
      }

      if (entries.length > 0) {
        setPendingDiff({ entries, summary })
        setExpandedDiffFiles(new Set([0]))
        setActiveTab('changes')
      }
    } catch {
      setSaveStatus('error')
    } finally {
      setBindingsSaving(false)
    }
  }

  async function previewBindingsSave() {
    if (!fullSourceRef.current) return
    setBindingsSaving(true)
    try {
      const freshRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
      if (!freshRes.ok) throw new Error('Fetch failed')
      const originalSource = await freshRes.text()
      let modified = originalSource
      const nodeLocLine = selectedNode?.locatorLine ?? line
      const summary: string[] = []

      const textEditsToApply = textChildren
        .filter(c => textChildEdits[c.index] !== undefined && textChildEdits[c.index] !== c.value)
        .sort((a, b) => b.startLine - a.startLine || b.startCol - a.startCol)
      for (const child of textEditsToApply) {
        modified = rewriteJsxTextChild(modified, child, textChildEdits[child.index])
        summary.push(`Update text content → "${textChildEdits[child.index]}"`)
      }

      for (const [attrName, val] of Object.entries(attrEdits)) {
        const original = jsxAttrs.find((a) => a.name === attrName)
        if (!original) continue
        const mode = attrModes[attrName] ?? (original.isExpression ? 'expression' : 'value')
        const asExpr = mode === 'expression' || mode === 'scope'
        if (val === original.rawValue && asExpr === original.isExpression) continue
        modified = rewriteAttrValue(modified, nodeLocLine, attrName, val, asExpr)
        summary.push(`Set ${attrName}=${asExpr ? `{${val}}` : `"${val}"`}`)
      }

      if (modified !== originalSource) {
        setPendingDiff({ entries: [{ file, original: originalSource, modified }], summary })
        setExpandedDiffFiles(new Set([0]))
        setActiveTab('changes')
      }
    } catch {
      setSaveStatus('error')
    } finally {
      setBindingsSaving(false)
    }
  }

  async function applyPendingDiff() {
    if (!pendingDiff) return
    setBindingsSaving(true)
    try {
      for (const entry of pendingDiff.entries) {
        if (entry.file === file) {
          const ok = await pushToMonacoAndSave(entry.modified)
          if (!ok) return
        } else {
          const res = await fetch('/__source', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: entry.file, content: entry.modified }),
          })
          if (!res.ok) throw new Error('Save failed')
          if (usageInfo && entry.file === usageInfo.file) {
            setUsageAttrs(extractJsxAttrs(entry.modified, usageInfo.line))
          }
        }
      }
      setPropTypeEdits({})
      setPropValueEdits({})
      setPropDefaultEdits({})
      setAttrEdits({})
      setTextChildEdits({})
      setPendingDiff(null)
      setSaveStatus('saved')
      // Clear server-side diff so it doesn't reappear on reload.
      const allFiles = Array.from(new Set(pendingDiff.entries.map((e) => e.file)))
      await Promise.all(allFiles.map((f) =>
        fetch(`/__source/diff?file=${encodeURIComponent(f)}`, { method: 'DELETE' }).catch(() => {})
      ))
      // Invalidate Vite's transform cache for every file we just wrote, then
      // trigger a preview remount. `pushToMonacoAndSave` already handled the
      // main file.
      void invalidateAndRefresh(allFiles)
      if (activeTab === 'changes') setActiveTab('source')
    } catch {
      setSaveStatus('error')
    } finally {
      setBindingsSaving(false)
    }
  }

  function discardPendingDiff() {
    // Clear server-side diff so it doesn't reappear on reload.
    if (pendingDiff) {
      const files = Array.from(new Set(pendingDiff.entries.map((e) => e.file)))
      files.forEach((f) =>
        fetch(`/__source/diff?file=${encodeURIComponent(f)}`, { method: 'DELETE' }).catch(() => {})
      )
    }
    setPendingDiff(null)
    // Reset all edit state — forms will revert to original values
    setPropTypeEdits({})
    setPropValueEdits({})
    setPropDefaultEdits({})
    setAttrEdits({})
    setTextChildEdits({})
    setTextChildModes({})
    setAttrModes({})
    setPropValueMode({})
    setPropDefaultMode({})
    if (activeTab === 'changes') {
      const saved = sessionStorage.getItem('cockpit:activeTab')
      setActiveTab((saved === 'source' || saved === 'props' || saved === 'bindings') ? saved : 'bindings')
    }
  }

  async function handleRegisterPropTypes() {
    if (!inspectingComponent || !selectedNode) return
    const tag = selectedNode.tag
    const freshRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
    if (!freshRes.ok) return
    const source = await freshRes.text()
    try {
      const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
      const body = (ast.program as unknown as { body: AstNode[] }).body
      const propsTypeName = `${tag}Props`

      // ── 1. Find the component function node ─────────────────────────────────
      let fnNode: AstNode | null = null
      let declLine = 1
      for (const node of body) {
        const nodeStartLine = (node.loc as AstLocFull | undefined)?.start.line ?? 1
        const candidates: AstNode[] = []
        if (node.type === 'FunctionDeclaration') candidates.push(node)
        const exported = (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration')
          ? (node as AstNode & { declaration?: AstNode }).declaration : undefined
        if (exported?.type === 'FunctionDeclaration') candidates.push(exported)
        const varDecl = exported?.type === 'VariableDeclaration' ? exported
          : node.type === 'VariableDeclaration' ? node : null
        if (varDecl) {
          for (const d of ((varDecl as AstNode & { declarations?: AstNode[] }).declarations ?? [])) {
            const id = (d as AstNode & { id?: AstNode & { name?: string } }).id
            if (id?.name === tag) {
              const fn = (d as AstNode & { init?: AstNode }).init
              if (fn) { candidates.push(fn); declLine = nodeStartLine }
            }
          }
        }
        for (const cand of candidates) {
          const fnId = (cand as AstNode & { id?: AstNode & { name?: string } }).id
          if (cand.type === 'FunctionDeclaration' && fnId?.name !== tag) continue
          fnNode = cand
          declLine = nodeStartLine
          break
        }
        if (fnNode) break
      }
      if (!fnNode) return

      // ── 2. Extract destructured props + infer types from default values ──────
      //   Handles: { a, b = 'x', c = 42, d = {color:'red'}, e = () => {} }
      const params = (fnNode as AstNode & { params?: AstNode[] })?.params ?? []
      const firstParam = params[0]
      const pattern = firstParam?.type === 'ObjectPattern' ? firstParam
        : firstParam?.type === 'AssignmentPattern'
          ? (firstParam as AstNode & { left?: AstNode }).left
          : null

      // Collect { name, inferredType, hasExplicitType } for each prop.
      interface PropDraft { name: string; type: string; hasExplicit: boolean }
      const propDrafts: PropDraft[] = []

      if (pattern?.type === 'ObjectPattern') {
        // Check if there's already a referenced props type we can pull from.
        const existingTypeRef = (() => {
          const ta = (pattern as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
          const ref = (ta as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
          return ref?.type === 'TSTypeReference'
            ? String((ref as AstNode & { typeName?: AstNode & { name?: string } }).typeName?.name ?? '')
            : ''
        })()
        const existingMembers: ComponentProp[] = []
        if (existingTypeRef) enrichWithTypeDeclaration(body, existingTypeRef, existingMembers)

        for (const prop of ((pattern as AstNode & { properties?: AstNode[] }).properties ?? [])) {
          if (prop.type === 'RestElement') continue
          const key = (prop as AstNode & { key?: AstNode & { name?: string } }).key
          if (!key?.name) continue
          const valNode = (prop as AstNode & { value?: AstNode }).value

          // Check if an explicit type exists in the referenced interface already.
          const fromInterface = existingMembers.find(m => m.name === key.name)
          if (fromInterface?.typeStr && fromInterface.typeStr !== 'unknown') {
            propDrafts.push({ name: key.name, type: fromInterface.typeStr, hasExplicit: true })
            continue
          }

          // Infer from default value (AssignmentPattern.right).
          let inferred = 'unknown'
          let hasExplicit = false
          if (valNode?.type === 'AssignmentPattern') {
            const right = (valNode as AstNode & { right?: AstNode }).right
            inferred = inferTypeFromExpression(right)
          } else if (valNode?.type === 'TSParameterProperty') {
            hasExplicit = true
          }
          // Fall back to explicit TS type annotation on the value node itself.
          const typeAnn = (valNode as AstNode & { typeAnnotation?: AstNode } | undefined)?.typeAnnotation
          if (typeAnn) {
            const t = stringifyTSType((typeAnn as AstNode & { typeAnnotation?: AstNode }).typeAnnotation)
            if (t) { inferred = t; hasExplicit = true }
          }
          propDrafts.push({ name: key.name, type: inferred, hasExplicit })
        }
      }

      // ── 3. Figure out what already exists ────────────────────────────────────
      const existingInterfaceNode = body.find(
        (n) => (n.type === 'TSInterfaceDeclaration' || n.type === 'TSTypeAliasDeclaration') &&
          (n as AstNode & { id?: AstNode & { name?: string } }).id?.name === propsTypeName
      ) ?? null

      const lines = source.split('\n')

      // ── 4. Build the interface member lines ──────────────────────────────────
      const indent = '  '
      const memberLines = propDrafts.map(p => `${indent}${p.name}?: ${p.type}`)

      // ── 5. Compute new signature (add `: PropsTypeName` to the pattern) ──────
      const fnStart = (fnNode as AstNode & { start?: number }).start
      const fnBodyNode = (fnNode as AstNode & { body?: AstNode & { start?: number } }).body
      const bodyStart = fnBodyNode?.start
      if (typeof fnStart !== 'number' || typeof bodyStart !== 'number') return

      const signature = source.slice(fnStart, bodyStart)
      let newSignature: string

      if (!firstParam) {
        newSignature = signature.replace(/\(\s*\)/, `({}: ${propsTypeName})`)
      } else if (pattern?.type === 'ObjectPattern') {
        // Check if type annotation already references our type — then no-op this part.
        const ta = (pattern as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
        const ref = (ta as AstNode & { typeAnnotation?: AstNode })?.typeAnnotation
        const alreadyAnnotated = ref?.type === 'TSTypeReference' &&
          (ref as AstNode & { typeName?: AstNode & { name?: string } }).typeName?.name === propsTypeName
        if (alreadyAnnotated) {
          newSignature = signature // nothing to change in the signature
        } else {
          const relEnd = (pattern as AstNode & { end?: number }).end
          if (typeof relEnd !== 'number') return
          const posInSig = relEnd - fnStart
          newSignature = signature.slice(0, posInSig) + `: ${propsTypeName}` + signature.slice(posInSig)
        }
      } else {
        return // unexpected shape
      }

      // ── 6. Apply changes to source ────────────────────────────────────────────
      let modified = source.slice(0, fnStart) + newSignature + source.slice(bodyStart)
      const modLines = modified.split('\n')

      if (!existingInterfaceNode) {
        // Create brand-new interface before the function declaration.
        const insertAt = Math.max(0, declLine - 1)
        modLines.splice(insertAt, 0,
          `interface ${propsTypeName} {`,
          ...memberLines,
          `}`,
          ``
        )
      } else if (memberLines.length > 0) {
        // Interface exists — check if its body is empty and fill it in.
        const intfBody = existingInterfaceNode.type === 'TSInterfaceDeclaration'
          ? (existingInterfaceNode as AstNode & { body?: AstNode & { body?: AstNode[]; loc?: AstLocFull } }).body
          : null
        const existingBodyMembers = intfBody?.body ?? []
        if (existingBodyMembers.length === 0 && intfBody?.loc) {
          // Empty interface — splice members in before the closing brace.
          const closingLine = intfBody.loc.end.line - 1 // 0-indexed
          // Re-compute line index in modLines (unchanged since we didn't splice near there yet).
          modLines.splice(closingLine, 0, ...memberLines)
        }
        // If it already has members, leave them alone — user manages it from here.
      }

      modified = modLines.join('\n')
      const ok = await pushToMonacoAndSave(modified)
      if (ok) setHasPropTypeDef(true)
    } catch { /* ignore */ }
  }

  // Check if the typed prop name already exists in scope.
  const newPropNameTrimmed = newPropName.trim()
  const propAlreadyExists = newPropNameTrimmed.length > 0 && (
    ownerProps.some(p => p.name === newPropNameTrimmed) ||
    jsxAttrs.some(a => a.name === newPropNameTrimmed) ||
    scopeLayers.some(l => l.props.some(p => p.name === newPropNameTrimmed) || l.state.some(s => s.name === newPropNameTrimmed))
  )

  // Event listeners available per element tag.
  function getListenersForTag(tag: string): string[] {
    const common = ['onClick', 'onDoubleClick', 'onMouseEnter', 'onMouseLeave', 'onMouseDown', 'onMouseUp', 'onMouseMove', 'onKeyDown', 'onKeyUp', 'onKeyPress', 'onFocus', 'onBlur', 'onContextMenu']
    const inputLike = ['onChange', 'onInput', 'onSelect', 'onInvalid']
    const formLike = ['onSubmit', 'onReset']
    const mediaLike = ['onPlay', 'onPause', 'onEnded', 'onVolumeChange', 'onTimeUpdate', 'onLoadedData', 'onError']
    const scrollable = ['onScroll', 'onWheel']
    const dragDrop = ['onDragStart', 'onDrag', 'onDragEnd', 'onDragOver', 'onDragEnter', 'onDragLeave', 'onDrop']
    const t = tag.toLowerCase()
    if (t === 'input' || t === 'textarea' || t === 'select') return [...inputLike, ...common, ...scrollable, ...dragDrop]
    if (t === 'form') return [...formLike, ...common]
    if (t === 'button') return ['onClick', 'onDoubleClick', 'onMouseEnter', 'onMouseLeave', 'onMouseDown', 'onMouseUp', 'onFocus', 'onBlur', 'onKeyDown', 'onKeyUp']
    if (t === 'a') return ['onClick', 'onMouseEnter', 'onMouseLeave', 'onFocus', 'onBlur']
    if (t === 'video' || t === 'audio') return [...mediaLike, ...common]
    if (t === 'img') return ['onClick', 'onLoad', 'onError', 'onMouseEnter', 'onMouseLeave']
    // Generic container (div, span, section, etc.)
    return [...common, ...scrollable, ...dragDrop]
  }

  const listenerTag = selectedNode?.tag ?? ''
  const availableListeners = getListenersForTag(listenerTag).filter(
    l => !jsxAttrs.some(a => a.name === l) && !usageAttrs.some(a => a.name === l)
  )

  async function handleAddAttr() {
    const name = newAttrName.trim()
    if (!name || !usageInfo) return
    try {
      const res = await fetch(`/__source?file=${encodeURIComponent(usageInfo.file)}`)
      if (!res.ok) return
      let src = await res.text()
      src = insertAttr(src, usageInfo.line, name, newAttrValue.trim(), newAttrIsExpr)
      if (usageInfo.file === file) {
        await pushToMonacoAndSave(src)
      } else {
        await fetch('/__source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: usageInfo.file, content: src }),
        })
        setSaveStatus('saved')
        void invalidateAndRefresh([usageInfo.file])
      }
      setUsageAttrs(extractJsxAttrs(src, usageInfo.line))
      setNewAttrName('')
      setNewAttrValue('')
      setNewAttrIsExpr(false)
      setShowAddAttr(false)
    } catch { /* non-fatal */ }
  }

  async function handleAddListener(eventName: string) {
    setShowListenerDropdown(false)
    const freshRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
    if (!freshRes.ok) return
    let modified = await freshRes.text()
    const nodeLocLine = selectedNode?.locatorLine ?? line
    if (inspectingComponent && usageInfo) {
      // Insert on parent usage site
      try {
        const parentRes = await fetch(`/__source?file=${encodeURIComponent(usageInfo.file)}`)
        if (parentRes.ok) {
          let parentSrc = await parentRes.text()
          parentSrc = insertAttr(parentSrc, usageInfo.line, eventName, '() => {}', true)
          await fetch('/__source', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: usageInfo.file, content: parentSrc }),
          })
          setUsageAttrs(extractJsxAttrs(parentSrc, usageInfo.line))
        }
      } catch { /* non-fatal */ }
    } else {
      modified = insertAttr(modified, nodeLocLine, eventName, '() => {}', true)
      await pushToMonacoAndSave(modified)
    }
  }

  async function handleCreateProp() {
    const name = newPropName.trim()
    if (!name || !/^[a-zA-Z_$][\w$]*$/.test(name)) return
    if (propAlreadyExists) return
    const freshRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
    if (!freshRes.ok) return
    let modified = await freshRes.text()
    const nodeLocLine = selectedNode?.locatorLine ?? line
    const ownerName = selectedNode?.ownerComponentName ?? componentName ?? ''
    // variable mode → pass as expression {varName}; entry mode → pass as string "value"
    // Root component has no parent to bind variables from — always treat as entry mode.
    const isVarMode = (!rootComponentName || selectedNode?.tag !== rootComponentName) && newPropMode === 'variable'
    const rawValue = newPropValue.trim()
    const valueToUse = rawValue || name
    // Destructure default: insert the value as-is (free-form) — the user controls quoting.
    const destructureDefault = (!inspectingComponent || !usageInfo)
      ? rawValue
      : ''
    if (inspectingComponent) {
      if (ownerName) modified = addPropToOwnerSignature(modified, ownerName, name, newPropType || 'unknown', destructureDefault || undefined)
      const ok = await pushToMonacoAndSave(modified)
      if (!ok) return
      // Also inject the attr at the parent usage site (e.g. <Input newProp={value} /> in LoginPage).
      if (usageInfo && rawValue) {
        try {
          const parentRes = await fetch(`/__source?file=${encodeURIComponent(usageInfo.file)}`)
          if (parentRes.ok) {
            let parentSrc = await parentRes.text()
            parentSrc = insertAttr(parentSrc, usageInfo.line, name, valueToUse, isVarMode)
            await fetch('/__source', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ file: usageInfo.file, content: parentSrc }),
            })
            setUsageAttrs(extractJsxAttrs(parentSrc, usageInfo.line))
          }
        } catch { /* non-fatal */ }
      }
    } else {
      modified = insertAttr(modified, nodeLocLine, name, valueToUse, isVarMode)
      if (ownerName) modified = addPropToOwnerSignature(modified, ownerName, name, newPropType || 'unknown', destructureDefault || undefined)
      const ok = await pushToMonacoAndSave(modified)
      if (!ok) return
    }
    setNewPropName('')
    setNewPropValue('')
    setNewPropType('string')
    setNewPropMode('entry')
    setNewPropAsExpr(false)
    setNewPropTypeInferred(false)
    setShowAddProp(false)
  }

  async function handleSave() {
    const editedValue = editorRef.current?.getValue() ?? displayCode
    const newFullSource = buildFullSourceFromEditorValue(editedValue)
    setSaving(true)
    setSaveStatus('idle')
    try {
      const res = await fetch('/__source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, content: newFullSource }),
      })
      if (!res.ok) throw new Error(`Save failed: ${res.status}`)
      fullSourceRef.current = newFullSource
      setSaveStatus('saved')
    } catch {
      setSaveStatus('error')
    } finally {
      setSaving(false)
    }
  }

  const displayFile = file.replace(/\\/g, '/').split('/src/').pop() ?? file

  return (
    <div style={{ ...styles.panel, width: panelWidth }}>
      {/* Resize handle */}
      <div
        onPointerDown={startResize}
        style={styles.resizeHandle}
        title="Drag to resize"
      />
      {/* Header */}
      <div style={styles.header}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
          {blockName && <span style={styles.blockName}>{blockName}</span>}
          <span style={styles.fileName} title={file}>{displayFile}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <button
            style={styles.undoRedoBtn}
            title="Undo (Ctrl+Z)"
            onClick={triggerUndo}
          >&#8630;</button>
          <button
            style={styles.undoRedoBtn}
            title="Redo (Ctrl+Y)"
            onClick={triggerRedo}
          >&#8631;</button>
          <button style={styles.closeBtn} onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      {/* Multiple-components banner — under the breadcrumb header */}
      {multipleComponentsInFile && (
        <div style={styles.multiComponentBanner}>
          <span style={styles.multiComponentBannerIcon}>⚠</span>
          <span style={styles.multiComponentBannerText}>
            This file defines <strong>multiple components</strong>. Consider splitting them into separate files.
          </span>
        </div>
      )}

      {/* Scope hierarchy panel — replaces the old imports section */}
      {(!expressionMode && selectedNode && (scopeLayers.length > 0 || (inspectingComponent && (ownerProps.length > 0 || parentLocals.length > 0)))) && (
        <>
        <ScopePanel
          layers={scopeLayers}
          inspectingComponent={inspectingComponent}
          ownerProps={ownerProps}
          parentLocals={parentLocals}
          parentSource={parentSource}
          parentComponentName={parentComponentName}
          usageAttrs={usageAttrs}
          currentTag={selectedNode.tag}
          onAddProp={handleScopeAddProp}
          onRemoveProp={handleScopeRemoveProp}
          onAddState={handleScopeAddState}
          onRemoveState={handleScopeRemoveState}
          readOnly={isReadOnly || isFromComponentsFolder}
        />
        {/* Inline "add state/ref" form */}
        {addStateOpen && !isFromComponentsFolder && (
          <div style={{ padding: '6px 12px', background: '#13131f', borderBottom: '1px solid #1e1e2e', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <select
                value={newStateHook}
                onChange={(e) => setNewStateHook(e.target.value as 'useState' | 'useRef')}
                style={{ background: '#1e1e2e', border: '1px solid #45475a', borderRadius: 4, color: '#cdd6f4', padding: '3px 4px', fontSize: 10, outline: 'none', cursor: 'pointer' }}
              >
                <option value="useState">useState</option>
                <option value="useRef">useRef</option>
              </select>
              <input
                autoFocus
                style={{ flex: 1, background: '#1e1e2e', border: '1px solid #45475a', borderRadius: 4, color: '#cdd6f4', padding: '3px 6px', fontSize: 11, fontFamily: 'monospace', outline: 'none' }}
                placeholder="variable name"
                value={newStateName}
                onChange={(e) => setNewStateName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setAddStateOpen(false); if (e.key === 'Enter' && newStateName.trim()) void handleCreateState() }}
              />
              <input
                style={{ width: 80, background: '#1e1e2e', border: '1px solid #45475a', borderRadius: 4, color: '#cdd6f4', padding: '3px 6px', fontSize: 11, fontFamily: 'monospace', outline: 'none' }}
                placeholder={newStateHook === 'useRef' ? 'initial (null)' : "initial ('')"}
                value={newStateInitial}
                onChange={(e) => setNewStateInitial(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setAddStateOpen(false); if (e.key === 'Enter' && newStateName.trim()) void handleCreateState() }}
              />
            </div>
            {newStateName.trim() && (() => {
              const name = newStateName.trim()
              const raw = newStateInitial.trim()
              const initVal = raw || (newStateHook === 'useRef' ? 'null' : "''")
              // Auto type inference from initial value
              const inferType = (v: string): string => {
                if (v === 'null') return 'null'
                if (v === 'true' || v === 'false') return 'boolean'
                if (/^\d+(\.\d+)?$/.test(v)) return 'number'
                if (/^['"`]/.test(v)) return 'string'
                if (v.startsWith('[')) return 'unknown[]'
                if (v.startsWith('{')) return 'object'
                return ''
              }
              const inferred = inferType(initVal)
              const typeHint = inferred ? ` → ${inferred}` : ''
              if (newStateHook === 'useRef') {
                return (
                  <div style={{ fontSize: 10, color: '#6c7086', fontFamily: 'monospace' }}>
                    const {name} = useRef({initVal})
                    {typeHint && <span style={{ color: '#585b70', marginLeft: 4 }}>{typeHint}</span>}
                  </div>
                )
              }
              const setter = 'set' + name.charAt(0).toUpperCase() + name.slice(1)
              return (
                <div style={{ fontSize: 10, color: '#6c7086', fontFamily: 'monospace' }}>
                  const [{name}, {setter}] = useState({initVal})
                  {typeHint && <span style={{ color: '#585b70', marginLeft: 4 }}>{typeHint}</span>}
                </div>
              )
            })()}
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button
                style={{ background: 'none', border: '1px solid #45475a', borderRadius: 4, color: '#6c7086', padding: '2px 8px', fontSize: 10, cursor: 'pointer' }}
                onClick={() => setAddStateOpen(false)}
              >Cancel</button>
              <button
                style={{ background: '#89b4fa', border: 'none', borderRadius: 4, color: '#1e1e2e', padding: '2px 8px', fontSize: 10, fontWeight: 600, cursor: 'pointer', opacity: newStateName.trim() ? 1 : 0.4 }}
                disabled={!newStateName.trim()}
                onClick={() => void handleCreateState()}
              >Create</button>
            </div>
          </div>
        )}
        </>
      )}

      {/* States panel — visible when browsing pages */}
      {!expressionMode && activeSection === 'pages' && activePage && projectRoot && (
        <StatesPanel
          pageName={activePage}
          projectRoot={projectRoot}
          scopeLayers={scopeLayers}
          onStateChange={(props, switched) => {
            const coerced: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(props)) {
              if (v === 'true') coerced[k] = true
              else if (v === 'false') coerced[k] = false
              else if (v !== '' && !isNaN(Number(v))) coerced[k] = Number(v)
              else { try { coerced[k] = JSON.parse(v) } catch { coerced[k] = v } }
            }
            notifyPropsChange(coerced, switched)
          }}
        />
      )}

      {/* Multiple-components banner — after tabs (kept as after-tabs slot, now unused, removed) */}

      {/* Expression component picker section — sits between scope and tabs */}
      {expressionMode && inspectMode !== 'expression' && (expressionPages.length > 0 || expressionComponents.length > 0) && (
        <ExpressionPickerPanel
          pages={expressionPages}
          components={expressionComponents}
          onInsert={onInsertComponent}
        />
      )}

      {/* Code section header */}
      <button style={{ ...scopeStyles.header, cursor: 'pointer', background: '#13131f' }} onClick={() => setCodeExpanded(v => {
        if (!v) {
          // Selecting the first tab of the computed list when opening
          const firstTab: Tab = wrapMode ? 'expression' : (expressionMode || inspectMode === 'expression') ? 'source' : isRootComponent ? 'props' : 'bindings'
          setActiveTab(firstTab)
        }
        return !v
      })}>
        <span style={scopeStyles.chevron}>{codeExpanded ? '▾' : '▸'}</span>
        <span>Code</span>
      </button>

      {codeExpanded && (
      <>
      {/* Tabs — wrap mode shows Expression + Source; normal mode shows existing tabs */}
      <div style={styles.tabs}>
        {wrapMode ? (
          <>  
            {(['expression', 'source'] as Tab[]).map(tab => (
              <button
                key={tab}
                style={{ ...styles.tab, ...(activeTab === tab ? styles.activeTab : {}) }}
                onClick={() => setActiveTab(tab)}
              >
                {tab === 'expression' ? 'Expression' : 'Source'}
              </button>
            ))}
          </>
        ) : (
          ((): Tab[] => {
            if (hasRuntimeError || loading) return ['source']
            const base: Tab[] = expressionMode || inspectMode === 'expression'
              ? ['source']
              : isRootComponent
                ? ['props', 'source']
                : inspectingComponent
                  ? ['bindings', 'props', 'source']
                  : ['bindings', 'source']
            if (hasEdits || pendingDiff) base.push('changes')
            return base
          })().map((tab) => {
            const tabReadOnly = !isRootComponent && inspectingComponent && isFromComponentsFolder && inspectMode !== 'component-usage' && (tab === 'props' || tab === 'source')
            const tabInfo: Record<Tab, string> = {
              expression: 'Choose an expression to wrap the selected nodes.',
              bindings: 'Bind component props to parent variables or literal values. Add, edit, or remove prop bindings and their types.',
              props: 'View and edit default values for the component\u2019s props. Changes are written back to the component source.',
              source: 'Full source code of the selected component or element. Edits here are saved directly to disk.',
              changes: 'Review pending code changes before applying. Shows a git-style diff for each affected file.',
            }
            return (
            <button
              key={tab}
              style={{ ...styles.tab, ...(activeTab === tab ? styles.activeTab : {}) }}
              onClick={() => {
                setActiveTab(tab)
                if (tab === 'changes') void computePendingDiff()
              }}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
              {tab === 'changes' && hasEdits && <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#f9e2af', marginLeft: 5, verticalAlign: 'middle' }} />}
              {activeTab === tab && <InfoIcon text={tabInfo[tab]} />}
              {tabReadOnly && (
                <span
                  title={`Open ${selectedNode.tag} for editing`}
                  style={{ marginLeft: 4, fontSize: '0.65rem', opacity: 0.6, cursor: 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    onNavigateToComponent?.(selectedNode.tag)
                  }}
                >↗</span>
              )}
            </button>
            )
          })
        )}
        {/* Fullscreen button — shown in the tab bar when source tab is active */}
        {!wrapMode && activeTab === 'source' && !loading && (
          <button
            title="Expand to full screen"
            onClick={() => setEditorFullscreen(true)}
            style={{
              marginLeft: 'auto',
              background: 'none', border: '1px solid #45475a',
              borderRadius: 4, color: '#6c7086', fontSize: 11, lineHeight: 1,
              padding: '2px 6px', cursor: 'pointer', alignSelf: 'center', flexShrink: 0,
            }}
          >
            ⛶
          </button>
        )}
      </div>

      {/* Wrap mode expression chooser tab */}
      {wrapMode && activeTab === 'expression' && (
        <WrapExpressionChooser
          expressions={wrapExpressions}
          chosenExpr={wrapChosenExpr ?? null}
          onChoose={onWrapChooseExpr ?? (() => {})}
        />
      )}

      {/* Wrap mode source tab — read-only view of chosen expression file */}
      {wrapMode && activeTab === 'source' && (
        <div style={styles.content}>
          {wrapExprLoading ? (
            <div style={styles.loading}>Loading…</div>
          ) : !wrapChosenExpr ? (
            <div style={{ padding: '1rem', color: '#6c7086', fontSize: 12, fontStyle: 'italic' }}>Select an expression first.</div>
          ) : (
            <Editor
              height="100%"
              language="typescript"
              path={wrapChosenExpr ? `file:///wrap-expr/${wrapChosenExpr.file.replace(/\\/g, '/')}` : undefined}
              theme="vs-dark"
              value={wrapExprSource}
              options={{
                fontSize: 12,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                readOnly: true,
                lineNumbers: 'on' as const,
              }}
            />
          )}
        </div>
      )}

      {/* Tabs content + save bar — normal mode only */}
      {!wrapMode && (
      <div style={styles.content}>
        {/* Editor is always mounted so Monaco undo stack is preserved across tab switches.
            Hidden via display:none when not on the source tab. */}
        <div style={{ display: activeTab === 'source' ? 'contents' : 'none' }}>
          {loading ? (
            <div style={styles.loading}>Loading…</div>
          ) : (
            <Editor
              height="100%"
              language="typescript"
              path={file ? `file:///${file.replace(/\\/g, '/')}` : undefined}
              theme="vs-dark"
              value={displayCode}
              options={{
                fontSize: 12,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                readOnly: !isRootComponent && inspectingComponent && isFromComponentsFolder && inspectMode !== 'component-usage',
                lineNumbers: (n: number) =>
                  String((blockRangeRef.current?.startLine ?? 0) + n),
              }}
              onMount={(ed, monaco) => {
                editorRef.current = ed
                monacoRef.current = monaco
                configureMonacoForInspector(monaco)
                if (file && fullSourceRef.current) {
                  void syncContextModels(file, fullSourceRef.current)
                  scheduleDiagnostics(file, fullSourceRef.current)
                }
                const model = ed.getModel()
                if (model) {
                  lastValidSourceRef.current = model.getValue()
                  modelChangeDisposableRef.current?.dispose()
                  modelChangeDisposableRef.current = model.onDidChangeContent(() => {
                    const latest = model.getValue()
                    lastValidSourceRef.current = latest
                    if (file) {
                      const fullForDiagnostics = buildFullSourceFromEditorValue(latest)
                      scheduleDiagnostics(file, fullForDiagnostics)
                    }
                    // Keep undo/redo button state in sync with Monaco's own stack.
                    setCanUndo(true)
                    setCanRedo(false)
                  })
                }

                const currentRange = blockRangeRef.current
                if (currentRange) {
                  const lineInModel = inspectMode === 'file'
                    ? Math.max(line, 1)
                    : Math.max(line - currentRange.startLine, 1)
                  ed.revealLineInCenter(lineInModel)
                }
              }}
            />
          )}
        </div>

        {/* ── Props tab ─────────────────────────────────────────── */}
        {activeTab === 'props' && (
          <div style={styles.bindingsPanel}>
            {!selectedNode || bindingsLoading ? (
              <div style={styles.loading}>Loading…</div>
            ) : (
              <>
                {/* Node header */}
                <div style={styles.bindingsNodeHeader}>
                  <span style={styles.bindingsNodeTag}>&lt;{selectedNode.tag}&gt;</span>
                  {selectedNode.ownerComponentName && selectedNode.ownerComponentName !== selectedNode.tag && (
                    <span style={styles.bindingsNodeOwner}>in {selectedNode.ownerComponentName}</span>
                  )}
                </div>

                <div style={styles.bindingsScroll}>
                  {/* No prop type banner */}
                  {inspectingComponent && !hasPropTypeDef && (isRootComponent || !isFromComponentsFolder) && (
                    <div style={styles.noPropTypeBanner}>
                      <div style={styles.noPropTypeBannerText}>
                        <span style={{ fontWeight: 600, color: '#f9e2af' }}>No props interface</span>
                        <span style={{ color: '#a6adc8' }}>
                          {' '}<code style={{ color: '#89b4fa', fontFamily: 'monospace' }}>{selectedNode.tag}</code> has no typed props declaration.
                        </span>
                      </div>
                      <button
                        style={styles.noPropTypeCta}
                        onClick={() => void handleRegisterPropTypes()}
                      >
                        Create <code style={{ fontFamily: 'monospace', fontWeight: 700 }}>{selectedNode.tag}Props</code>
                      </button>
                    </div>
                  )}

                  {/* Component mode: prop name + default value + type (expandable) */}
                  {inspectingComponent && (
                    ownerProps.length === 0 ? (
                      <div style={styles.componentEmptyState}>
                        <p style={{ margin: '0 0 0.5rem', color: '#6c7086', fontSize: '0.8rem' }}>
                          No props declared on <code style={{ color: '#89b4fa' }}>{selectedNode.tag}</code>.
                        </p>
                      </div>
                    ) : (
                      (() => {
                        const orderedProps = propOrder
                          .map(name => ownerProps.find(p => p.name === name))
                          .filter(Boolean) as typeof ownerProps
                        const defaultsReadOnly = !isRootComponent && isFromComponentsFolder
                        return orderedProps.map((prop, idx) => {
                        const rowOpen = expandedRows.has(prop.name)
                        const defMode = propDefaultMode[prop.name] ?? (prop.defaultValue && /^[a-zA-Z_$]/.test(prop.defaultValue) && !/^(true|false|null|undefined|'|"|`|\d)/.test(prop.defaultValue) ? 'expression' : 'value') as 'expression' | 'scope' | 'value'
                        return (
                          <div key={prop.name} style={styles.attrRowWrap}>
                            {/* Header */}
                            <div
                              style={styles.attrRowHeader}
                              onClick={() => setExpandedRows(prev => { const n = new Set(prev); n.has(prop.name) ? n.delete(prop.name) : n.add(prop.name); return n })}
                            >
                              <span style={styles.rowChevron}>{rowOpen ? '▼' : '▶'}</span>
                              <span style={{ ...styles.attrName, flex: 1 }}>{prop.name}</span>
                              {!defaultsReadOnly && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginRight: 2 }} onClick={e => e.stopPropagation()}>
                                  <button
                                    style={{ ...styles.deleteBtn, color: '#89b4fa', fontSize: 8, padding: '0 3px', lineHeight: '10px', opacity: idx === 0 ? 0.3 : 1 }}
                                    title="Move up"
                                    disabled={idx === 0}
                                    onClick={() => setPropOrder(prev => { const n = [...prev]; [n[idx-1], n[idx]] = [n[idx], n[idx-1]]; return n })}
                                  >▲</button>
                                  <button
                                    style={{ ...styles.deleteBtn, color: '#89b4fa', fontSize: 8, padding: '0 3px', lineHeight: '10px', opacity: idx === orderedProps.length - 1 ? 0.3 : 1 }}
                                    title="Move down"
                                    disabled={idx === orderedProps.length - 1}
                                    onClick={() => setPropOrder(prev => { const n = [...prev]; [n[idx], n[idx+1]] = [n[idx+1], n[idx]]; return n })}
                                  >▼</button>
                                </div>
                              )}
                              <span style={styles.badgeOwner}>prop</span>
                              {!defaultsReadOnly && (
                                <button
                                  style={styles.deleteBtn}
                                  title={`Remove prop ${prop.name}`}
                                  disabled={deletingProp === prop.name}
                                  onClick={(e) => { e.stopPropagation(); void handleDeleteProp(prop.name) }}
                                >
                                  {deletingProp === prop.name ? '…' : '✕'}
                                </button>
                              )}
                            </div>
                            {/* Expanded body */}
                            {rowOpen && (
                              <div style={styles.attrRowBody}>
                                {/* Default value */}
                                <div style={styles.attrBodyRow}>
                                  <span style={styles.attrBodyLabel}>default</span>
                                  {!defaultsReadOnly && (
                                    <div style={styles.modeToggle}>
                                      <button
                                        style={{ ...styles.modeBtn, ...(defMode === 'expression' ? styles.modeBtnActive : {}) }}
                                        onClick={() => { setPropDefaultMode(prev => ({ ...prev, [prop.name]: 'expression' })); setPropDefaultEdits(prev => { const n = { ...prev }; delete n[prop.name]; return n }) }}
                                      >expression</button>
                                      <button
                                        style={{ ...styles.modeBtn, ...(defMode === 'scope' ? styles.modeBtnActive : {}) }}
                                        onClick={() => { setPropDefaultMode(prev => ({ ...prev, [prop.name]: 'scope' })); setPropDefaultEdits(prev => { const n = { ...prev }; delete n[prop.name]; return n }) }}
                                      >scope</button>
                                      <button
                                        style={{ ...styles.modeBtn, ...(defMode === 'value' ? styles.modeBtnActive : {}) }}
                                        onClick={() => { setPropDefaultMode(prev => ({ ...prev, [prop.name]: 'value' })); setPropDefaultEdits(prev => { const n = { ...prev }; delete n[prop.name]; return n }) }}
                                      >value</button>
                                    </div>
                                  )}
                                  {defMode === 'scope' ? (
                                    <select
                                      style={styles.attrInput}
                                      disabled={defaultsReadOnly}
                                      value={propDefaultEdits[prop.name] ?? (prop.defaultValue && /^[a-zA-Z_$]/.test(prop.defaultValue) ? prop.defaultValue : '')}
                                      onChange={(e) => { if (!defaultsReadOnly) setPropDefaultEdits(prev => ({ ...prev, [prop.name]: e.target.value })) }}
                                    >
                                      <option value="">— pick variable —</option>
                                      {scopeLayers.map(layer => [
                                        layer.props.length > 0 && (
                                          <optgroup key={layer.componentName + '-props'} label={layer.componentName + ' props'}>
                                            {layer.props.map(p => <option key={p.name} value={p.name}>{p.name}{p.typeStr ? ': ' + p.typeStr : ''}</option>)}
                                          </optgroup>
                                        ),
                                        layer.state.length > 0 && (
                                          <optgroup key={layer.componentName + '-state'} label={layer.componentName + ' state'}>
                                            {layer.state.map(s => <option key={s.name} value={s.name}>{s.name}{s.typeStr ? ': ' + s.typeStr : ''}</option>)}
                                          </optgroup>
                                        ),
                                      ])}
                                    </select>
                                  ) : (
                                    <InlineMonaco
                                      value={propDefaultEdits[prop.name] ?? (() => {
                                        const dv = prop.defaultValue ?? ''
                                        const isExprDefault = dv && /^[a-zA-Z_$]/.test(dv) && !/^(true|false|null|undefined|'|"|`|\d)/.test(dv)
                                        if (defMode === 'expression' && isExprDefault) return dv
                                        if (defMode === 'value' && !isExprDefault) return dv
                                        return ''
                                      })()}
                                      onChange={(v) => { if (!defaultsReadOnly) setPropDefaultEdits(prev => ({ ...prev, [prop.name]: v })) }}
                                      readOnly={defaultsReadOnly}
                                    />
                                  )}
                                </div>
                                {/* Type */}
                                <div style={styles.attrBodyRow}>
                                  <span style={styles.attrBodyLabel}>type</span>
                                  <div style={{ display: 'flex', gap: 4, flex: 1 }}>
                                    <InlineMonaco
                                      value={propTypeEdits[prop.name] ?? prop.typeStr ?? ''}
                                      onChange={(v) => { if (!defaultsReadOnly) setPropTypeEdits(prev => ({ ...prev, [prop.name]: v })) }}
                                      readOnly={defaultsReadOnly}
                                    />
                                    {!defaultsReadOnly && (
                                      <button
                                        style={styles.inferBtn}
                                        title="Infer type from default value"
                                        onClick={() => {
                                          const curVal = propDefaultEdits[prop.name] ?? prop.defaultValue ?? ''
                                          const inferred = inferTypeFromValueString(curVal)
                                          if (inferred) setPropTypeEdits(prev => ({ ...prev, [prop.name]: inferred }))
                                        }}
                                      >⟳</button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })
                        })()
                    )
                  )}

                  {/* DOM mode: read-only summary of JSX attributes */}
                  {!inspectingComponent && jsxAttrs.length === 0 && (
                    <div style={styles.bindingsEmptyAttrs}>No JSX attributes found on this element.</div>
                  )}
                  {!inspectingComponent && jsxAttrs.map((attr) => (
                    <div key={attr.name} style={styles.attrRowDom}>
                      <span style={styles.attrName}>{attr.name}</span>
                      <span style={styles.attrReadonly}>{attr.rawValue}</span>
                    </div>
                  ))}

                  {/* Add prop inline form — defaults tab */}
                  {(isRootComponent || !isFromComponentsFolder) && inspectingComponent && (showAddProp ? (
                    <div style={styles.addPropForm}>
                      <div style={styles.addPropRow}>
                        <input
                          autoFocus
                          style={{ ...styles.attrInput, flex: 1 }}
                          placeholder="prop name"
                          value={newPropName}
                          onChange={(e) => setNewPropName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Escape') setShowAddProp(false) }}
                        />
                        <span style={{ color: '#6c7086', fontSize: 11 }}>:</span>
                        <div style={{ display: 'flex', gap: 2 }}>
                          <input
                            style={{ ...styles.attrInput, width: 70 }}
                            placeholder="type"
                            value={newPropType}
                            onChange={(e) => { setNewPropType(e.target.value); setNewPropTypeInferred(false) }}
                          />
                          <button
                            style={{ ...styles.inferBtn, opacity: newPropValue.trim() ? 1 : 0.35 }}
                            title="Infer type from value"
                            onClick={() => {
                              const inferred = inferTypeFromValueString(newPropValue)
                              if (inferred) { setNewPropType(inferred); setNewPropTypeInferred(true) }
                            }}
                          >⟳</button>
                        </div>
                      </div>
                      <div style={styles.addPropRow}>
                        <input
                          style={{ ...styles.attrInput, flex: 1 }}
                          placeholder="default value"
                          value={newPropValue}
                          onChange={(e) => { setNewPropValue(e.target.value) }}
                        />
                      </div>
                      {propAlreadyExists && (
                        <div style={{ color: '#f38ba8', fontSize: 11, padding: '2px 0', fontFamily: 'system-ui, sans-serif' }}>
                          A prop or variable named “{newPropNameTrimmed}” already exists in scope.
                        </div>
                      )}
                      <div style={styles.addPropActions}>
                        <button style={styles.cancelBtn} onClick={() => setShowAddProp(false)}>Cancel</button>
                        <button
                          style={{ ...styles.confirmBtn, ...(propAlreadyExists ? { opacity: 0.45, cursor: 'not-allowed' } : {}) }}
                          onClick={() => void handleCreateProp()}
                          disabled={!newPropName.trim() || propAlreadyExists}
                        >
                          Create prop
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button style={styles.addAttrBtn} onClick={() => { setShowListenerDropdown(false); setShowAddProp(true) }}>
                        + Add prop
                      </button>
                    </div>
                  ))}
                </div>

                {/* Apply-changes bar — defaults (root only) */}
                {(isRootComponent || !isFromComponentsFolder) && inspectingComponent && (() => {
                  const propOrderChanged = propOrder.length > 0 && propOrder.some((name, i) => ownerProps.filter(p => p.source === 'owner')[i]?.name !== name)
                  return (Object.keys(propDefaultEdits).length > 0 || Object.keys(propTypeEdits).length > 0 || propOrderChanged) && (
                  <div style={styles.saveBar}>
                    {!bindingsSaving && saveStatus === 'saved' && <span style={styles.savedMsg}>&#10003; Saved</span>}
                    {!bindingsSaving && saveStatus === 'error' && (
                      <span style={{ ...styles.errorMsg, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        &#x2717; Save failed
                        {saveErrorMsg && <InfoIcon text={saveErrorMsg} />}
                      </span>
                    )}
                    <button style={styles.saveBtn}
                      onClick={() => void handlePropTypeSave()}
                      disabled={bindingsSaving}
                    >
                      {bindingsSaving ? 'Saving…' : 'Apply'}
                    </button>
                    <button style={styles.cancelBtn} onClick={() => { setPropDefaultEdits({}); setPropTypeEdits({}); setPropOrder(ownerProps.filter(p => p.source === 'owner').map(p => p.name)) }}>Cancel</button>
                  </div>
                  )
                })()}
              </>
            )}
          </div>
        )}

        {/* ── Bindings tab ─────────────────────────────────────────── */}
        {activeTab === 'bindings' && (
          <div style={styles.bindingsPanel}>
            {!selectedNode || bindingsLoading ? (
              <div style={styles.loading}>Loading…</div>
            ) : (
              <>
                {/* Node header */}
                <div style={styles.bindingsNodeHeader}>
                  <span style={styles.bindingsNodeTag}>&lt;{selectedNode.tag}&gt;</span>
                  {selectedNode.ownerComponentName && selectedNode.ownerComponentName !== selectedNode.tag && (
                    <span style={styles.bindingsNodeOwner}>in {selectedNode.ownerComponentName}</span>
                  )}
                </div>

                <div style={styles.bindingsScroll}>
                  {/* ── Component mode: binding + type + badge + delete ──── */}
                  {inspectingComponent && (
                    ownerProps.length === 0 ? (
                      <div style={styles.componentEmptyState}>
                        <p style={{ margin: '0 0 0.5rem', color: '#6c7086', fontSize: '0.8rem' }}>
                          No props declared on <code style={{ color: '#89b4fa' }}>{selectedNode.tag}</code>.
                        </p>
                        <p style={{ margin: 0, color: '#6c7086', fontSize: '0.75rem' }}>
                          Use "+ Add prop" below to create the first prop.
                          The component signature and a <code style={{ color: '#cba6f7' }}>{selectedNode.tag}Props</code> interface
                          will be created automatically.
                        </p>
                      </div>
                    ) : (
                      ownerProps.map((prop) => {
                        const rowOpen = expandedRows.has(prop.name)
                        const hasBinding = usageAttrs.some(a => a.name === prop.name)
                        return (
                          <div key={prop.name} style={styles.attrRowWrap}>
                            {/* Header */}
                            <div
                              style={styles.attrRowHeader}
                              onClick={() => setExpandedRows(prev => { const n = new Set(prev); n.has(prop.name) ? n.delete(prop.name) : n.add(prop.name); return n })}
                            >
                              <span style={styles.rowChevron}>{rowOpen ? '▼' : '▶'}</span>
                              <span style={{ ...styles.attrName, flex: 1 }}>{prop.name}</span>
                              <span style={styles.badgeOwner}>prop</span>
                              {!isReadOnly && hasBinding && usageInfo && prop.name !== 'children' && (
                                <button
                                  style={styles.deleteBtn}
                                  title={`Clear binding for ${prop.name}`}
                                  disabled={deletingProp === prop.name}
                                  onClick={(e) => { e.stopPropagation(); void handleClearPropValue(prop.name) }}
                                >
                                  {deletingProp === prop.name ? '…' : '⌫'}
                                </button>
                              )}
                            </div>
                            {/* Expanded body */}
                            {rowOpen && (
                              <div style={styles.attrRowBody}>
                                {/* Value */}
                                <div style={styles.attrBodyRow}>
                                  <span style={styles.attrBodyLabel}>value</span>
                                  {!isReadOnly && (
                                    <div style={styles.modeToggle}>
                                      <button
                                        style={{ ...styles.modeBtn, ...((propValueMode[prop.name] ?? 'expression') === 'expression' ? styles.modeBtnActive : {}) }}
                                        onClick={() => { setPropValueMode(prev => ({ ...prev, [prop.name]: 'expression' })); setPropValueEdits(prev => { const n = { ...prev }; delete n[prop.name]; return n }) }}
                                      >expression</button>
                                      <button
                                        style={{ ...styles.modeBtn, ...((propValueMode[prop.name] ?? 'expression') === 'scope' ? styles.modeBtnActive : {}) }}
                                        onClick={() => { setPropValueMode(prev => ({ ...prev, [prop.name]: 'scope' })); setPropValueEdits(prev => { const n = { ...prev }; delete n[prop.name]; return n }) }}
                                      >scope</button>
                                      <button
                                        style={{ ...styles.modeBtn, ...((propValueMode[prop.name] ?? 'expression') === 'value' ? styles.modeBtnActive : {}) }}
                                        onClick={() => { setPropValueMode(prev => ({ ...prev, [prop.name]: 'value' })); setPropValueEdits(prev => { const n = { ...prev }; delete n[prop.name]; return n }) }}
                                      >value</button>
                                    </div>
                                  )}
                                  {(propValueMode[prop.name] ?? 'expression') === 'scope' ? (
                                    <select
                                      style={styles.attrInput}
                                      disabled={isReadOnly}
                                      value={propValueEdits[prop.name] ?? (usageAttrs.find(a => a.name === prop.name)?.isExpression ? usageAttrs.find(a => a.name === prop.name)?.rawValue ?? '' : '')}
                                      onChange={(e) => {
                                        if (isReadOnly) return
                                        setPropValueEdits(prev => ({ ...prev, [prop.name]: e.target.value }))
                                      }}
                                    >
                                      <option value="">— pick variable —</option>
                                      {scopeLayers.length > 0
                                        ? scopeLayers.map(layer => [
                                            layer.props.length > 0 && (
                                              <optgroup key={layer.componentName + '-props'} label={layer.componentName + ' props'}>
                                                {layer.props.map(p => <option key={p.name} value={p.name}>{p.name}{p.typeStr ? ': ' + p.typeStr : ''}</option>)}
                                              </optgroup>
                                            ),
                                            layer.state.length > 0 && (
                                              <optgroup key={layer.componentName + '-state'} label={layer.componentName + ' state'}>
                                                {layer.state.map(s => <option key={s.name} value={s.name}>{s.name}{s.typeStr ? ': ' + s.typeStr : ''}</option>)}
                                              </optgroup>
                                            ),
                                          ])
                                        : parentLocals.map(v => <option key={v} value={v}>{v}</option>)
                                      }
                                    </select>
                                  ) : (
                                    <InlineMonaco
                                      value={propValueEdits[prop.name] ?? (() => {
                                        const ua = usageAttrs.find(a => a.name === prop.name)
                                        const curMode = propValueMode[prop.name] ?? 'expression'
                                        if (!ua) return prop.defaultValue ?? ''
                                        if (curMode === 'expression' && ua.isExpression) return ua.rawValue
                                        if (curMode === 'value' && !ua.isExpression) return ua.rawValue
                                        return ''
                                      })()}
                                      onChange={(v) => { if (!isReadOnly) setPropValueEdits((prev) => ({ ...prev, [prop.name]: v })) }}
                                      readOnly={isReadOnly}
                                    />
                                  )}
                                </div>
                                {/* Type */}
                                <div style={styles.attrBodyRow}>
                                  <span style={styles.attrBodyLabel}>type</span>
                                  <div style={{ display: 'flex', gap: 4, flex: 1 }}>
                                    <InlineMonaco
                                      value={propTypeEdits[prop.name] ?? prop.typeStr ?? ''}
                                      onChange={(v) => { if (!isReadOnly) setPropTypeEdits((prev) => ({ ...prev, [prop.name]: v })) }}
                                      readOnly={isReadOnly}
                                    />
                                    {!isReadOnly && (
                                      <button
                                        style={styles.inferBtn}
                                        title="Infer type from current value"
                                        onClick={() => {
                                          const curVal = (propValueEdits[prop.name] ?? usageAttrs.find(a => a.name === prop.name)?.rawValue ?? prop.defaultValue ?? '')
                                          const pvm = propValueMode[prop.name] ?? 'expression'
                                          const varMode = pvm === 'scope' || pvm === 'expression'
                                          const inferred = varMode && parentSource && parentComponentName
                                            ? inferTypeOfLocal(parentSource, parentComponentName, curVal)
                                            : inferTypeFromValueString(curVal)
                                          if (inferred) setPropTypeEdits(prev => ({ ...prev, [prop.name]: inferred }))
                                        }}
                                      >⟳</button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })
                    )
                  )}

                  {/* ── Component mode: extra usage attrs not in ownerProps ── */}
                  {inspectingComponent && (() => {
                    const extraAttrs = usageAttrs.filter(a => !a.isSpread && !ownerProps.some(p => p.name === a.name))
                    if (extraAttrs.length === 0) return null
                    return (
                      <>
                        <div style={{ fontSize: 10, fontWeight: 700, color: '#6c7086', textTransform: 'uppercase', letterSpacing: '0.07em', padding: '8px 10px 4px', flexShrink: 0 }}>Attributes</div>
                        {extraAttrs.map((attr) => {
                          const rowKey = `__ua__${attr.name}`
                          const rowOpen = expandedRows.has(rowKey)
                          const mode = attrModes[attr.name] ?? (attr.isExpression ? 'expression' : 'value') as 'expression' | 'scope' | 'value'
                          return (
                            <div key={attr.name} style={styles.attrRowWrap}>
                              <div
                                style={styles.attrRowHeader}
                                onClick={() => setExpandedRows(prev => { const n = new Set(prev); n.has(rowKey) ? n.delete(rowKey) : n.add(rowKey); return n })}
                              >
                                <span style={styles.rowChevron}>{rowOpen ? '▼' : '▶'}</span>
                                <span style={{ ...styles.attrName, flex: 1 }}>{attr.name}</span>
                                <span style={styles.badgeElement}>attr</span>
                                {!isReadOnly && (
                                  <button
                                    style={styles.deleteBtn}
                                    title={`Remove attribute ${attr.name}`}
                                    disabled={deletingProp === attr.name}
                                    onClick={(e) => { e.stopPropagation(); void handleClearPropValue(attr.name) }}
                                  >
                                    {deletingProp === attr.name ? '…' : '✕'}
                                  </button>
                                )}
                              </div>
                              {rowOpen && (
                                <div style={styles.attrRowBody}>
                                  <div style={styles.attrBodyRow}>
                                    <span style={styles.attrBodyLabel}>value</span>
                                    {!isReadOnly && (
                                      <div style={styles.modeToggle}>
                                        <button style={{ ...styles.modeBtn, ...(mode === 'expression' ? styles.modeBtnActive : {}) }} onClick={() => { setAttrModes(prev => ({ ...prev, [attr.name]: 'expression' })); setAttrEdits(prev => { const n = { ...prev }; delete n[attr.name]; return n }) }}>expression</button>
                                        <button style={{ ...styles.modeBtn, ...(mode === 'scope' ? styles.modeBtnActive : {}) }} onClick={() => { setAttrModes(prev => ({ ...prev, [attr.name]: 'scope' })); setAttrEdits(prev => { const n = { ...prev }; delete n[attr.name]; return n }) }}>scope</button>
                                        <button style={{ ...styles.modeBtn, ...(mode === 'value' ? styles.modeBtnActive : {}) }} onClick={() => { setAttrModes(prev => ({ ...prev, [attr.name]: 'value' })); setAttrEdits(prev => { const n = { ...prev }; delete n[attr.name]; return n }) }}>value</button>
                                      </div>
                                    )}
                                    {mode === 'scope' ? (
                                      <select
                                        style={styles.attrInput}
                                        disabled={isReadOnly}
                                        value={attrEdits[attr.name] ?? (attr.isExpression ? attr.rawValue : '')}
                                        onChange={(e) => { if (!isReadOnly) setAttrEdits(prev => ({ ...prev, [attr.name]: e.target.value })) }}
                                      >
                                        <option value="">— pick variable —</option>
                                        {scopeLayers.length > 0
                                          ? scopeLayers.map(layer => [
                                              layer.props.length > 0 && (
                                                <optgroup key={layer.componentName + '-props'} label={layer.componentName + ' props'}>
                                                  {layer.props.map(p => <option key={p.name} value={p.name}>{p.name}{p.typeStr ? ': ' + p.typeStr : ''}</option>)}
                                                </optgroup>
                                              ),
                                              layer.state.length > 0 && (
                                                <optgroup key={layer.componentName + '-state'} label={layer.componentName + ' state'}>
                                                  {layer.state.map(s => <option key={s.name} value={s.name}>{s.name}{s.typeStr ? ': ' + s.typeStr : ''}</option>)}
                                                </optgroup>
                                              ),
                                            ])
                                          : parentLocals.map(v => <option key={v} value={v}>{v}</option>)
                                        }
                                      </select>
                                    ) : (
                                      <InlineMonaco
                                        value={attrEdits[attr.name] ?? (() => {
                                          if (mode === 'expression' && attr.isExpression) return attr.rawValue
                                          if (mode === 'value' && !attr.isExpression) return attr.rawValue
                                          return ''
                                        })()}
                                        onChange={(v) => { if (!isReadOnly) setAttrEdits(prev => ({ ...prev, [attr.name]: v })) }}
                                        readOnly={isReadOnly}
                                      />
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </>
                    )
                  })()}

                  {/* ── Component mode: add attribute button/form ──── */}
                  {inspectingComponent && !isReadOnly && usageInfo && (
                    showAddAttr ? (
                      <div style={styles.addPropForm}>
                        <div style={styles.addPropRow}>
                          <input
                            autoFocus
                            style={{ ...styles.attrInput, flex: 1 }}
                            placeholder="attr name"
                            value={newAttrName}
                            onChange={(e) => setNewAttrName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') void handleAddAttr(); if (e.key === 'Escape') setShowAddAttr(false) }}
                          />
                          <div style={styles.modeToggle}>
                            <button
                              style={{ ...styles.modeBtn, ...(!newAttrIsExpr ? styles.modeBtnActive : {}) }}
                              onClick={() => setNewAttrIsExpr(false)}
                            >value</button>
                            <button
                              style={{ ...styles.modeBtn, ...(newAttrIsExpr ? styles.modeBtnActive : {}) }}
                              onClick={() => setNewAttrIsExpr(true)}
                            >expr</button>
                          </div>
                        </div>
                        <div style={styles.addPropRow}>
                          <input
                            style={{ ...styles.attrInput, flex: 1 }}
                            placeholder={newAttrIsExpr ? 'expression (without {})' : 'value'}
                            value={newAttrValue}
                            onChange={(e) => setNewAttrValue(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') void handleAddAttr(); if (e.key === 'Escape') setShowAddAttr(false) }}
                          />
                        </div>
                        <div style={styles.addPropActions}>
                          <button style={styles.cancelBtn} onClick={() => { setShowAddAttr(false); setNewAttrName(''); setNewAttrValue('') }}>Cancel</button>
                          <button
                            style={{ ...styles.confirmBtn, ...(!newAttrName.trim() ? { opacity: 0.45, cursor: 'not-allowed' } : {}) }}
                            disabled={!newAttrName.trim()}
                            onClick={() => void handleAddAttr()}
                          >Add</button>
                        </div>
                      </div>
                    ) : (
                      <button style={styles.addAttrBtn} onClick={() => setShowAddAttr(true)}>+ Add attribute</button>
                    )
                  )}

                  {/* ── DOM mode: text content children ───────────────── */}
                  {!inspectingComponent && textChildren.length > 0 && (
                    <>
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#6c7086', textTransform: 'uppercase', letterSpacing: '0.07em', padding: '8px 10px 4px', flexShrink: 0 }}>Text content</div>
                      {textChildren.map((child) => {
                        const tKey = `__text__${child.index}`
                        const rowOpen = expandedRows.has(tKey)
                        const textMode = textChildModes[child.index] ?? (child.kind === 'expr' ? 'expression' : 'value') as 'expression' | 'scope' | 'value'
                        return (
                          <div key={child.index} style={styles.attrRowWrap}>
                            <div
                              style={styles.attrRowHeader}
                              onClick={() => setExpandedRows(prev => { const n = new Set(prev); n.has(tKey) ? n.delete(tKey) : n.add(tKey); return n })}
                            >
                              <span style={styles.rowChevron}>{rowOpen ? '▼' : '▶'}</span>
                              <span style={{ ...styles.attrName, flex: 1, color: child.kind === 'expr' ? '#cba6f7' : '#a6e3a1' }}>
                                {child.kind === 'expr' ? '{…}' : 'text'}
                              </span>
                            </div>
                            {rowOpen && (
                              <div style={styles.attrRowBody}>
                                <div style={styles.attrBodyRow}>
                                  <span style={styles.attrBodyLabel}>value</span>
                                  {!isReadOnly && (
                                    <div style={styles.modeToggle}>
                                      <button
                                        style={{ ...styles.modeBtn, ...(textMode === 'expression' ? styles.modeBtnActive : {}) }}
                                        onClick={() => { setTextChildModes(prev => ({ ...prev, [child.index]: 'expression' })); setTextChildEdits(prev => { const n = { ...prev }; delete n[child.index]; return n }) }}
                                      >expression</button>
                                      <button
                                        style={{ ...styles.modeBtn, ...(textMode === 'scope' ? styles.modeBtnActive : {}) }}
                                        onClick={() => { setTextChildModes(prev => ({ ...prev, [child.index]: 'scope' })); setTextChildEdits(prev => { const n = { ...prev }; delete n[child.index]; return n }) }}
                                      >scope</button>
                                      <button
                                        style={{ ...styles.modeBtn, ...(textMode === 'value' ? styles.modeBtnActive : {}) }}
                                        onClick={() => { setTextChildModes(prev => ({ ...prev, [child.index]: 'value' })); setTextChildEdits(prev => { const n = { ...prev }; delete n[child.index]; return n }) }}
                                      >value</button>
                                    </div>
                                  )}
                                  {textMode === 'scope' ? (
                                    <select
                                      style={styles.attrInput}
                                      disabled={isReadOnly}
                                      value={textChildEdits[child.index] ?? (child.kind === 'expr' ? child.value : '')}
                                      onChange={(e) => {
                                        if (!isReadOnly) setTextChildEdits(prev => ({ ...prev, [child.index]: e.target.value }))
                                      }}
                                    >
                                      <option value="">— pick variable —</option>
                                      {scopeLayers.length > 0
                                        ? scopeLayers.map(layer => [
                                            layer.props.length > 0 && (
                                              <optgroup key={layer.componentName + '-props'} label={layer.componentName + ' props'}>
                                                {layer.props.map(p => <option key={p.name} value={p.name}>{p.name}{p.typeStr ? ': ' + p.typeStr : ''}</option>)}
                                              </optgroup>
                                            ),
                                            layer.state.length > 0 && (
                                              <optgroup key={layer.componentName + '-state'} label={layer.componentName + ' state'}>
                                                {layer.state.map(s => <option key={s.name} value={s.name}>{s.name}{s.typeStr ? ': ' + s.typeStr : ''}</option>)}
                                              </optgroup>
                                            ),
                                          ])
                                        : parentLocals.map(v => <option key={v} value={v}>{v}</option>)
                                      }
                                    </select>
                                  ) : (
                                    <InlineMonaco
                                      value={textChildEdits[child.index] ?? (() => {
                                        if (textMode === 'expression' && child.kind === 'expr') return child.value
                                        if (textMode === 'value' && child.kind !== 'expr') return child.value
                                        return ''
                                      })()}
                                      onChange={(v) => {
                                        if (!isReadOnly) setTextChildEdits(prev => ({ ...prev, [child.index]: v }))
                                      }}
                                      readOnly={isReadOnly}
                                    />
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </>
                  )}

                  {/* ── DOM mode: editable JSX attributes ─────────────── */}
                  {!inspectingComponent && jsxAttrs.length === 0 && textChildren.length === 0 && (
                    <div style={styles.bindingsEmptyAttrs}>No JSX attributes found on this element.</div>
                  )}
                  {!inspectingComponent && jsxAttrs.length === 0 && textChildren.length > 0 && (
                    <div style={styles.bindingsEmptyAttrs}>No JSX attributes on this element.</div>
                  )}

                  {!inspectingComponent && jsxAttrs.map((attr) => {
                    const rowOpen = expandedRows.has(attr.name)
                    const match = ownerProps.find((p) => p.name === attr.name)
                    const mode = attrModes[attr.name] ?? (attr.isExpression ? 'expression' : 'value') as 'expression' | 'scope' | 'value'
                    return (
                      <div key={attr.name} style={styles.attrRowWrap}>
                        {/* Header */}
                        <div
                          style={styles.attrRowHeader}
                          onClick={() => setExpandedRows(prev => { const n = new Set(prev); n.has(attr.name) ? n.delete(attr.name) : n.add(attr.name); return n })}
                        >
                          <span style={styles.rowChevron}>{rowOpen ? '▼' : '▶'}</span>
                          <span style={{ ...styles.attrName, flex: 1 }}>{attr.name}</span>
                          {attr.isSpread && <span style={styles.attrReadonly}>{attr.rawValue}</span>}
                          {match && (
                            <span style={match.source === 'owner' ? styles.badgeOwner : styles.badgeElement}>
                              {match.source === 'owner' ? 'owner' : 'elem'}
                            </span>
                          )}
                          {!attr.isSpread && !isReadOnly && (
                            <button
                              style={styles.deleteBtn}
                              title={`Remove attribute ${attr.name}`}
                              disabled={deletingProp === attr.name}
                              onClick={(e) => { e.stopPropagation(); void handleDeleteProp(attr.name) }}
                            >
                              {deletingProp === attr.name ? '…' : '✕'}
                            </button>
                          )}
                        </div>
                        {/* Expanded body */}
                        {rowOpen && !attr.isSpread && (
                          <div style={styles.attrRowBody}>
                            <div style={styles.attrBodyRow}>
                              <span style={styles.attrBodyLabel}>value</span>
                              {!isReadOnly && (
                                <div style={styles.modeToggle}>
                                  <button
                                    style={{ ...styles.modeBtn, ...(mode === 'expression' ? styles.modeBtnActive : {}) }}
                                    onClick={() => { setAttrModes(prev => ({ ...prev, [attr.name]: 'expression' })); setAttrEdits(prev => { const n = { ...prev }; delete n[attr.name]; return n }) }}
                                  >expression</button>
                                  <button
                                    style={{ ...styles.modeBtn, ...(mode === 'scope' ? styles.modeBtnActive : {}) }}
                                    onClick={() => { setAttrModes(prev => ({ ...prev, [attr.name]: 'scope' })); setAttrEdits(prev => { const n = { ...prev }; delete n[attr.name]; return n }) }}
                                  >scope</button>
                                  <button
                                    style={{ ...styles.modeBtn, ...(mode === 'value' ? styles.modeBtnActive : {}) }}
                                    onClick={() => { setAttrModes(prev => ({ ...prev, [attr.name]: 'value' })); setAttrEdits(prev => { const n = { ...prev }; delete n[attr.name]; return n }) }}
                                  >value</button>
                                </div>
                              )}
                              {mode === 'scope' ? (
                                <select
                                  style={styles.attrInput}
                                  disabled={isReadOnly}
                                  value={attrEdits[attr.name] ?? (attr.isExpression ? attr.rawValue : '')}
                                  onChange={(e) => {
                                    if (!isReadOnly) setAttrEdits(prev => ({ ...prev, [attr.name]: e.target.value }))
                                  }}
                                >
                                  <option value="">— pick variable —</option>
                                  {scopeLayers.length > 0
                                    ? scopeLayers.map(layer => [
                                        layer.props.length > 0 && (
                                          <optgroup key={layer.componentName + '-props'} label={layer.componentName + ' props'}>
                                            {layer.props.map(p => <option key={p.name} value={p.name}>{p.name}{p.typeStr ? ': ' + p.typeStr : ''}</option>)}
                                          </optgroup>
                                        ),
                                        layer.state.length > 0 && (
                                          <optgroup key={layer.componentName + '-state'} label={layer.componentName + ' state'}>
                                            {layer.state.map(s => <option key={s.name} value={s.name}>{s.name}{s.typeStr ? ': ' + s.typeStr : ''}</option>)}
                                          </optgroup>
                                        ),
                                      ])
                                    : parentLocals.map(v => <option key={v} value={v}>{v}</option>)
                                  }
                                </select>
                              ) : (
                                <InlineMonaco
                                  value={attrEdits[attr.name] ?? (() => {
                                    if (mode === 'expression' && attr.isExpression) return attr.rawValue
                                    if (mode === 'value' && !attr.isExpression) return attr.rawValue
                                    return ''
                                  })()}
                                  onChange={(v) => {
                                    if (!isReadOnly) setAttrEdits((prev) => ({ ...prev, [attr.name]: v }))
                                  }}
                                  readOnly={isReadOnly}
                                />
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {/* Add prop inline form — hidden, adding not allowed in bindings */}
                  {false && !isReadOnly && (showAddProp ? (
                    <div style={styles.addPropForm}>
                      <div style={styles.addPropRow}>
                        <input
                          autoFocus
                          style={{ ...styles.attrInput, flex: 1 }}
                          placeholder="prop name"
                          value={newPropName}
                          onChange={(e) => setNewPropName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Escape') setShowAddProp(false) }}
                        />
                        <span style={{ color: '#6c7086', fontSize: 11 }}>:</span>
                        <div style={{ display: 'flex', gap: 2 }}>
                          <input
                            style={{ ...styles.attrInput, width: 70 }}
                            placeholder="type"
                            value={newPropType}
                            onChange={(e) => { setNewPropType(e.target.value); setNewPropTypeInferred(false) }}
                          />
                          <button
                            style={{ ...styles.inferBtn, opacity: newPropValue.trim() ? 1 : 0.35 }}
                            title="Infer type from value"
                            onClick={() => {
                              const inferred = newPropMode === 'variable' && parentSource && parentComponentName
                                ? inferTypeOfLocal(parentSource, parentComponentName, newPropValue)
                                : inferTypeFromValueString(newPropValue)
                              if (inferred) { setNewPropType(inferred); setNewPropTypeInferred(true) }
                            }}
                          >⟳</button>
                        </div>
                      </div>
                      <div style={styles.addPropRow}>
                        <div style={styles.modeToggle}>
                          <button
                            style={{ ...styles.modeBtn, ...(newPropMode === 'variable' ? styles.modeBtnActive : {}) }}
                            onClick={() => { setNewPropMode('variable'); setNewPropValue(''); setNewPropTypeInferred(false) }}
                          >var</button>
                          <button
                            style={{ ...styles.modeBtn, ...(newPropMode === 'entry' ? styles.modeBtnActive : {}) }}
                            onClick={() => { setNewPropMode('entry'); setNewPropValue(''); setNewPropTypeInferred(false) }}
                          >val</button>
                        </div>
                        {newPropMode === 'variable' ? (
                          <select
                            style={{ ...styles.attrInput, flex: 1 }}
                            value={newPropValue}
                            onChange={(e) => { setNewPropValue(e.target.value) }}
                          >
                            <option value="">— pick variable —</option>
                            {scopeLayers.length > 0
                              ? scopeLayers.map(layer => [
                                  layer.props.length > 0 && (
                                    <optgroup key={layer.componentName + '-props'} label={layer.componentName + ' props'}>
                                      {layer.props.map(p => <option key={p.name} value={p.name}>{p.name}{p.typeStr ? ': ' + p.typeStr : ''}</option>)}
                                    </optgroup>
                                  ),
                                  layer.state.length > 0 && (
                                    <optgroup key={layer.componentName + '-state'} label={layer.componentName + ' state'}>
                                      {layer.state.map(s => <option key={s.name} value={s.name}>{s.name}{s.typeStr ? ': ' + s.typeStr : ''}</option>)}
                                    </optgroup>
                                  ),
                                ])
                              : parentLocals.map(v => <option key={v} value={v}>{v}</option>)
                            }
                          </select>
                        ) : (
                          <input
                            style={{ ...styles.attrInput, flex: 1 }}
                            placeholder="default value"
                            value={newPropValue}
                            onFocus={(e) => { e.currentTarget.value = ''; setNewPropValue('') }}
                            onChange={(e) => { setNewPropValue(e.target.value) }}
                          />
                        )}
                      </div>
                      {propAlreadyExists && (
                        <div style={{ color: '#f38ba8', fontSize: 11, padding: '2px 0', fontFamily: 'system-ui, sans-serif' }}>
                          A prop or variable named “{newPropNameTrimmed}” already exists in scope.
                        </div>
                      )}
                      <div style={styles.addPropActions}>
                        <button style={styles.cancelBtn} onClick={() => setShowAddProp(false)}>Cancel</button>
                        <button
                          style={{ ...styles.confirmBtn, ...(propAlreadyExists ? { opacity: 0.45, cursor: 'not-allowed' } : {}) }}
                          onClick={() => void handleCreateProp()}
                          disabled={!newPropName.trim() || propAlreadyExists}
                        >
                          Create &amp; Bind
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 4, position: 'relative' }}>
                      <button style={styles.addAttrBtn} onClick={() => { setShowListenerDropdown(false); setShowAddProp(true) }}>
                        + Add prop
                      </button>
                      {!isReadOnly && availableListeners.length > 0 && (
                        <div style={{ position: 'relative' }}>
                          <button
                            style={styles.addAttrBtn}
                            onClick={() => setShowListenerDropdown(v => !v)}
                          >
                            + Add listener
                          </button>
                          {showListenerDropdown && (
                            <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, background: '#1e1e2e', border: '1px solid #313244', borderRadius: 6, zIndex: 50, minWidth: 180, maxHeight: 240, overflowY: 'auto', boxShadow: '0 4px 16px rgba(0,0,0,0.5)' }}>
                              {availableListeners.map(ev => (
                                <div
                                  key={ev}
                                  style={{ padding: '5px 12px', fontSize: 11, fontFamily: 'monospace', color: '#cdd6f4', cursor: 'pointer' }}
                                  onMouseEnter={e => (e.currentTarget.style.background = '#313244')}
                                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                  onClick={() => void handleAddListener(ev)}
                                >{ev}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  {isReadOnly && (
                    <div style={{ padding: '0.5rem 1rem', color: '#6c7086', fontSize: '0.75rem', fontStyle: 'italic' }}>
                      DOM nodes inside child components are read-only — select the component node itself to edit its props.
                    </div>
                  )}
                </div>

                {/* Apply-changes bar — bindings */}
                {!isReadOnly && inspectingComponent && (Object.keys(propTypeEdits).length > 0 || Object.keys(propValueEdits).length > 0) && (
                  <div style={styles.saveBar}>
                    {saveStatus === 'saved' && <span style={styles.savedMsg}>&#10003; Saved</span>}
                    {saveStatus === 'error' && <span style={styles.errorMsg}>&#x2717; Save failed</span>}
                    <button style={styles.saveBtn}
                      onClick={() => void handlePropTypeSave()}
                      disabled={bindingsSaving}
                    >
                      {bindingsSaving ? 'Saving…' : 'Apply'}
                    </button>
                    <button style={styles.cancelBtn} onClick={() => { setPropTypeEdits({}); setPropValueEdits({}) }}>Cancel</button>
                  </div>
                )}

                {/* Apply-changes bar — DOM attr mode */}
                {!isReadOnly && !inspectingComponent && (
                  <div style={styles.saveBar}>
                    {saveStatus === 'saved' && <span style={styles.savedMsg}>&#10003; Saved</span>}
                    {saveStatus === 'error' && <span style={styles.errorMsg}>&#x2717; Save failed</span>}
                    <button
                      style={styles.saveBtn}
                      onClick={() => void handleBindingsSave()}
                      disabled={bindingsSaving}
                    >
                      {bindingsSaving ? 'Saving…' : 'Apply'}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Changes tab — diff review with accordions ──────────── */}
        {activeTab === 'changes' && (
          <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
            {!pendingDiff ? (
              <div style={{ padding: '1rem', color: '#6c7086', fontSize: 12, fontStyle: 'italic' }}>
                {bindingsSaving ? 'Computing changes…' : 'No pending changes to review.'}
              </div>
            ) : (
              <>
                {/* Summary */}
                <div style={styles.changeSummary}>
                  <div style={styles.changeSummaryTitle}>
                    {pendingDiff.entries.length} file{pendingDiff.entries.length > 1 ? 's' : ''} · {pendingDiff.summary.length} change{pendingDiff.summary.length !== 1 ? 's' : ''}
                  </div>
                  {pendingDiff.summary.map((s, i) => (
                    <div key={i} style={styles.changeSummaryItem}>• {s}</div>
                  ))}
                </div>

                {/* File accordions */}
                {pendingDiff.entries.map((entry, idx) => {
                  const displayName = entry.file.replace(/\\/g, '/').split('/src/').pop() ?? entry.file
                  const diff = countDiffLines(entry.original, entry.modified)
                  const isExpanded = (expandedDiffFiles.has(idx))
                  return (
                    <div key={entry.file}>
                      <div
                        style={{ ...styles.accordionHeader, ...(isExpanded ? styles.accordionHeaderActive : {}) }}
                        onClick={() => setExpandedDiffFiles(prev => {
                          const next = new Set(prev)
                          next.has(idx) ? next.delete(idx) : next.add(idx)
                          return next
                        })}
                      >
                        <span style={styles.accordionChevron}>{isExpanded ? '▼' : '▶'}</span>
                        <span style={styles.accordionFileName}>{displayName}</span>
                        {diff.added > 0 && <span style={{ ...styles.accordionBadge, color: '#a6e3a1' }}>+{diff.added}</span>}
                        {diff.removed > 0 && <span style={{ ...styles.accordionBadge, color: '#f38ba8' }}>−{diff.removed}</span>}
                      </div>
                      {isExpanded && (
                        <div style={{ height: 300, borderBottom: '1px solid #313244' }}>
                          <DiffEditor
                            height="100%"
                            language="typescript"
                            theme="vs-dark"
                            original={entry.original}
                            modified={entry.modified}
                            options={{
                              fontSize: 12,
                              minimap: { enabled: false },
                              scrollBeyondLastLine: false,
                              readOnly: true,
                              renderSideBySide: false,
                            }}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </>
            )}
          </div>
        )}
      </div>
      )}

      {/* Save bar — source tab */}
      {!wrapMode && activeTab === 'source' && (isRootComponent || !inspectingComponent || !isFromComponentsFolder || inspectMode === 'component-usage') && (
        <div style={styles.saveBar}>
          {saveStatus === 'saved' && <span style={styles.savedMsg}>✓ Saved — HMR will reload</span>}
          {saveStatus === 'error' && <span style={styles.errorMsg}>✗ Save failed</span>}
          <button style={styles.saveBtn} onClick={handleSave} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {/* Action bar — changes tab */}
      {!wrapMode && activeTab === 'changes' && pendingDiff && (
        <div style={styles.saveBar}>
          {saveStatus === 'saved' && <span style={styles.savedMsg}>✓ Applied — HMR will reload</span>}
          {saveStatus === 'error' && <span style={styles.errorMsg}>✗ Apply failed</span>}
          <button style={styles.saveBtn} onClick={() => void applyPendingDiff()} disabled={bindingsSaving}>
            {bindingsSaving ? 'Applying…' : 'Apply all'}
          </button>
          <button style={styles.cancelBtn} onClick={discardPendingDiff}>Discard</button>
        </div>
      )}
      </>
      )}

      {/* ── Fullscreen source editor modal ───────────────────────────────── */}
      {editorFullscreen && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 5000,
            background: 'rgba(0,0,0,0.75)',
            display: 'flex', alignItems: 'stretch', justifyContent: 'stretch',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setEditorFullscreen(false) }}
        >
          <div style={{
            flex: 1,
            margin: 24,
            background: '#1e1e2e',
            border: '1px solid #313244',
            borderRadius: 10,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
          }}>
            {/* Fullscreen header */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '0 14px', height: 40,
              background: '#181825', borderBottom: '1px solid #313244', flexShrink: 0,
            }}>
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#6c7086', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {file ? file.replace(/\\/g, '/').split('/').slice(-3).join('/') : 'Source'}
              </span>
              <button
                title="Save (Ctrl+S)"
                onClick={() => void handleSave()}
                style={{
                  background: '#a6e3a1', border: 'none', borderRadius: 5,
                  color: '#1e1e2e', fontSize: 11, fontWeight: 700,
                  padding: '3px 14px', cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
                }}
              >
                Save
              </button>
              <button
                onClick={() => setEditorFullscreen(false)}
                style={{ background: 'none', border: 'none', color: '#6c7086', fontSize: 20, cursor: 'pointer', lineHeight: 1, padding: '0 2px' }}
              >
                ×
              </button>
            </div>

            {/* Full-height Monaco editor */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <Editor
                height="100%"
                language="typescript"
                path={file ? `file:///fullscreen/${file.replace(/\\/g, '/')}` : undefined}
                theme="vs-dark"
                value={displayCode}
                options={{
                  fontSize: 14,
                  minimap: { enabled: true },
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  readOnly: !isRootComponent && inspectingComponent && isFromComponentsFolder && inspectMode !== 'component-usage',
                  lineNumbers: (n: number) => String((blockRangeRef.current?.startLine ?? 0) + n),
                  padding: { top: 12, bottom: 12 },
                }}
                onMount={(ed, monaco) => {
                  configureMonacoForInspector(monaco)
                  // Sync edits back to the inline editor's model so Save works
                  const model = ed.getModel()
                  if (model) {
                    model.onDidChangeContent(() => {
                      const latest = model.getValue()
                      editorRef.current?.getModel()?.setValue(latest)
                      lastValidSourceRef.current = latest
                    })
                  }
                  // Ctrl+S saves from fullscreen
                  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                    void handleSave()
                  })
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

