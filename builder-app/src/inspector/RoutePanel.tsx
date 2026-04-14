import { useEffect, useRef, useState } from 'react'

interface RoutePanelProps {
  pageId: string
  projectRoot: string
  layouts: { id: string; name: string }[]
  onRouteChange: (route: string | null, layoutId: string | null) => void
}

export function RoutePanel({ pageId, projectRoot, layouts, onRouteChange }: RoutePanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [route, setRoute] = useState('')
  const [layoutId, setLayoutId] = useState('')
  const [savedRoute, setSavedRoute] = useState('')
  const [savedLayoutId, setSavedLayoutId] = useState('')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [hasRoute, setHasRoute] = useState(false)
  const onRouteChangeRef = useRef(onRouteChange)
  useEffect(() => { onRouteChangeRef.current = onRouteChange }, [onRouteChange])

  useEffect(() => {
    if (!projectRoot || !pageId) return
    setStatus('idle')
    setHasRoute(false)
    fetch(`/__source/list-routes?projectRoot=${encodeURIComponent(projectRoot)}`)
      .then(r => r.json())
      .then((data: { routes?: { pageId: string; route: string; layoutId?: string | null }[] }) => {
        const entry = (data.routes ?? []).find(r => r.pageId === pageId)
        if (entry) {
          const r = entry.route ?? ''
          const l = entry.layoutId ?? ''
          setRoute(r)
          setLayoutId(l)
          setSavedRoute(r)
          setSavedLayoutId(l)
          setHasRoute(true)
        } else {
          setRoute('')
          setLayoutId('')
          setSavedRoute('')
          setSavedLayoutId('')
          setHasRoute(false)
        }
      })
      .catch(() => {})
  }, [pageId, projectRoot])

  const handleSave = async () => {
    const normalized = route.trim().startsWith('/') ? route.trim() : '/' + route.trim()
    if (!normalized || normalized === '/') {
      setStatus('error')
      setErrorMsg('Enter a route path')
      return
    }
    setSaving(true)
    setStatus('idle')
    try {
      const res = await fetch('/__source/assign-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRoot, pageId, route: normalized, layoutId: layoutId || null }),
      })
      const data = await res.json()
      if (!res.ok) {
        setStatus('error')
        setErrorMsg(data.error ?? 'Failed')
      } else {
        setHasRoute(true)
        const r2 = data.route ?? normalized
        setRoute(r2)
        setSavedRoute(r2)
        setSavedLayoutId(layoutId)
        setStatus('saved')
        onRouteChangeRef.current(r2, layoutId || null)
        setTimeout(() => setStatus('idle'), 2000)
      }
    } catch (e) {
      setStatus('error')
      setErrorMsg(String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async () => {
    setSaving(true)
    try {
      await fetch(
        `/__source/route?projectRoot=${encodeURIComponent(projectRoot)}&pageId=${encodeURIComponent(pageId)}`,
        { method: 'DELETE' },
      )
      setRoute('')
      setLayoutId('')
      setHasRoute(false)
      setStatus('idle')
      onRouteChangeRef.current(null, null)
    } catch { /* ignore */ } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ flexShrink: 0 }}>
      <div
        style={{
          padding: '0.5rem 0.75rem',
          background: '#181825',
          borderBottom: '1px solid #313244',
          color: '#6c7086',
          fontWeight: 600,
          fontSize: 10,
          flexShrink: 0,
          fontFamily: 'system-ui, sans-serif',
          textTransform: 'uppercase' as const,
          letterSpacing: '0.07em',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
        onClick={() => setExpanded(v => !v)}
      >
        <span style={{ fontSize: 9, color: '#6c7086', transition: 'transform 0.15s', display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
        Route
        {hasRoute && (
          <span style={{
            marginLeft: 6,
            background: 'rgba(137,180,250,0.12)',
            border: '1px solid rgba(137,180,250,0.3)',
            borderRadius: 10,
            color: '#89b4fa',
            fontSize: '0.65rem',
            fontWeight: 700,
            padding: '1px 7px',
            letterSpacing: 0,
            textTransform: 'none',
          }}>{route}</span>
        )}
      </div>
      {expanded && (
        <div style={{ padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: '0.68rem', color: '#7f849c', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Path</label>
            <input
              type="text"
              value={route}
              onChange={e => setRoute(e.target.value)}
              placeholder="/my-route"
              style={{
                background: '#11111b',
                border: '1px solid #313244',
                borderRadius: 5,
                color: '#cdd6f4',
                fontSize: '0.82rem',
                fontFamily: 'monospace',
                padding: '5px 8px',
                outline: 'none',
              }}
              onKeyDown={e => { if (e.key === 'Enter') void handleSave() }}
            />
          </div>
          {layouts.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: '0.68rem', color: '#7f849c', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Layout</label>
              <select
                value={layoutId}
                onChange={e => setLayoutId(e.target.value)}
                style={{
                  background: '#11111b',
                  border: '1px solid #313244',
                  borderRadius: 5,
                  color: layoutId ? '#cdd6f4' : '#7f849c',
                  fontSize: '0.82rem',
                  padding: '5px 8px',
                  outline: 'none',
                }}
              >
                <option value="">No layout</option>
                {layouts.map(l => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
          )}
          {status === 'error' && (
            <div style={{ fontSize: '0.72rem', color: '#f38ba8' }}>{errorMsg}</div>
          )}
          {status === 'saved' && (
            <div style={{ fontSize: '0.72rem', color: '#a6e3a1' }}>Route assigned!</div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            {(route !== savedRoute || layoutId !== savedLayoutId) && (
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{
                flex: 1,
                background: '#89b4fa',
                color: '#1e1e2e',
                border: 'none',
                borderRadius: 5,
                fontSize: '0.78rem',
                fontWeight: 700,
                padding: '5px 0',
                cursor: saving ? 'default' : 'pointer',
                opacity: saving ? 0.6 : 1,
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            )}
            {hasRoute && (
              <button
                onClick={() => void handleRemove()}
                disabled={saving}
                style={{
                  background: 'transparent',
                  border: '1px solid #f38ba8',
                  borderRadius: 5,
                  color: '#f38ba8',
                  fontSize: '0.78rem',
                  fontWeight: 700,
                  padding: '5px 12px',
                  cursor: saving ? 'default' : 'pointer',
                  opacity: saving ? 0.6 : 1,
                }}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
