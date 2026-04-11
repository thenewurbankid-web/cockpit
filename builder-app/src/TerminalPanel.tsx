import { useEffect, useRef, useState } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

interface TerminalPanelProps {
  projectRoot: string
  onClose: () => void
}

export function TerminalPanel({ projectRoot, onClose }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting')

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      theme: {
        background: '#11111b',
        foreground: '#cdd6f4',
        cursor: '#f5c2e7',
        selectionBackground: 'rgba(137,180,250,0.3)',
        black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
        blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#bac2de',
        brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#cba6f7',
        brightCyan: '#94e2d5', brightWhite: '#a6adc8',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)

    termRef.current = term
    fitAddonRef.current = fitAddon

    // Small delay so the container has rendered dimensions before fitting
    const fitTimer = setTimeout(() => {
      try { fitAddon.fit() } catch { /* ignore */ }
    }, 50)

    const wsUrl = `ws://${window.location.host}/__terminal?root=${encodeURIComponent(projectRoot)}`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('open')
      try {
        fitAddon.fit()
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      } catch { /* ignore */ }
    }

    ws.onmessage = (e) => {
      term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data))
    }

    ws.onclose = () => {
      setStatus('closed')
      term.write('\r\n\x1b[2m[connection closed]\x1b[0m\r\n')
    }

    ws.onerror = () => {
      term.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n')
    }

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    })

    // Resize observer: refit the terminal when the panel size changes
    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      } catch { /* ignore */ }
    })
    if (containerRef.current) ro.observe(containerRef.current)

    return () => {
      clearTimeout(fitTimer)
      ro.disconnect()
      ws.close()
      term.dispose()
    }
  }, [projectRoot])

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        height: 340,
        zIndex: 3000,
        display: 'flex',
        flexDirection: 'column',
        background: '#11111b',
        borderTop: '1px solid #313244',
        boxShadow: '0 -8px 32px rgba(0,0,0,0.5)',
      }}
    >
      {/* Header bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 12px',
        height: 36,
        background: '#181825',
        borderBottom: '1px solid #313244',
        flexShrink: 0,
        fontFamily: 'system-ui, sans-serif',
        userSelect: 'none',
      }}>
        <span style={{ fontSize: 13, color: '#6c7086' }}>⬛</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#cdd6f4' }}>Terminal</span>
        <span style={{ fontSize: 11, color: '#6c7086', fontFamily: 'monospace', marginLeft: 4 }}>
          {projectRoot.replace(/.*[/\\]/, '')}
        </span>

        {/* Status dot */}
        <span style={{
          width: 6, height: 6, borderRadius: '50%', marginLeft: 6,
          background: status === 'open' ? '#a6e3a1' : status === 'connecting' ? '#f9e2af' : '#f38ba8',
        }} title={status} />

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {/* New terminal — reconnect */}
          {status === 'closed' && (
            <button
              title="Reconnect"
              onClick={() => window.location.reload()}
              style={btnStyle}
            >
              ↺
            </button>
          )}
          <button
            title="Close terminal"
            onClick={onClose}
            style={{ ...btnStyle, fontSize: 16 }}
          >
            ×
          </button>
        </div>
      </div>

      {/* xterm container */}
      <div
        ref={containerRef}
        style={{ flex: 1, overflow: 'hidden', padding: '4px 6px' }}
      />
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#6c7086',
  fontSize: 14,
  cursor: 'pointer',
  lineHeight: 1,
  padding: '2px 5px',
  borderRadius: 4,
}
