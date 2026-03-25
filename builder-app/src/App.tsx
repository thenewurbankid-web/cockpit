import { useRef, useState } from 'react'
import { ComponentLoader } from './preview/ComponentLoader'
import { InspectorPanel } from './inspector/InspectorPanel'
import type { SelectedNodeContext } from './inspector/InspectorPanel'
import { useLocator } from './locator/useLocator'
import { DOMTreePanel } from './tree/DOMTreePanel'

export interface SourceLocation {
  file: string
  line: number
  inspectMode?: 'node' | 'component' | 'file'
  componentName?: string
}

const DEFAULT_PANEL_WIDTH = 480

export default function App() {
  const [location, setLocation] = useState<SourceLocation | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [selectedNode, setSelectedNode] = useState<SelectedNodeContext | null>(null)
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH)
  const canvasRef = useRef<HTMLDivElement>(null)

  function openInspector(
    file: string,
    line: number,
    inspectMode: 'node' | 'component' | 'file' = 'node',
    componentName?: string
  ) {
    setLocation({ file, line, inspectMode, componentName })
    setPanelOpen(true)
  }

  useLocator((loc) => openInspector(loc.file, loc.line))

  return (
    <div style={styles.root}>
      {/* Top bar */}
      <header style={styles.header}>
        <span style={styles.logo}>⚙ Architecture Builder</span>
        <span style={styles.hint}>Alt+Click any element — or click a node in the tree</span>
      </header>

      {/* Main area */}
      <div style={styles.main}>
        {/* Left: DOM tree */}
        <DOMTreePanel
          canvasRef={canvasRef}
          onLocate={openInspector}
          onNodeSelect={setSelectedNode}
          preferredRootComponentName="LoginPage"
        />

        {/* Center: preview canvas */}
        <div
          ref={canvasRef}
          style={{ ...styles.canvas, marginRight: panelOpen ? panelWidth : 0 }}
        >
          <ComponentLoader />
        </div>

        {/* Right: inspector */}
        {panelOpen && location && (
          <InspectorPanel
            file={location.file}
            line={location.line}
            inspectMode={location.inspectMode}
            componentName={location.componentName}
            selectedNode={selectedNode}
            rootComponentName="LoginPage"
            onClose={() => setPanelOpen(false)}
            onWidthChange={setPanelWidth}
          />
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '1.5rem',
    padding: '0.6rem 1.2rem',
    background: '#16213e',
    borderBottom: '1px solid #0f3460',
    flexShrink: 0,
  },
  logo: { fontWeight: 700, fontSize: '1rem', color: '#e94560', letterSpacing: 0.5 },
  hint: { fontSize: '0.78rem', color: '#9ca3af' },
  main: { flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' },
  canvas: {
    flex: 1,
    overflow: 'auto',
    background: '#f5f5f5',
    transition: 'margin-right 0.2s ease',
  },
}
