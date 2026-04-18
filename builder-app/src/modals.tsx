import { useState, useEffect } from 'react'
import type { ExpressionMeta } from './tree/DOMTreePanel'
import { modalStyles } from './appStyles'

// ─── Add Layout Modal ────────────────────────────────────────────────────────

function toLayoutComponentName(name: string): string {
  return name.trim()
    .replace(/(?:^|\s+)\w/g, (c) => c.trim().toUpperCase())
    .replace(/\s+/g, '') + 'Layout'
}

export function AddLayoutModal({
  onClose,
  onAdd,
  projectRoot,
}: {
  onClose: () => void
  onAdd: (layout: { id: string; label: string; name: string }) => void
  projectRoot: string
}) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const componentName = name.trim() ? toLayoutComponentName(name) : ''

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/__source/create-layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), projectRoot }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create layout')
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
          <span style={modalStyles.title}>New layout</span>
          <button style={modalStyles.closeBtn} onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={modalStyles.body}>
          <label style={modalStyles.label}>Layout name</label>
          <input
            autoFocus
            style={modalStyles.input}
            placeholder="e.g. App"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null) }}
          />

          {name.trim() && (
            <div style={modalStyles.preview}>
              <span style={modalStyles.previewKey}>Component</span>
              <span style={{ ...modalStyles.previewVal, color: '#94e2d2' }}>{componentName}</span>
              <span style={modalStyles.previewKey}>File</span>
              <span style={{ ...modalStyles.previewVal, color: '#94e2d2' }}>layouts/{name.trim().toLowerCase().replace(/\s+/g, '-')}/layout.tsx</span>
            </div>
          )}

          {error && <div style={modalStyles.error}>{error}</div>}

          <div style={modalStyles.actions}>
            <button type="button" style={modalStyles.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              style={{ ...modalStyles.submitBtn, background: !name.trim() || loading ? '#45475a' : '#94e2d2', opacity: !name.trim() || loading ? 0.5 : 1 }}
              disabled={!name.trim() || loading}
            >
              {loading ? 'Creating…' : 'Create layout'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

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

// ─── Add Feature Modal ────────────────────────────────────────────────────────

function toFeatureId(name: string): string {
  return name.trim().replace(/\s+/g, '-').toLowerCase()
}

export function AddFeatureModal({
  onClose,
  onAdd,
  projectRoot,
}: {
  onClose: () => void
  onAdd: (id: string) => void
  projectRoot: string
}) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const featureId = name.trim() ? toFeatureId(name) : ''

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!featureId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/__source/create-feature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: featureId, projectRoot }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create feature')
      onAdd(featureId)
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
          <span style={modalStyles.title}>New feature</span>
          <button style={modalStyles.closeBtn} onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit} style={modalStyles.body}>
          <label style={modalStyles.label}>Feature name</label>
          <input
            autoFocus
            style={modalStyles.input}
            placeholder="e.g. auth"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null) }}
          />
          {featureId && (
            <div style={modalStyles.preview}>
              <span style={modalStyles.previewKey}>Directory</span>
              <span style={{ ...modalStyles.previewVal, color: '#fab387' }}>src/features/{featureId}/</span>
            </div>
          )}
          {error && <div style={modalStyles.error}>{error}</div>}
          <div style={modalStyles.actions}>
            <button type="button" style={modalStyles.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              style={{ ...modalStyles.submitBtn, background: !featureId || loading ? '#45475a' : '#fab387', opacity: !featureId || loading ? 0.5 : 1, color: '#1e1e2e' }}
              disabled={!featureId || loading}
            >
              {loading ? 'Creating…' : 'Create feature'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Add Service Modal ────────────────────────────────────────────────────────

export function AddServiceModal({
  onClose,
  onAdd,
  projectRoot,
  featureId,
}: {
  onClose: () => void
  onAdd: (id: string) => void
  projectRoot: string
  featureId: string
}) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pascal = name.trim()
    ? name.trim().replace(/(?:^|[-_\s])\w/g, c => c.replace(/[-_\s]/, '').toUpperCase())
    : ''

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!pascal) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/__source/create-service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureId, name: name.trim(), projectRoot }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create service')
      onAdd(data.id ?? pascal)
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
          <span style={modalStyles.title}>New service</span>
          <button style={modalStyles.closeBtn} onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit} style={modalStyles.body}>
          <label style={modalStyles.label}>Service name</label>
          <input
            autoFocus
            style={modalStyles.input}
            placeholder="e.g. AuthService"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null) }}
          />
          {pascal && (
            <div style={modalStyles.preview}>
              <span style={modalStyles.previewKey}>File</span>
              <span style={{ ...modalStyles.previewVal, color: '#cba6f7' }}>src/features/{featureId}/{pascal}.ts</span>
            </div>
          )}
          {error && <div style={modalStyles.error}>{error}</div>}
          <div style={modalStyles.actions}>
            <button type="button" style={modalStyles.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              style={{ ...modalStyles.submitBtn, background: !pascal || loading ? '#45475a' : '#cba6f7', opacity: !pascal || loading ? 0.5 : 1, color: '#1e1e2e' }}
              disabled={!pascal || loading}
            >
              {loading ? 'Creating…' : 'Create service'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Add Flow Modal ───────────────────────────────────────────────────────────

export function AddFlowModal({
  onClose,
  onAdd,
  projectRoot,
  featureId,
}: {
  onClose: () => void
  onAdd: (id: string) => void
  projectRoot: string
  featureId: string
}) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pascal = name.trim()
    ? name.trim().replace(/(?:^|[-_\s])\w/g, c => c.replace(/[-_\s]/, '').toUpperCase())
    : ''

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!pascal) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/__source/create-flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureId, name: name.trim(), projectRoot }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to create flow')
      onAdd(data.id ?? pascal)
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
          <span style={modalStyles.title}>New XState flow</span>
          <button style={modalStyles.closeBtn} onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit} style={modalStyles.body}>
          <label style={modalStyles.label}>Flow name</label>
          <input
            autoFocus
            style={modalStyles.input}
            placeholder="e.g. AuthFlow"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null) }}
          />
          {pascal && (
            <div style={modalStyles.preview}>
              <span style={modalStyles.previewKey}>Machine</span>
              <span style={{ ...modalStyles.previewVal, color: '#a6e3a1' }}>src/features/{featureId}/{pascal}.machine.ts</span>
              <span style={modalStyles.previewKey}>Actor</span>
              <span style={{ ...modalStyles.previewVal, color: '#a6e3a1' }}>src/features/{featureId}/{pascal}.actor.ts</span>
            </div>
          )}
          {error && <div style={modalStyles.error}>{error}</div>}
          <div style={modalStyles.actions}>
            <button type="button" style={modalStyles.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              style={{ ...modalStyles.submitBtn, background: !pascal || loading ? '#45475a' : '#a6e3a1', opacity: !pascal || loading ? 0.5 : 1, color: '#1e1e2e' }}
              disabled={!pascal || loading}
            >
              {loading ? 'Creating…' : 'Create flow'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── AddPageToFeatureModal ─────────────────────────────────────────────────────

interface AddPageToFeatureModalProps {
  projectRoot: string
  featureId: string
  alreadyLinked: string[]
  onClose: () => void
  onAdd: (pageId: string) => void
}

export function AddPageToFeatureModal({ projectRoot, featureId, alreadyLinked, onClose, onAdd }: AddPageToFeatureModalProps) {
  const [pages, setPages] = useState<Array<{ id: string; label: string }>>([])
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/__source/list-pages?projectRoot=${encodeURIComponent(projectRoot)}`)
      .then(r => r.json())
      .then(data => {
        const available = (data.pages ?? []).filter((p: { id: string }) => !alreadyLinked.includes(p.id))
        setPages(available)
        if (available.length > 0) setSelected(available[0].id)
      })
      .catch(() => setError('Failed to load pages'))
  }, [projectRoot, alreadyLinked])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selected) return
    setLoading(true)
    setError(null)
    const res = await fetch('/__source/add-feature-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot, featureId, pageId: selected }),
    })
    const data = await res.json()
    setLoading(false)
    if (!res.ok) { setError(data.error ?? 'Error'); return }
    onAdd(selected)
  }

  return (
    <div style={modalStyles.overlay}>
      <div style={modalStyles.dialog}>
        <div style={modalStyles.header}>
          <span style={modalStyles.title}>Link page to feature</span>
          <button style={modalStyles.closeBtn} onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit} style={modalStyles.body}>
          <label style={modalStyles.label}>Page</label>
          {pages.length === 0 && !error && (
            <div style={{ color: '#45475a', fontSize: 12, fontStyle: 'italic', padding: '4px 0' }}>
              All pages already linked or no pages found.
            </div>
          )}
          {pages.length > 0 && (
            <select
              style={{ ...modalStyles.input, appearance: 'none' as const }}
              value={selected}
              onChange={e => setSelected(e.target.value)}
            >
              {pages.map(p => (
                <option key={p.id} value={p.id}>{p.label ?? p.id}</option>
              ))}
            </select>
          )}
          {selected && (
            <div style={modalStyles.preview}>
              <span style={modalStyles.previewKey}>Writes to</span>
              <span style={{ ...modalStyles.previewVal, color: '#89b4fa' }}>src/features/{featureId}/pages.ts</span>
            </div>
          )}
          {error && <div style={modalStyles.error}>{error}</div>}
          <div style={modalStyles.actions}>
            <button type="button" style={modalStyles.cancelBtn} onClick={onClose}>Cancel</button>
            <button
              type="submit"
              style={{ ...modalStyles.submitBtn, background: !selected || loading ? '#45475a' : '#89b4fa', opacity: !selected || loading ? 0.5 : 1, color: '#1e1e2e' }}
              disabled={!selected || loading || pages.length === 0}
            >
              {loading ? 'Linking…' : 'Link page'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
