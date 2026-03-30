import { useState } from 'react'
import { InfoIcon } from './InfoIcon'
import { scopeStyles } from './ScopePanel'

export function WrapExpressionChooser({
  expressions,
  chosenExpr,
  onChoose,
}: {
  expressions: { name: string; file: string; props: string[] }[]
  chosenExpr: { name: string; file: string; props: string[] } | null
  onChoose: (expr: { name: string; file: string; props: string[] }) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', minHeight: 0 }}>
      <div style={{
        padding: '8px 12px 4px',
        fontSize: 10, fontWeight: 700, color: '#6c7086',
        textTransform: 'uppercase', letterSpacing: '0.07em',
        borderBottom: '1px solid #1e1e2e',
        flexShrink: 0,
      }}>
        Choose expression
      </div>
      <div style={{ overflowY: 'auto', flex: 1, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {expressions.length === 0 && (
          <div style={{ color: '#6c7086', fontSize: 11, fontStyle: 'italic', padding: '4px 2px' }}>
            No expressions yet — create one in the Expressions tab.
          </div>
        )}
        {expressions.map(expr => {
          const chosen = chosenExpr?.name === expr.name
          return (
            <div
              key={expr.name}
              onClick={() => onChoose(expr)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
                border: chosen ? '1px solid #94e2d5' : '1px solid #313244',
                background: chosen ? 'rgba(148,226,213,0.10)' : '#181825',
              }}
            >
              <span style={{ color: '#94e2d5', fontWeight: 700, fontFamily: 'monospace' }}>ƒ</span>
              <span style={{ color: '#cdd6f4', fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{expr.name}</span>
              {expr.props.length > 0 && (
                <span style={{ color: '#6c7086', fontSize: 11, fontFamily: 'monospace' }}>({expr.props.join(', ')})</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ExpressionPickerPanel({
  pages,
  components,
  onInsert,
}: {
  pages: { id: string; label: string; root: string }[]
  components: { id: string; label: string; name: string }[]
  onInsert?: (tag: string) => void
}) {
  const [expanded, setExpanded] = useState(true)
  return (
    <div style={scopeStyles.panel}>
      <button style={scopeStyles.header} onClick={() => setExpanded(v => !v)}>
        <span style={scopeStyles.chevron}>{expanded ? '▾' : '▸'}</span>
        <span>Component Picker</span>
        <InfoIcon text="Click a chip to insert its JSX tag into the last-focused field in the expression tester." />
      </button>
      {expanded && (
        <div style={{ ...scopeStyles.body, padding: '8px 12px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {pages.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <span style={{ fontSize: 10, color: '#585b70', textTransform: 'uppercase' as const, letterSpacing: '0.06em', minWidth: 42, paddingTop: 4, fontWeight: 700 }}>pages</span>
              <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 5 }}>
                {pages.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => onInsert?.(p.root)}
                    title={`Insert <${p.root} />`}
                    style={{
                      padding: '2px 8px', borderRadius: 4,
                      border: '1px solid rgba(203,166,247,0.4)',
                      background: 'rgba(203,166,247,0.1)',
                      color: '#cba6f7', fontSize: 11,
                      fontFamily: '"Cascadia Code", monospace',
                      cursor: 'pointer',
                    }}
                  >&lt;{p.root} /&gt;</button>
                ))}
              </div>
            </div>
          )}
          {components.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <span style={{ fontSize: 10, color: '#585b70', textTransform: 'uppercase' as const, letterSpacing: '0.06em', minWidth: 42, paddingTop: 4, fontWeight: 700 }}>comps</span>
              <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 5 }}>
                {components.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => onInsert?.(c.name)}
                    title={`Insert <${c.name} />`}
                    style={{
                      padding: '2px 8px', borderRadius: 4,
                      border: '1px solid rgba(137,180,250,0.4)',
                      background: 'rgba(137,180,250,0.1)',
                      color: '#89b4fa', fontSize: 11,
                      fontFamily: '"Cascadia Code", monospace',
                      cursor: 'pointer',
                    }}
                  >&lt;{c.name} /&gt;</button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
