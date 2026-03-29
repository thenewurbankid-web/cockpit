import { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import { wrapNodesWithExpression, extractExpressionPropsFromSource, updateExpressionProps } from '../tree/expressionRewriter'
import type { ExpressionMeta } from '../tree/DOMTreePanel'
import type { SelectedNodeContext } from '../inspector/InspectorPanel'

// Structurally matches DOMTreePanel's exported WrapIntentNode (kept local to avoid module-resolution race)
export interface WrapIntentNode { key: string; file: string; line: number; tag: string }

// ─── helpers ────────────────────────────────────────────────────────────────

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

// ─── extract the full JSX element (including children) starting at a 1-based line
function extractJsxElementAtLine(source: string, line: number): string {
  const allLines = source.split('\n')
  const startIdx = line - 1
  if (startIdx < 0 || startIdx >= allLines.length) return ''

  const lineContent = allLines[startIdx]
  const tagLocalIdx = lineContent.search(/<[A-Za-z]/)
  if (tagLocalIdx === -1) return lineContent.trim()

  // Absolute char offset of '<' in source
  let lineOffset = 0
  for (let k = 0; k < startIdx; k++) lineOffset += allLines[k].length + 1
  const startPos = lineOffset + tagLocalIdx

  // Root tag name
  const tagNameM = source.slice(startPos + 1).match(/^([A-Za-z][A-Za-z0-9.]*)/)
  if (!tagNameM) return lineContent.trim()
  const tagName = tagNameM[1]

  let i = startPos
  let inStr: string | null = null
  let exprDepth = 0
  let elemDepth = 0
  let state: 'open-tag' | 'content' = 'open-tag'

  while (i < source.length) {
    const ch = source[i]

    if (inStr !== null) {
      if (ch === inStr && source[i - 1] !== '\\') inStr = null
      i++; continue
    }
    if (ch === '"' || ch === "'") { inStr = ch; i++; continue }
    if (ch === '{') { exprDepth++; i++; continue }
    if (ch === '}') { exprDepth--; i++; continue }
    if (exprDepth > 0) { i++; continue }

    if (state === 'open-tag') {
      if (ch === '/' && source[i + 1] === '>') return source.slice(startPos, i + 2)
      if (ch === '>') { elemDepth = 1; state = 'content'; i++; continue }
    }

    if (state === 'content' && ch === '<') {
      if (source[i + 1] === '/') {
        // Closing tag — check if it matches root tag name
        const rest = source.slice(i + 2)
        const nl = tagName.length
        const nextCh = rest[nl] ?? '>'
        if (rest.startsWith(tagName) && (nextCh === '>' || nextCh === ' ' || nextCh === '\n' || nextCh === '\r')) {
          elemDepth--
          if (elemDepth === 0) {
            const closeEnd = source.indexOf('>', i + 2)
            return source.slice(startPos, closeEnd === -1 ? undefined : closeEnd + 1)
          }
        }
      } else if (/[A-Za-z]/.test(source[i + 1] ?? '')) {
        // Opening tag — only track depth if same name
        const nm = source.slice(i + 1).match(/^([A-Za-z][A-Za-z0-9.]*)/)
        if (nm && nm[1] === tagName) {
          // Scan this sub-tag's opening to see if it's self-closing
          let j = i + 1 + nm[1].length
          let subStr: string | null = null; let subExpr = 0; let selfClose = false
          while (j < source.length) {
            const sc = source[j]
            if (subStr) { if (sc === subStr) subStr = null }
            else if (sc === '"' || sc === "'") subStr = sc
            else if (sc === '{') subExpr++
            else if (sc === '}') subExpr--
            else if (subExpr === 0) {
              if (sc === '/' && source[j + 1] === '>') { selfClose = true; break }
              if (sc === '>') break
            }
            j++
          }
          if (!selfClose) elemDepth++
          i = j
        }
      }
    }

    i++
  }

  return allLines[startIdx].trim()
}

// ─── component ───────────────────────────────────────────────────────────────

export function ExpressionAssignPanel({
  nodes,
  expressions,
  selectedNode,
  chosenExpr,
  onChooseExpr,
  onHoverNode,
  onLeaveNode,
  onCancel,
  onDone,
}: {
  nodes: WrapIntentNode[]
  expressions: ExpressionMeta[]
  selectedNode: SelectedNodeContext | null
  chosenExpr: ExpressionMeta | null
  onChooseExpr: (expr: ExpressionMeta) => void
  onHoverNode?: (node: WrapIntentNode) => void
  onLeaveNode?: () => void
  onCancel: () => void
  onDone: () => void
}) {
  const [propValues, setPropValues] = useState<Record<string, string>>({})
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // source lines for JSX extraction
  const [sourceText, setSourceText] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  // cursor-insertion state
  const focusedPropRef = useRef<string | null>(null)
  const editorRefs = useRef<Map<string, import('monaco-editor').editor.IStandaloneCodeEditor>>(new Map())
  const [editorHeights, setEditorHeights] = useState<Record<string, number>>({})
  const dragRef = useRef<{ prop: string; startY: number; startH: number } | null>(null)

  function startResize(prop: string, e: React.MouseEvent) {
    e.preventDefault()
    const startH = editorHeights[prop] ?? 56
    dragRef.current = { prop, startY: e.clientY, startH }
    function onMove(ev: MouseEvent) {
      if (!dragRef.current) return
      const delta = ev.clientY - dragRef.current.startY
      const next = Math.max(40, dragRef.current.startH + delta)
      setEditorHeights(prev => ({ ...prev, [dragRef.current!.prop]: next }))
      editorRefs.current.get(dragRef.current.prop)?.layout()
    }
    function onUp() {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  useEffect(() => {
    const file = nodes[0]?.file
    if (!file) return
    fetch(`/__source?file=${encodeURIComponent(file)}`)
      .then(r => r.ok ? r.text() : null)
      .then(src => setSourceText(src))
      .catch(() => {})
  }, [nodes])

  function copyNodeJsx(node: WrapIntentNode) {
    const snippet = sourceText ? extractJsxElementAtLine(sourceText, node.line) : `<${node.tag} />`
    navigator.clipboard.writeText(snippet).then(() => {
      setCopiedKey(node.key)
      setTimeout(() => setCopiedKey(k => k === node.key ? null : k), 1500)
    }).catch(() => {})
  }

  // When chosenExpr changes externally, sync propValues for its props
  useEffect(() => {
    if (!chosenExpr) return
    setPropValues(prev => {
      const pv: Record<string, string> = {}
      for (const p of chosenExpr.props) pv[p] = prev[p] ?? ''
      return pv
    })
    setError(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenExpr?.name])

  // When opening an existing expression (node tag matches chosen expr),
  // read the source file and extract the actual prop values from JSX.
  useEffect(() => {
    if (!chosenExpr) return
    const node = nodes[0]
    if (!node || node.tag !== chosenExpr.name) return
    if (!node.file || !node.line) return
    fetch(`/__source?file=${encodeURIComponent(node.file)}`)
      .then(r => r.ok ? r.text() : null)
      .then(src => {
        if (!src) return
        const extracted = extractExpressionPropsFromSource(src, chosenExpr.name, node.line)
        if (!extracted) return
        setPropValues(prev => {
          const pv: Record<string, string> = {}
          for (const p of chosenExpr.props) pv[p] = extracted[p] ?? prev[p] ?? ''
          return pv
        })
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenExpr?.name, nodes[0]?.key])

  // Insert a token at the cursor position of the focused prop editor
  function insertToken(token: string) {
    const propName = focusedPropRef.current
    if (!propName) return
    const ed = editorRefs.current.get(propName)
    if (!ed) {
      setPropValues(prev => ({ ...prev, [propName]: (prev[propName] ?? '') + token }))
      return
    }
    ed.focus()
    ed.trigger('keyboard', 'type', { text: token })
  }

  async function applyWrapping() {
    if (!chosenExpr || nodes.length === 0) return
    const file = nodes[0].file

    setApplying(true)
    setError(null)
    try {
      const srcRes = await fetch(`/__source?file=${encodeURIComponent(file)}`)
      if (!srcRes.ok) throw new Error('Could not read source file')
      const source = await srcRes.text()

      // If the node tag matches the chosen expression, we're editing an existing
      // usage — update its props in-place rather than wrapping again.
      const isEditing = nodes.length === 1 && nodes[0].tag === chosenExpr.name

      let newSource: string | null
      if (isEditing) {
        newSource = updateExpressionProps(source, chosenExpr.name, nodes[0].line, propValues)
        if (!newSource) throw new Error('Could not locate expression in source — try refreshing.')
      } else {
        const lines = nodes.map(n => n.line)
        const importPath = computeRelativeImportPath(file, chosenExpr.file)
        newSource = wrapNodesWithExpression(source, lines, chosenExpr.name, propValues, importPath, {})
        if (!newSource) throw new Error('Could not wrap nodes — make sure they are sibling JSX elements.')
      }

      const saveRes = await fetch('/__source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, content: newSource }),
      })
      if (!saveRes.ok) throw new Error('Could not save file')
      onDone()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setApplying(false)
    }
  }

  const canApply = !!chosenExpr && !applying

  return (
    <div style={s.root}>
      {/* ── Header ── */}
      <div style={s.header}>
        <button style={s.cancelBtn} onClick={onCancel}>← Cancel</button>
        <span style={s.headerTitle}>
          {nodes.length === 1 && nodes[0].tag === chosenExpr?.name
            ? `Edit ${chosenExpr.name}`
            : `Wrap ${nodes.length} node${nodes.length !== 1 ? 's' : ''} with expression`
          }
        </span>
        <button
          style={{ ...s.applyBtn, background: canApply ? '#94e2d5' : '#45475a', color: canApply ? '#1e1e2e' : '#6c7086', cursor: canApply ? 'pointer' : 'not-allowed' }}
          disabled={!canApply}
          onClick={applyWrapping}
        >
          {applying ? 'Applying…' : 'Apply ▶'}
        </button>
      </div>

      {/* ── Body ── */}
      <div style={s.body}>

        {/* ── Column: nodes + props ── */}
          <div style={s.left}>
            <div style={s.section}>
              <div style={s.label}>Selected nodes</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {nodes.map((node) => (
                  <div
                    key={node.key}
                    style={{ ...s.nodeChip, cursor: 'pointer', opacity: copiedKey === node.key ? 0.7 : 1 }}
                    title="Click to copy JSX"
                    onMouseEnter={() => onHoverNode?.(node)}
                    onMouseLeave={() => onLeaveNode?.()}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => copyNodeJsx(node)}
                  >
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: copiedKey === node.key ? '#a6e3a1' : '#cdd6f4' }}>
                      {copiedKey === node.key ? '✓ copied' : `<${node.tag}>`}
                    </span>
                    {copiedKey !== node.key && <span style={{ color: '#6c7086', fontSize: 10 }}>ln {node.line}</span>}
                  </div>
                ))}
              </div>
            </div>

          {/* Prop editors */}
          {chosenExpr && chosenExpr.props.length > 0 && (
            <div style={s.section}>
              <div style={s.label}>Prop values</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {chosenExpr.props.map(prop => (
                  <div key={prop} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={s.propLabel}>{prop}</span>
                    <div style={s.monacoWrap}>
                      <Editor
                        height={editorHeights[prop] ?? 56}
                        language="typescript"
                        theme="vs-dark"
                        value={propValues[prop] ?? ''}
                        options={{
                          fontSize: 12,
                          minimap: { enabled: false },
                          lineNumbers: 'off',
                          scrollBeyondLastLine: false,
                          wordWrap: 'on',
                          scrollbar: { vertical: 'hidden', horizontal: 'hidden', alwaysConsumeMouseWheel: false },
                          overviewRulerLanes: 0,
                          renderLineHighlight: 'none',
                          folding: false,
                          glyphMargin: false,
                          lineDecorationsWidth: 0,
                          lineNumbersMinChars: 0,
                          fixedOverflowWidgets: true,
                          padding: { top: 6, bottom: 6 },
                        }}
                        onChange={val => setPropValues(prev => ({ ...prev, [prop]: val ?? '' }))}
                        onMount={ed => {
                          editorRefs.current.set(prop, ed)
                          ed.onDidFocusEditorWidget(() => { focusedPropRef.current = prop })
                        }}
                      />
                      <div
                        style={s.resizeHandle}
                        onMouseDown={e => startResize(prop, e)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <div style={s.errorBox}>{error}</div>}
          </div>
      </div>
    </div>
  )
}

// ─── styles ──────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    background: '#1e1e2e',
    fontFamily: 'system-ui, sans-serif',
    overflow: 'hidden',
    minHeight: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '0.55rem 1rem',
    background: '#181825',
    borderBottom: '1px solid #313244',
    flexShrink: 0,
  },
  headerTitle: {
    flex: 1,
    color: '#cdd6f4',
    fontWeight: 600,
    fontSize: 13,
  },
  cancelBtn: {
    background: 'none',
    border: '1px solid #45475a',
    borderRadius: 6,
    color: '#9ca3af',
    fontSize: 12,
    padding: '0.3rem 0.85rem',
    cursor: 'pointer',
  },
  applyBtn: {
    border: 'none',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 700,
    padding: '0.35rem 1rem',
    transition: 'background 0.12s',
  },
  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
    minHeight: 0,
  },
  left: {
    flex: 1,
    overflowY: 'auto',
    padding: '1rem',
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  label: {
    fontSize: 10,
    fontWeight: 600,
    color: '#6c7086',
    textTransform: 'uppercase',
    letterSpacing: '0.07em',
    marginBottom: 2,
  } as React.CSSProperties,
  hint: {
    color: '#6c7086',
    fontSize: 11,
    fontStyle: 'italic',
  },
  exprRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 10px',
    borderRadius: 6,
    cursor: 'pointer',
  },

  propLabel: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#89b4fa',
  },
  monacoWrap: {
    borderRadius: 6,
    overflow: 'hidden',
    border: '1px solid rgba(203,214,244,0.15)',
    display: 'flex',
    flexDirection: 'column',
  },
  resizeHandle: {
    height: 5,
    cursor: 'ns-resize',
    background: 'rgba(203,214,244,0.06)',
    flexShrink: 0,
    transition: 'background 0.12s',
  },
  nodeChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 9px',
    borderRadius: 4,
    background: 'rgba(148,226,213,0.10)',
    border: '1px solid rgba(148,226,213,0.35)',
  },
  errorBox: {
    background: '#3b1f2e',
    border: '1px solid #f38ba8',
    borderRadius: 6,
    color: '#f38ba8',
    fontSize: 11,
    padding: '0.4rem 0.6rem',
  },
}
