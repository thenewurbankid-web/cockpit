import { useState } from 'react'
import type { ExpressionMeta } from './tree/DOMTreePanel'
import { modalStyles } from './appStyles'

// ─── Add Expression Modal ────────────────────────────────────────────────────

export function AddExpressionModal({
  onClose,
  onAdd,
  projectRoot,
}: {
  onClose: () => void
  onAdd: (expr: ExpressionMeta) => void
  projectRoot: string
}) {
  const [name, setName] = useState('')
  const [props, setProps] = useState<string[]>([])
  const [propInput, setPropInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const componentName = name.trim()
    ? name.trim().replace(/(?:^|\s+)\w/g, (c) => c.trim().toUpperCase()).replace(/\s+/g, '')
    : ''

  function addProp() {
    const p = propInput.trim().replace(/\s+/g, '')
    if (!p || props.includes(p)) { setPropInput(''); return }
    setProps((v) => [...v, p])
    setPropInput('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/__source/create-expression', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), props, projectRoot }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create expression')
      onAdd({ name: data.componentName, file: data.file ?? '', props })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div style={modalStyles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>New expression</span>
          <button style={modalStyles.closeBtn} onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={modalStyles.body}>
          <label style={modalStyles.label}>Expression name</label>
          <input
            autoFocus
            style={modalStyles.input}
            placeholder="e.g. IfAdmin"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null) }}
          />

          {name.trim() && (
            <div style={modalStyles.preview}>
              <span style={modalStyles.previewKey}>Component</span>
              <span style={{ ...modalStyles.previewVal, color: '#94e2d5' }}>{componentName}</span>
              <span style={modalStyles.previewKey}>File</span>
              <span style={{ ...modalStyles.previewVal, color: '#94e2d5' }}>{componentName}.tsx</span>
            </div>
          )}

          <label style={modalStyles.label}>
            Props
            <span style={{ fontWeight: 400, color: '#6c7086', marginLeft: 4 }}>(optional)</span>
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              style={{ ...modalStyles.input, flex: 1 }}
              placeholder="propName — press Enter to add"
              value={propInput}
              onChange={(e) => setPropInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addProp() } }}
            />
            <button type="button" style={{ ...modalStyles.cancelBtn, padding: '0 14px' }} onClick={addProp}>Add</button>
          </div>
          {props.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 2 }}>
              {props.map((p) => (
                <span key={p} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 8px', borderRadius: 4,
                  background: 'rgba(137,180,250,0.15)',
                  border: '1px solid rgba(137,180,250,0.35)',
                  color: '#89b4fa', fontSize: 11, fontFamily: 'monospace',
                }}>
                  {p}
                  <span onClick={() => setProps((v) => v.filter((x) => x !== p))} style={{ cursor: 'pointer', color: '#6c7086', fontSize: 10 }}>✕</span>
                </span>
              ))}
            </div>
          )}

          {error && <div style={modalStyles.error}>{error}</div>}

          <div style={modalStyles.actions}>
            <button type="button" style={modalStyles.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              style={{ ...modalStyles.submitBtn, background: !name.trim() || loading ? '#45475a' : '#94e2d5', opacity: !name.trim() || loading ? 0.6 : 1 }}
              disabled={!name.trim() || loading}
            >
              {loading ? 'Creating…' : 'Create expression'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Add Component Modal ─────────────────────────────────────────────────────

function toComponentNameNoSuffix(name: string): string {
  return name.trim()
    .replace(/(?:^|\s+)\w/g, (c) => c.trim().toUpperCase())
    .replace(/\s+/g, '')
}

export function AddComponentModal({
  onClose,
  onAdd,
  projectRoot,
}: {
  onClose: () => void
  onAdd: (comp: { id: string; label: string; name: string }) => void
  projectRoot: string
}) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const componentName = name.trim() ? toComponentNameNoSuffix(name) : ''

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/__source/create-component', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), projectRoot }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create component')
      onAdd({ id: data.id, label: name.trim(), name: data.componentName })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div style={modalStyles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>New component</span>
          <button style={modalStyles.closeBtn} onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={modalStyles.body}>
          <label style={modalStyles.label}>Component name</label>
          <input
            autoFocus
            style={modalStyles.input}
            placeholder="e.g. Button"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null) }}
          />

          {name.trim() && (
            <div style={modalStyles.preview}>
              <span style={modalStyles.previewKey}>Component</span>
              <span style={modalStyles.previewVal}>{componentName}</span>
              <span style={modalStyles.previewKey}>File</span>
              <span style={modalStyles.previewVal}>{componentName}.tsx</span>
            </div>
          )}

          {error && <div style={modalStyles.error}>{error}</div>}

          <div style={modalStyles.actions}>
            <button type="button" style={modalStyles.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              style={{ ...modalStyles.submitBtn, opacity: !name.trim() || loading ? 0.5 : 1 }}
              disabled={!name.trim() || loading}
            >
              {loading ? 'Creating…' : 'Create component'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Add Page Modal ───────────────────────────────────────────────────────────

function toComponentName(name: string): string {
  return name.trim()
    .replace(/(?:^|\s+)\w/g, (c) => c.trim().toUpperCase())
    .replace(/\s+/g, '') + 'Page'
}
function toPageId(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}

export function AddPageModal({
  onClose,
  onAdd,
  projectRoot,
}: {
  onClose: () => void
  onAdd: (page: { id: string; label: string; root: string }) => void
  projectRoot: string
}) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const componentName = name.trim() ? toComponentName(name) : ''
  const id = name.trim() ? toPageId(name) : ''

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/__source/create-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), projectRoot }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create page')
      onAdd({ id: data.id, label: name.trim(), root: data.componentName })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div style={modalStyles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>New page</span>
          <button style={modalStyles.closeBtn} onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={modalStyles.body}>
          <label style={modalStyles.label}>Page name</label>
          <input
            autoFocus
            style={modalStyles.input}
            placeholder="e.g. Settings"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null) }}
          />

          {name.trim() && (
            <div style={modalStyles.preview}>
              <span style={modalStyles.previewKey}>Component</span>
              <span style={modalStyles.previewVal}>{componentName}</span>
              <span style={modalStyles.previewKey}>Route id</span>
              <span style={modalStyles.previewVal}>{id}</span>
            </div>
          )}

          {error && <div style={modalStyles.error}>{error}</div>}

          <div style={modalStyles.actions}>
            <button type="button" style={modalStyles.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              style={{ ...modalStyles.submitBtn, opacity: !name.trim() || loading ? 0.5 : 1 }}
              disabled={!name.trim() || loading}
            >
              {loading ? 'Creating…' : 'Create page'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
