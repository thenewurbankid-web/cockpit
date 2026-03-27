import { Component, lazy, Suspense, useEffect, useState } from 'react'

// Dynamically import the full login-app via the @login-app alias.
// Using a factory function so React.lazy gets a fresh import on HMR.
function loadApp() {
  return import('@login-app/App').then((mod) => ({
    default: mod.default,
  }))
}

const LoginApp = lazy(loadApp)

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

export function ComponentLoader() {
  // Increment to reset the ErrorBoundary after HMR updates (remounts the subtree).
  const [resetKey, setResetKey] = useState(0)
  const [loadError, setLoadError] = useState<Error | null>(null)

  useEffect(() => {
    setLoadError(null)
    // Reset error boundary every time a Vite HMR update lands so the
    // component retries rendering with the fresh module.
    if (import.meta.hot) {
      import.meta.hot.on('vite:afterUpdate', () => {
        setLoadError(null)
        setResetKey((k) => k + 1)
      })
    }
  }, [])

  if (loadError) return <ErrorFallback error={loadError} />

  return (
    <PreviewCanvas>
      <Suspense fallback={<div style={styles.loading}>Loading component…</div>}>
        <ErrorBoundary key={resetKey}>
          <LoginApp />
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
}
