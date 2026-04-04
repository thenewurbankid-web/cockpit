import { Component, lazy, Suspense, useEffect, useRef, useState } from 'react'

// Per-folder lazy caches so Suspense doesn't remount on every render.
// Cleared on HMR so edits always produce a fresh import.
const pageCache = new Map<string, ReturnType<typeof lazy>>()
const componentCache = new Map<string, ReturnType<typeof lazy>>()

// ── forced refresh API ───────────────────────────────────────────────────────
// Allows InspectorPanel (and any other caller) to directly trigger a preview
// remount without relying on Vite's file-watcher pipeline. This is important
// when files are saved via POST /__source and either: (a) the watcher hasn't
// fired yet, (b) the same bytes are written again (no mtime change), or (c) the
// file isn't in Vite's watch graph at the moment of the write.
const refreshCallbacks = new Set<() => void>()

// Timestamp appended as ?t= to dynamic import URLs so the browser's
// native ES module cache is bypassed on forced refreshes — the same
// mechanism Vite uses internally for HMR-invalidated modules.
let importTimestamp = 0

export function notifyPreviewRefresh(): void {
  importTimestamp = Date.now()
  pageCache.clear()
  componentCache.clear()
  refreshCallbacks.forEach((cb) => cb())
}

if (import.meta.hot) {
  const clearCaches = () => {
    importTimestamp = Date.now()
    pageCache.clear()
    componentCache.clear()
  }
  import.meta.hot.on('vite:afterUpdate', clearCaches)
  import.meta.hot.on('project:update', clearCaches)
}

async function probeTransform(url: string): Promise<void> {
  console.log('[ComponentLoader] probeTransform →', url)
  const res = await fetch(url)
  console.log('[ComponentLoader] probeTransform ←', url, res.status, res.ok ? 'OK' : 'FAIL')
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // Try to extract the unresolved package name from Vite's error message.
    const missingMatch = body.match(/Failed to resolve import ["']([^"']+)["']/)
    if (missingMatch) {
      const spec = missingMatch[1]
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      throw new Error(`MISSING_PACKAGE:${pkg}\nCould not resolve package "${pkg}".\n\nFile: ${url.replace('/@fs/', '')}`)
    }
    // Only fail for actual Next.js server-side modules, not the 'use client' pragma
    // which is harmless in a client-only Vite environment.
    const isNextJs = /\bnext\/(navigation|headers|server|cache|image|link|router)\b/.test(body)
    if (isNextJs) {
      const err = new Error(`This component uses Next.js server APIs (next/navigation, next/headers, etc.) that are not compatible with the Vite-based preview.\n\nFile: ${url.replace('/@fs/', '')}`)
      console.error('[ComponentLoader] Next.js server API detected:', err.message)
      throw err
    }
    const err = new Error(`Vite could not transform the module (HTTP ${res.status}).\n\nFile: ${url.replace('/@fs/', '')}\n\n${body.slice(0, 400)}`)
    console.error('[ComponentLoader] transform failed:', err.message)
    throw err
  }
  console.log('[ComponentLoader] probeTransform OK, proceeding with dynamic import →', url)
}

function getLazyPage(componentName: string, pagesDir: string, componentPath?: string) {
  const filePath = componentPath ?? componentName
  const key = `${pagesDir}/${filePath}`
  if (!pageCache.has(key)) {
    const baseUrl = `/@fs/${pagesDir}/${filePath}.tsx`
    const url = importTimestamp > 0 ? `${baseUrl}?t=${importTimestamp}` : baseUrl
    console.log('[ComponentLoader] creating lazy entry for page:', componentName, url)
    pageCache.set(
      key,
      lazy(() => {
        console.log('[ComponentLoader] lazy() invoked for page:', componentName)
        return probeTransform(url).then(() => {
          console.log('[ComponentLoader] dynamic import() starting:', url)
          return import(/* @vite-ignore */ url).then((m) => {
            console.log('[ComponentLoader] dynamic import() resolved, named exports:', JSON.stringify(Object.keys(m)))
            const comp = (m[componentName] ?? m.default) as React.ComponentType<unknown>
            if (!comp) console.warn('[ComponentLoader] export not found:', componentName, '— available:', Object.keys(m))
            return { default: comp }
          })
        }).catch((e: unknown) => {
          console.error('[ComponentLoader] load failed for', componentName, ':', e)
          throw e
        })
      })
    )
  }
  return pageCache.get(key)!
}

function getLazyComponent(componentName: string, componentsDir: string, componentPath?: string) {
  const filePath = componentPath ?? componentName
  const key = `${componentsDir}/${filePath}`
  if (!componentCache.has(key)) {
    const baseUrl = `/@fs/${componentsDir}/${filePath}.tsx`
    const url = importTimestamp > 0 ? `${baseUrl}?t=${importTimestamp}` : baseUrl
    console.log('[ComponentLoader] creating lazy entry for component:', componentName, url)
    componentCache.set(
      key,
      lazy(() => {
        console.log('[ComponentLoader] lazy() invoked for:', componentName)
        return probeTransform(url).then(() => {
          console.log('[ComponentLoader] dynamic import() starting:', url)
          return import(/* @vite-ignore */ url).then((m) => {
            console.log('[ComponentLoader] dynamic import() resolved, named exports:', JSON.stringify(Object.keys(m)))
            const comp = (m[componentName] ?? m.default) as React.ComponentType<unknown>
            if (!comp) console.warn('[ComponentLoader] export not found:', componentName, '— available:', Object.keys(m))
            return { default: comp }
          })
        }).catch((e: unknown) => {
          console.error('[ComponentLoader] load failed for', componentName, ':', e)
          throw e
        })
      })
    )
  }
  return componentCache.get(key)!
}

function MissingPackagesBanner({ packages, onOpenSettings, onDismiss }: {
  packages: string[]
  onOpenSettings?: () => void
  onDismiss: () => void
}) {
  return (
    <div style={styles.missingBanner}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ fontSize: '1rem', lineHeight: 1 }}>⚠</span>
        <div style={{ flex: 1 }}>
          <strong style={{ display: 'block', marginBottom: 4 }}>
            Missing packages: {packages.map((p, i) => (
              <span key={p}><code style={styles.pkgBadge}>{p}</code>{i < packages.length - 1 ? ', ' : ''}</span>
            ))}
          </strong>
          <span style={{ fontSize: '0.78rem', color: '#78350f' }}>
            These imports couldn't be found in any configured node_modules folder.
            The component may render blank or fail to load.
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
          {onOpenSettings && (
            <button onClick={onOpenSettings} style={styles.installBtn}>
              Open Settings to install
            </button>
          )}
          <button onClick={onDismiss} style={styles.dismissBtn} title="Dismiss">✕</button>
        </div>
      </div>
    </div>
  )
}

function ErrorFallback({ error, onOpenSource }: { error: Error; onOpenSource?: () => void }) {
  return (
    <div data-load-error="true" style={styles.error}>
      <strong>Runtime error in component</strong>
      <pre style={styles.pre}>{error.message}</pre>
      <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: '#6b7280' }}>
        Use the &#8630; Undo button in the inspector to revert the last change.
      </p>
      {onOpenSource && (
        <button onClick={onOpenSource} style={{ ...styles.sourceToggleBtn, marginTop: 10 }}>View source</button>
      )}
    </div>
  )
}

interface EBState { error: Error | null }
class ErrorBoundary extends Component<{ children: React.ReactNode; onOpenSource?: () => void; onRuntimeError?: () => void }, EBState> {
  state: EBState = { error: null }
  static getDerivedStateFromError(error: Error): EBState { return { error } }
  componentDidCatch(_error: Error, _info: React.ErrorInfo) {
    // Auto-open the source tab so the user can immediately see the file.
    this.props.onOpenSource?.()
    this.props.onRuntimeError?.()
  }
  render() {
    if (this.state.error) return <ErrorFallback error={this.state.error} onOpenSource={this.props.onOpenSource} />
    return this.props.children
  }
}

// Render children directly so the canvasRef in App.tsx contains the
// login-app DOM nodes at the top level (needed for DOMTreePanel).
function PreviewCanvas({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

// Detects when a component's rendered output is empty and shows a helpful hint.
// Uses a debounce so transient states (AnimatePresence unmounting, lazy load) don't flicker.
const EMPTY_DEBOUNCE_MS = 800

function EmptyDetector({ children }: { children: React.ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [empty, setEmpty] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return

    const isVisuallyEmpty = () =>
      el.childElementCount === 0 && (el.textContent ?? '').trim().length === 0

    const schedule = () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        setEmpty(isVisuallyEmpty())
      }, EMPTY_DEBOUNCE_MS)
    }

    const obs = new MutationObserver(schedule)
    obs.observe(el, { childList: true, subtree: true, characterData: true })
    schedule()
    return () => { obs.disconnect(); if (timerRef.current) clearTimeout(timerRef.current) }
  }, [])

  return (
    <>
      <div ref={wrapRef}>
        {children}
      </div>
      {empty && (
        <div style={styles.emptyHint}>
          <span style={{ fontSize: '1.1rem' }}>&#8635;</span>
          {' '}This component renders nothing in its initial state — it may need user interaction or specific app state to become visible.
        </div>
      )}
    </>
  )
}

// Wraps a component for isolated preview. Catches prop-related render errors and
// re-renders with a friendly explanation rather than a raw crash message.
class ComponentPreviewShell extends Component<
  { Component: React.ComponentType<Record<string, unknown>>; filePath: string; onOpenSource?: () => void; onRuntimeError?: () => void },
  { crashed: boolean; error: Error | null }
> {
  state = { crashed: false, error: null }
  static getDerivedStateFromError(error: Error) { return { crashed: true, error } }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ComponentPreviewShell] render crash in', this.props.Component?.displayName ?? this.props.Component?.name ?? '(unknown)', '\nError:', error.message, '\nStack:', error.stack, '\nComponent stack:', info.componentStack)
    this.props.onRuntimeError?.()
  }
  render() {
    if (this.state.crashed) {
      const msg = (this.state.error as Error | null)?.message ?? ''
      const { onOpenSource } = this.props
      const isModuleError = msg.includes('Failed to fetch dynamically imported module') || msg.includes('error loading dynamically imported module') || msg.includes('Vite could not transform') || msg.includes('Next.js server APIs') || msg.startsWith('MISSING_PACKAGE:')
      const missingPkg = msg.startsWith('MISSING_PACKAGE:') ? msg.split('\n')[0].replace('MISSING_PACKAGE:', '') : null
      if (isModuleError) {
        return (
          <div data-load-error="true" style={styles.error}>
            <strong>Failed to load module</strong>
            {missingPkg && (
              <p style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: '#7c2d12' }}>
                Missing package: <code style={{ background: '#fed7aa', padding: '1px 5px', borderRadius: 3 }}>{missingPkg}</code>
                {' — open ⚙ Settings to install it.'}
              </p>
            )}
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: '#6b7280' }}>
              The component or one of its dependencies could not be fetched. Check that all imports resolve correctly.
            </p>
            <pre style={{ ...styles.pre, marginTop: 8 }}>{msg.replace(/^MISSING_PACKAGE:[^\n]+\n/, '')}</pre>
            {onOpenSource && <button onClick={onOpenSource} style={{ ...styles.sourceToggleBtn, marginTop: 10 }}>View source</button>}
          </div>
        )
      }
      return (
        <div data-load-error="true" style={styles.propError}>
          <strong style={{ display: 'block', marginBottom: 6 }}>Component requires props to render</strong>
          <p style={{ margin: 0, fontSize: '0.75rem', color: '#6b7280' }}>
            This component has required props. Open the file in your editor and add default values or a story/demo wrapper.
          </p>
          {this.state.error && (
            <pre style={{ ...styles.pre, marginTop: 8, color: '#991b1b' }}>
              {msg}
            </pre>
          )}
          {onOpenSource && <button onClick={onOpenSource} style={{ ...styles.sourceToggleBtn, marginTop: 10 }}>View source</button>}
        </div>
      )
    }
    const { Component } = this.props
    return <EmptyDetector><Component /></EmptyDetector>
  }
}

export function ComponentLoader({
  page,
  componentName,
  componentPath,
  folder = 'pages',
  pagesDir,
  componentsDir,
  onOpenSettings,
  onOpenSource,
  onRuntimeError,
}: {
  page: string
  componentName: string
  componentPath?: string
  folder?: 'pages' | 'components'
  pagesDir: string
  componentsDir: string
  onOpenSettings?: (pkgs: string[]) => void
  onOpenSource?: (filePath: string) => void
  onRuntimeError?: () => void
}) {
  // Increment to reset the ErrorBoundary after HMR updates (remounts the subtree).
  const [resetKey, setResetKey] = useState(0)
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [missingPackages, setMissingPackages] = useState<string[]>([])
  const [bannerDismissed, setBannerDismissed] = useState(false)

  const resolvedPath = componentPath ?? componentName

  // Reset error boundary and import scan when the component switches.
  useEffect(() => {
    setLoadError(null)
    setMissingPackages([])
    setBannerDismissed(false)
    setResetKey(k => k + 1)
  }, [page, folder, componentName])

  // Scan the source file's direct imports and report unresolved packages.
  useEffect(() => {
    const absFile = folder === 'components'
      ? `${componentsDir}/${resolvedPath}.tsx`
      : `${pagesDir}/${resolvedPath}.tsx`
    fetch(`/__source/check-imports?file=${encodeURIComponent(absFile)}`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data.missing) && data.missing.length > 0) {
          setMissingPackages(data.missing)
          setBannerDismissed(false)
        }
      })
      .catch(() => {})
  }, [page, folder, componentName, pagesDir, componentsDir])

  useEffect(() => {
    // Register this instance so notifyPreviewRefresh() can force a remount.
    const refresh = () => {
      setLoadError(null)
      setResetKey((k) => k + 1)
    }
    refreshCallbacks.add(refresh)
    return () => { refreshCallbacks.delete(refresh) }
  }, [])

  useEffect(() => {
    if (import.meta.hot) {
      const refresh = () => {
        pageCache.clear()
        componentCache.clear()
        setLoadError(null)
        setResetKey((k) => k + 1)
      }
      // vite:afterUpdate fires for files inside the builder-app module graph.
      // project:update fires for files in external projects (e.g. max-ai-ui) that
      // Vite watches but handles outside its normal HMR pipeline.
      import.meta.hot.on('vite:afterUpdate', refresh)
      import.meta.hot.on('project:update', refresh)
    }
  }, [])

  const filePath = folder === 'components'
    ? `${componentsDir}/${resolvedPath}.tsx`
    : `${pagesDir}/${resolvedPath}.tsx`

  if (loadError) return <ErrorFallback error={loadError} onOpenSource={onOpenSource ? () => onOpenSource(filePath) : undefined} />

  const Loaded = folder === 'components'
    ? getLazyComponent(componentName, componentsDir, resolvedPath)
    : getLazyPage(componentName, pagesDir, resolvedPath)

  return (
    <PreviewCanvas>
      {missingPackages.length > 0 && !bannerDismissed && (
        <MissingPackagesBanner
          packages={missingPackages}
          onOpenSettings={onOpenSettings ? (pkgs) => onOpenSettings(pkgs) : undefined}
          onDismiss={() => setBannerDismissed(true)}
        />
      )}
      <Suspense fallback={<div style={styles.loading}>Loading component…</div>}>
        <ErrorBoundary key={`${folder}-${page}-${resetKey}`} onOpenSource={onOpenSource ? () => onOpenSource(filePath) : undefined} onRuntimeError={onRuntimeError}>
          {folder === 'components'
            ? <ComponentPreviewShell Component={Loaded} filePath={filePath} onOpenSource={onOpenSource ? () => onOpenSource(filePath) : undefined} onRuntimeError={onRuntimeError} />
            : <Loaded />}
        </ErrorBoundary>
      </Suspense>
    </PreviewCanvas>
  )
}

const styles: Record<string, React.CSSProperties> = {
  canvas: {
    minHeight: '100%',
    background: '#f5f5f5',
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 200,
    color: '#6b7280',
    fontSize: '0.9rem',
  },
  missingBanner: {
    margin: '1rem 1rem 0',
    padding: '0.75rem 1rem',
    background: '#fffbeb',
    border: '1px solid #fbbf24',
    borderRadius: 6,
    color: '#78350f',
    fontSize: '0.82rem',
  },
  pkgBadge: {
    display: 'inline-block',
    background: '#fef3c7',
    border: '1px solid #fbbf24',
    borderRadius: 3,
    padding: '0 5px',
    fontFamily: 'monospace',
    fontSize: '0.85em',
  },
  installBtn: {
    padding: '4px 10px',
    background: '#f59e0b',
    border: 'none',
    borderRadius: 4,
    color: '#fff',
    fontSize: '0.78rem',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },
  dismissBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: '#92400e',
    fontSize: '0.8rem',
    padding: '2px 4px',
  },
  sourceToggleBtn: {
    background: 'none',
    border: '1px solid currentColor',
    borderRadius: 4,
    padding: '2px 8px',
    cursor: 'pointer',
    fontSize: '0.75rem',
    color: 'inherit',
    opacity: 0.7,
  },
  error: {
    margin: '2rem',
    padding: '1rem',
    background: '#fef2f2',
    border: '1px solid #fca5a5',
    borderRadius: 6,
    color: '#991b1b',
  },
  pre: {
    marginTop: 8,
    fontSize: '0.8rem',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  propError: {
    margin: '2rem',
    padding: '1rem',
    background: '#fffbeb',
    border: '1px solid #fbbf24',
    borderRadius: 6,
    color: '#92400e',
    fontSize: '0.85rem',
  },
  emptyHint: {
    margin: '2rem',
    padding: '0.9rem 1rem',
    background: '#f0f9ff',
    border: '1px solid #7dd3fc',
    borderRadius: 6,
    color: '#075985',
    fontSize: '0.83rem',
    lineHeight: 1.5,
  },
}
