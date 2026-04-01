import { Component, lazy, Suspense, useEffect, useState } from 'react'

// Per-folder lazy caches so Suspense doesn't remount on every render.
// Cleared on HMR so edits always produce a fresh import.
const pageCache = new Map<string, ReturnType<typeof lazy>>()
const componentCache = new Map<string, ReturnType<typeof lazy>>()

if (import.meta.hot) {
  import.meta.hot.on('vite:afterUpdate', () => {
    pageCache.clear()
    componentCache.clear()
  })
}

function getLazyPage(componentName: string, pagesDir: string) {
  const key = `${pagesDir}/${componentName}`
  if (!pageCache.has(key)) {
    pageCache.set(
      key,
      lazy(() =>
        import(/* @vite-ignore */ `/@fs/${pagesDir}/${componentName}.tsx`).then(
          (m) => ({ default: m[componentName] as React.ComponentType<unknown> })
        )
      )
    )
  }
  return pageCache.get(key)!
}

function getLazyComponent(componentName: string, componentsDir: string) {
  const key = `${componentsDir}/${componentName}`
  if (!componentCache.has(key)) {
    componentCache.set(
      key,
      lazy(() =>
        import(/* @vite-ignore */ `/@fs/${componentsDir}/${componentName}.tsx`).then(
          (m) => ({ default: m[componentName] as React.ComponentType<unknown> })
        )
      )
    )
  }
  return componentCache.get(key)!
}

function ErrorFallback({ error }: { error: Error }) {
  return (
    <div style={styles.error}>
      <strong>Runtime error in component</strong>
      <pre style={styles.pre}>{error.message}</pre>
      <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: '#6b7280' }}>
        Use the &#8630; Undo button in the inspector to revert the last change.
      </p>
    </div>
  )
}

interface EBState { error: Error | null }
class ErrorBoundary extends Component<{ children: React.ReactNode }, EBState> {
  state: EBState = { error: null }
  static getDerivedStateFromError(error: Error): EBState { return { error } }
  render() {
    if (this.state.error) return <ErrorFallback error={this.state.error} />
    return this.props.children
  }
}

// Render children directly so the canvasRef in App.tsx contains the
// login-app DOM nodes at the top level (needed for DOMTreePanel).
function PreviewCanvas({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

// Wraps a component for isolated preview. Catches prop-related render errors and
// re-renders with a friendly explanation rather than a raw crash message.
class ComponentPreviewShell extends Component<
  { Component: React.ComponentType<Record<string, unknown>> },
  { crashed: boolean; error: Error | null }
> {
  state = { crashed: false, error: null }
  static getDerivedStateFromError(error: Error) { return { crashed: true, error } }
  render() {
    if (this.state.crashed) {
      return (
        <div style={styles.propError}>
          <strong style={{ display: 'block', marginBottom: 6 }}>Component requires props to render</strong>
          <p style={{ margin: 0, fontSize: '0.75rem', color: '#6b7280' }}>
            This component has required props. Open the file in your editor and add default values or a story/demo wrapper.
          </p>
          {this.state.error && (
            <pre style={{ ...styles.pre, marginTop: 8, color: '#991b1b' }}>
              {(this.state.error as Error).message}
            </pre>
          )}
        </div>
      )
    }
    const { Component } = this.props
    return <Component />
  }
}

export function ComponentLoader({
  page,
  componentName,
  folder = 'pages',
  pagesDir,
  componentsDir,
}: {
  page: string
  componentName: string
  folder?: 'pages' | 'components'
  pagesDir: string
  componentsDir: string
}) {
  // Increment to reset the ErrorBoundary after HMR updates (remounts the subtree).
  const [resetKey, setResetKey] = useState(0)
  const [loadError, setLoadError] = useState<Error | null>(null)

  // Reset error boundary when the page or folder switches.
  useEffect(() => {
    setLoadError(null)
    setResetKey(k => k + 1)
  }, [page, folder])

  useEffect(() => {
    if (import.meta.hot) {
      import.meta.hot.on('vite:afterUpdate', () => {
        setLoadError(null)
        setResetKey((k) => k + 1)
      })
    }
  }, [])

  if (loadError) return <ErrorFallback error={loadError} />

  const Loaded = folder === 'components'
    ? getLazyComponent(componentName, componentsDir)
    : getLazyPage(componentName, pagesDir)

  return (
    <PreviewCanvas>
      <Suspense fallback={<div style={styles.loading}>Loading component…</div>}>
        <ErrorBoundary key={`${folder}-${page}-${resetKey}`}>
          {folder === 'components'
            ? <ComponentPreviewShell Component={Loaded} />
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
}
