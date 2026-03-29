import { Component, lazy, Suspense, useRef, useState } from 'react'
import type { ExpressionMeta } from '../tree/DOMTreePanel'

declare const __LOGIN_APP_PAGES_DIR__: string
declare const __LOGIN_APP_COMPONENTS_DIR__: string

export interface PageEntry { id: string; label: string; root: string }
export interface CompEntry { id: string; label: string; name: string }

// ── Lazy-load caches ──────────────────────────────────────────────────────────
const exprCache = new Map<string, ReturnType<typeof lazy>>()
const pageCache = new Map<string, ReturnType<typeof lazy>>()
const compCache = new Map<string, ReturnType<typeof lazy>>()
if (import.meta.hot) {
  import.meta.hot.on('vite:afterUpdate', () => {
    exprCache.clear(); pageCache.clear(); compCache.clear()
  })
}

function getExprLazy(file: string, name: string) {
  const key = `${file}#${name}`
  if (!exprCache.has(key)) {
    const fsPath = file.replace(/\\/g, '/')
    exprCache.set(key, lazy(() =>
      import(/* @vite-ignore */ `/@fs/${fsPath}`).then((m) => ({
        default: m[name] as React.ComponentType<Record<string, unknown>>,
      }))
    ))
  }
  return exprCache.get(key)!
}

function getPageLazy(root: string) {
  if (!pageCache.has(root)) {
    pageCache.set(root, lazy(() =>
      import(/* @vite-ignore */ `/@fs/${__LOGIN_APP_PAGES_DIR__}/${root}.tsx`).then((m) => ({
        default: m[root] as React.ComponentType<unknown>,
      }))
    ))
  }
  return pageCache.get(root)!
}

function getCompLazy(name: string) {
  if (!compCache.has(name)) {
    compCache.set(name, lazy(() =>
      import(/* @vite-ignore */ `/@fs/${__LOGIN_APP_COMPONENTS_DIR__}/${name}.tsx`).then((m) => ({
        default: m[name] as React.ComponentType<unknown>,
      }))
    ))
  }
  return compCache.get(name)!
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseValue(raw: string): unknown {
  if (raw === '' || raw === undefined) return undefined
  if (raw === 'true') return true
  if (raw === 'false') return false
  try { return JSON.parse(raw) } catch { return raw }
}

// Props whose value is a ReactNode (not children — that's the slot)
const REACT_NODE_PROPS = new Set(['then', 'else', 'default'])
function isReactNodeProp(name: string) { return REACT_NODE_PROPS.has(name) }

// Parse `<ComponentName />` or `<ComponentName>` tags from code
function parseTagNames(code: string): string[] {
  const names: string[] = []
  const re = /<([A-Z][a-zA-Z0-9]*)\s*\/?>/g
  let m
  while ((m = re.exec(code)) !== null) {
    if (!names.includes(m[1])) names.push(m[1])
  }
  return names
}

// ── Error boundary ────────────────────────────────────────────────────────────
class ErrorBoundary extends Component<
  { children: React.ReactNode; resetKey: string },
  { error: Error | null }
> {
  state = { error: null }
  static getDerivedStateFromError(e: Error) { return { error: e } }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  render() {
    if (this.state.error) return (
      <div style={{
        padding: '8px 12px', color: '#f38ba8', fontFamily: 'monospace', fontSize: 11,
        background: 'rgba(243,139,168,0.1)', borderRadius: 6, border: '1px solid rgba(243,139,168,0.25)',
      }}>
        {(this.state.error as Error).message}
      </div>
    )
    return this.props.children
  }
}

// ── ChildPreview: render component tags from a string ─────────────────────────
function ChildPreview({ code, pages, components }: {
  code: string; pages: PageEntry[]; components: CompEntry[]
}) {
  const names = parseTagNames(code)
  if (names.length === 0) {
    return code.trim()
      ? <span style={{ color: '#cdd6f4', fontSize: 12, fontFamily: 'monospace' }}>{code}</span>
      : <span style={{ color: '#585b70', fontStyle: 'italic', fontSize: 12 }}>(empty)</span>
  }
  return (
    <>
      {names.map((name) => {
        const isPage = pages.some((p) => p.root === name)
        const isComp = components.some((c) => c.name === name)
        if (!isPage && !isComp) return (
          <span key={name} style={{ color: '#f38ba8', fontSize: 12, fontFamily: 'monospace' }}>
            Unknown: &lt;{name} /&gt;
          </span>
        )
        const Lazy = isPage ? getPageLazy(name) : getCompLazy(name)
        return (
          <ErrorBoundary key={name} resetKey={name}>
            <Suspense fallback={<span style={{ color: '#6c7086', fontSize: 12 }}>Loading {name}…</span>}>
              <Lazy />
            </Suspense>
          </ErrorBoundary>
        )
      })}
    </>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
const taBase: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  resize: 'vertical',
  background: '#1e1e2e',
  border: '1px solid rgba(203,214,244,0.2)',
  borderRadius: 6,
  padding: '6px 10px',
  color: '#cdd6f4',
  fontSize: 12,
  fontFamily: '"Cascadia Code", "Fira Mono", monospace',
  outline: 'none',
  lineHeight: 1.6,
}

const card: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  background: '#1e1e2e',
  border: '1px solid rgba(203,214,244,0.12)',
  borderRadius: 10,
  padding: '14px 16px',
}

const lbl: React.CSSProperties = {
  fontSize: 10,
  color: '#a6adc8',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontWeight: 700,
}

// ── Picker chip button ────────────────────────────────────────────────────────
function Chip({ label, tag, onClick, color }: {
  label: string; tag: string; onClick: (tag: string) => void; color: string
}) {
  return (
    <button
      onMouseDown={(e) => e.preventDefault()} // keep textarea focused
      onClick={() => onClick(tag)}
      title={`Insert <${tag} />`}
      style={{
        padding: '3px 9px', borderRadius: 4,
        border: `1px solid ${color}60`,
        background: `${color}15`,
        color, fontSize: 11,
        fontFamily: '"Cascadia Code", monospace',
        cursor: 'pointer', whiteSpace: 'nowrap',
        transition: 'background 0.12s, border-color 0.12s',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = `${color}30` }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = `${color}15` }}
    >
      &lt;{label} /&gt;
    </button>
  )
}

// ── Component/Page picker panel ───────────────────────────────────────────────
function Picker({ pages, components, onInsert, focusLabel }: {
  pages: PageEntry[]
  components: CompEntry[]
  onInsert: (tag: string) => void
  focusLabel: string | null
}) {
  if (pages.length === 0 && components.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={lbl}>Insert component</span>
        <span style={{ fontSize: 10, color: '#585b70', fontFamily: 'monospace' }}>
          {focusLabel ? `→ ${focusLabel}` : 'focus a field above first'}
        </span>
      </div>
      {pages.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ ...lbl, minWidth: 56, paddingTop: 5, color: '#585b70' }}>pages</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {pages.map((p) => (
              <Chip key={p.id} label={p.root} tag={p.root} onClick={onInsert} color="#cba6f7" />
            ))}
          </div>
        </div>
      )}
      {components.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ ...lbl, minWidth: 56, paddingTop: 5, color: '#585b70' }}>comps</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {components.map((c) => (
              <Chip key={c.id} label={c.name} tag={c.name} onClick={onInsert} color="#89b4fa" />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main ExpressionTester ─────────────────────────────────────────────────────
export function ExpressionTester({ expr, pages, components, registerInsert }: {
  expr: ExpressionMeta | null
  pages: PageEntry[]
  components: CompEntry[]
  registerInsert?: (fn: (tag: string) => void) => void
}) {
  const [propValues, setPropValues] = useState<Record<string, string>>({})
  const [childrenCode, setChildrenCode] = useState('')
  // Track last focused field label (for picker context display)
  const lastFocusedRef = useRef<string | null>(null)
  const [focusLabel, setFocusLabel] = useState<string | null>(null)
  const taRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})

  if (!expr) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '100%', gap: 8,
        color: '#6c7086', fontFamily: 'system-ui, sans-serif', fontSize: 13,
      }}>
        <span style={{ fontSize: 32 }}>🔀</span>
        <span>Select an expression from the left panel to test it here.</span>
      </div>
    )
  }

  const Expr = getExprLazy(expr.file, expr.name)
  // LoopExpression uses children as a render-prop — detect by presence of `items` prop
  const isLoop = expr.props.includes('items')

  // Keep insertTag accessible from the right-panel picker via registerInsert
  // eslint-disable-next-line react-hooks/exhaustive-deps
  registerInsert?.(insertTag)

  // Build parsedProps
  const parsedProps: Record<string, unknown> = {}
  for (const p of expr.props) {
    const raw = propValues[p] ?? ''
    if (isReactNodeProp(p)) {
      parsedProps[p] = raw.trim()
        ? <ChildPreview code={raw} pages={pages} components={components} />
        : undefined
    } else {
      parsedProps[p] = parseValue(raw)
    }
  }

  // Children slot
  const childrenNode = childrenCode.trim()
    ? <ChildPreview code={childrenCode} pages={pages} components={components} />
    : (
      <div style={{
        padding: '8px 12px', background: 'rgba(137,180,250,0.12)', borderRadius: 4,
        fontSize: 12, color: '#89b4fa', fontFamily: 'monospace',
        border: '1px dashed rgba(137,180,250,0.35)',
      }}>
        Sample content
      </div>
    )

  // LoopExpression: inject a default render-prop for children
  if (isLoop) {
    parsedProps['children'] = (item: unknown, i: number) => (
      <div key={i} style={{ padding: '3px 0', fontSize: 12, fontFamily: 'monospace', color: '#cdd6f4' }}>
        {JSON.stringify(item)}
      </div>
    )
  }

  const resetKey = expr.name + JSON.stringify(propValues) + childrenCode

  function focus(fieldId: string, label: string) {
    lastFocusedRef.current = fieldId
    setFocusLabel(label)
  }

  function insertTag(tag: string) {
    const fieldId = lastFocusedRef.current ?? '__children__'
    const el = taRefs.current[fieldId]
    if (!el) return
    const s = el.selectionStart ?? el.value.length
    const e2 = el.selectionEnd ?? el.value.length
    const snippet = `<${tag} />`
    const updated = el.value.slice(0, s) + snippet + el.value.slice(e2)
    if (fieldId === '__children__') {
      setChildrenCode(updated)
    } else {
      setPropValues((v) => ({ ...v, [fieldId]: updated }))
    }
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(s + snippet.length, s + snippet.length)
    })
  }

  const taFocused = (id: string, label: string): React.TextareaHTMLAttributes<HTMLTextAreaElement> => ({
    onFocus: () => focus(id, label),
  })

  const placeholder = (p: string) => {
    if (p === 'condition') return 'true  or  false'
    if (p === 'items') return '["alpha", "beta", "gamma"]'
    if (p === 'value') return '"case1"'
    if (p === 'cases') return '{"case1": "Result A", "case2": "Result B"}'
    if (isReactNodeProp(p)) return `<ComponentName />`
    return 'value…'
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 16,
      padding: '24px 28px 32px',
      maxWidth: 640, margin: '0 auto', width: '100%',
      fontFamily: 'system-ui, sans-serif',
    }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 4, borderBottom: '1px solid rgba(203,214,244,0.1)' }}>
        <span style={{ fontSize: 22 }}>🔀</span>
        <span style={{ fontSize: 17, fontWeight: 700, color: '#94e2d5', fontFamily: 'monospace', letterSpacing: '-0.01em' }}>
          {expr.name}
        </span>
      </div>

      {/* ── Props ── */}
      {expr.props.length > 0 && (
        <div style={card}>
          <span style={lbl}>Props</span>
          {expr.props.map((p) => (
            <div key={p} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#89b4fa', fontFamily: 'monospace', fontSize: 12, fontWeight: 600 }}>{p}</span>
              <textarea
                ref={(el) => { taRefs.current[p] = el }}
                {...taFocused(p, `props.${p}`)}
                style={{ ...taBase, minHeight: isReactNodeProp(p) ? 64 : 38 }}
                rows={isReactNodeProp(p) ? 3 : 1}
                value={propValues[p] ?? ''}
                onChange={(e) => setPropValues((v) => ({ ...v, [p]: e.target.value }))}
                placeholder={placeholder(p)}
                spellCheck={false}
              />
            </div>
          ))}
        </div>
      )}

      {/* ── Children slot (skip LoopExpression render-prop) ── */}
      {!isLoop && (
        <div style={card}>
          <span style={lbl}>Children</span>
          <textarea
            ref={(el) => { taRefs.current['__children__'] = el }}
            {...taFocused('__children__', 'children')}
            style={{ ...taBase, minHeight: 64 }}
            rows={3}
            value={childrenCode}
            onChange={(e) => setChildrenCode(e.target.value)}
            placeholder="<ComponentName />  or plain text…"
            spellCheck={false}
          />
        </div>
      )}

      {/* ── Output ── */}
      <div style={{ ...card, gap: 12 }}>
        <span style={lbl}>Output</span>
        <div style={{
          padding: 16, borderRadius: 8,
          background: '#11111b',
          border: '1px solid rgba(203,214,244,0.1)',
          minHeight: 60,
        }}>
          <ErrorBoundary resetKey={resetKey}>
            <Suspense fallback={<span style={{ color: '#6c7086', fontSize: 12 }}>Loading…</span>}>
              {isLoop
                ? <Expr {...parsedProps} />
                : <Expr {...parsedProps}>{childrenNode}</Expr>
              }
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
    </div>
  )
}
