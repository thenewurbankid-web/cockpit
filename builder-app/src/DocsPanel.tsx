import { useState } from 'react'

interface DocsPanelProps {
  onClose: () => void
}

type DocSection = 'introduction' | 'installation' | 'how-to-use' | 'api-reference'

const SECTIONS: { id: DocSection; label: string; icon: string }[] = [
  { id: 'introduction', label: 'Introduction', icon: '✦' },
  { id: 'installation', label: 'Installation Guide', icon: '⬇' },
  { id: 'how-to-use', label: 'How to Use', icon: '🧭' },
  { id: 'api-reference', label: 'API Reference', icon: '⚡' },
]

// ── Shared typography styles ──────────────────────────────────────────────────

const s = {
  h1: { fontSize: 22, fontWeight: 700, color: '#cdd6f4', marginBottom: 8, fontFamily: 'system-ui, sans-serif' } as React.CSSProperties,
  h2: { fontSize: 15, fontWeight: 600, color: '#cdd6f4', marginBottom: 6, marginTop: 24, fontFamily: 'system-ui, sans-serif' } as React.CSSProperties,
  h3: { fontSize: 13, fontWeight: 600, color: '#a6adc8', marginBottom: 4, marginTop: 16, fontFamily: 'system-ui, sans-serif' } as React.CSSProperties,
  p: { fontSize: 13, color: '#a6adc8', lineHeight: 1.7, margin: '0 0 12px 0', fontFamily: 'system-ui, sans-serif' } as React.CSSProperties,
  code: { fontFamily: 'monospace', background: 'rgba(137,180,250,0.12)', padding: '1px 6px', borderRadius: 3, color: '#89b4fa', fontSize: 12 } as React.CSSProperties,
  pre: {
    background: '#181825', border: '1px solid #313244', borderRadius: 7,
    padding: '12px 14px', fontFamily: 'monospace', fontSize: 12,
    color: '#cdd6f4', overflowX: 'auto' as const, margin: '8px 0 16px 0', lineHeight: 1.6,
  } as React.CSSProperties,
  badge: {
    display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11,
    fontWeight: 600, fontFamily: 'system-ui, sans-serif', marginRight: 6,
  } as React.CSSProperties,
  divider: { borderTop: '1px solid #313244', margin: '20px 0' } as React.CSSProperties,
  ul: { paddingLeft: 20, margin: '0 0 12px 0' } as React.CSSProperties,
  li: { fontSize: 13, color: '#a6adc8', lineHeight: 1.8, fontFamily: 'system-ui, sans-serif' } as React.CSSProperties,
  tag: {
    display: 'inline-block', background: 'rgba(166,227,161,0.12)', border: '1px solid rgba(166,227,161,0.2)',
    color: '#a6e3a1', borderRadius: 4, padding: '1px 7px', fontSize: 11,
    fontFamily: 'monospace', marginRight: 4,
  } as React.CSSProperties,
  methodTag: {
    display: 'inline-block', background: 'rgba(137,180,250,0.12)', border: '1px solid rgba(137,180,250,0.2)',
    color: '#89b4fa', borderRadius: 4, padding: '1px 7px', fontSize: 11,
    fontFamily: 'monospace', marginRight: 6,
  } as React.CSSProperties,
  endpointRow: {
    display: 'grid', gridTemplateColumns: '64px 220px 1fr',
    gap: 10, alignItems: 'start',
    padding: '8px 0', borderBottom: '1px solid #1e1e2e',
    fontFamily: 'system-ui, sans-serif',
  } as React.CSSProperties,
}

// ── Section content components ─────────────────────────────────────────────────

function IntroductionContent() {
  return (
    <div>
      <h1 style={s.h1}>Welcome to Cockpit</h1>
      <p style={s.p}>
        Cockpit is a visual dev tool for inspecting and editing React component source code in real time —
        built for agentic development workflows. An AI agent modifies <strong style={{ color: '#cdd6f4' }}>target project</strong> source
        files and you review the live result in the builder canvas.
      </p>

      <div style={s.divider} />

      <h2 style={s.h2}>What Cockpit Does</h2>
      <ul style={s.ul}>
        <li style={s.li}>📐 <strong style={{ color: '#cdd6f4' }}>Visual Canvas</strong> — Live preview of your React app rendered in an iframe with HMR.</li>
        <li style={s.li}>🌳 <strong style={{ color: '#cdd6f4' }}>DOM Tree Panel</strong> — Browse pages, components, and expressions with a fiber-based tree.</li>
        <li style={s.li}>🔍 <strong style={{ color: '#cdd6f4' }}>Inspector Panel</strong> — Click any element to inspect and edit its props, text, and styles via AST rewriting.</li>
        <li style={s.li}>🤖 <strong style={{ color: '#cdd6f4' }}>Agentic-first</strong> — Source API lets AI agents read and write files with full TypeScript diagnostics.</li>
        <li style={s.li}>🎭 <strong style={{ color: '#cdd6f4' }}>Expressions</strong> — Wrap elements in conditional/loop logic without writing raw JSX.</li>
      </ul>

      <div style={s.divider} />

      <h2 style={s.h2}>Architecture at a Glance</h2>
      <p style={s.p}>
        Cockpit is a monorepo with two apps:
      </p>
      <ul style={s.ul}>
        <li style={s.li}><span style={s.code}>builder-app/</span> — the Cockpit UI (port 5174) — what you're looking at right now.</li>
        <li style={s.li}><span style={s.code}>target app</span> — any React project you point Cockpit at (via the project picker).</li>
      </ul>
      <p style={s.p}>
        The builder communicates with your target project via a Source API (Express, port 3001) proxied
        through Vite. All AST-based edits happen server-side; the browser reads and writes source files
        through <span style={s.code}>/__source*</span> endpoints.
      </p>

      <div style={s.divider} />

      <h2 style={s.h2}>Key Technologies</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 8, marginBottom: 12 }}>
        {['React 18', 'TypeScript', 'Vite 5', 'Express', '@babel/parser', 'Monaco Editor'].map(t => (
          <span key={t} style={{ ...s.tag }}>{t}</span>
        ))}
      </div>
    </div>
  )
}

function InstallationContent() {
  return (
    <div>
      <h1 style={s.h1}>Installation Guide</h1>
      <p style={s.p}>
        Cockpit runs as a monorepo. You need <strong style={{ color: '#cdd6f4' }}>Node.js 18+</strong> and <strong style={{ color: '#cdd6f4' }}>npm 8+</strong>.
      </p>

      <div style={s.divider} />

      <h2 style={s.h2}>1. Clone the Repository</h2>
      <pre style={s.pre}>{`git clone https://github.com/your-org/cockpit.git
cd cockpit`}</pre>

      <h2 style={s.h2}>2. Install Dependencies</h2>
      <pre style={s.pre}>{`npm install`}</pre>
      <p style={s.p}>
        This installs dependencies for both the builder app and the example target app via npm workspaces.
      </p>

      <h2 style={s.h2}>3. Start the Dev Environment</h2>
      <pre style={s.pre}>{`# Terminal 1 — start a target app (e.g. the included login-app)
npm run dev:login

# Terminal 2 — start the builder UI + source API
npm run dev:builder`}</pre>

      <p style={s.p}>Open <span style={s.code}>http://localhost:5174</span> in your browser to use Cockpit.</p>

      <div style={s.divider} />

      <h2 style={s.h2}>4. Point Cockpit at Your Project</h2>
      <p style={s.p}>
        On first launch, the project picker will appear. You can:
      </p>
      <ul style={s.ul}>
        <li style={s.li}>Browse to an existing React project directory</li>
        <li style={s.li}>Scaffold a new project from Cockpit</li>
        <li style={s.li}>Initialise an existing project with a <span style={s.code}>.cockpit/config.json</span></li>
      </ul>

      <div style={s.divider} />

      <h2 style={s.h2}>Target App Requirements</h2>
      <ul style={s.ul}>
        <li style={s.li}>React 18 project (Vite, Next.js, CRA, etc.)</li>
        <li style={s.li}><span style={s.code}>src/pages/</span> — page components (<span style={s.code}>*Page.tsx</span>)</li>
        <li style={s.li}><span style={s.code}>src/components/</span> — shared components</li>
        <li style={s.li}><span style={s.code}>src/expressions/</span> — expression wrappers (optional)</li>
      </ul>
      <p style={s.p}>
        Source directories can be customized in <strong style={{ color: '#cdd6f4' }}>⚙ Settings → Builder</strong>.
      </p>

      <div style={s.divider} />

      <h2 style={s.h2}>Environment Notes</h2>
      <ul style={s.ul}>
        <li style={s.li}><strong style={{ color: '#cdd6f4' }}>Windows</strong>: Drive letter casing is handled automatically. Use <span style={s.code}>npm run dev:builder</span> from the repo root.</li>
        <li style={s.li}><strong style={{ color: '#cdd6f4' }}>macOS/Linux</strong>: No special steps needed.</li>
        <li style={s.li}>Ports: builder UI on <span style={s.code}>5174</span>, source API on <span style={s.code}>3001</span>, target app typically on <span style={s.code}>5173</span>.</li>
      </ul>
    </div>
  )
}

function HowToUseContent() {
  return (
    <div>
      <h1 style={s.h1}>How to Use Cockpit</h1>
      <p style={s.p}>
        Cockpit has three main sections — <strong style={{ color: '#cdd6f4' }}>Pages</strong>, <strong style={{ color: '#cdd6f4' }}>Components</strong>, and <strong style={{ color: '#cdd6f4' }}>Expressions</strong> — accessible via the top navigation tabs.
      </p>

      <div style={s.divider} />

      <h2 style={s.h2}>Inspecting Elements</h2>
      <ul style={s.ul}>
        <li style={s.li}><strong style={{ color: '#cdd6f4' }}>Click</strong> any element in the canvas to select it and open the Inspector panel.</li>
        <li style={s.li}><strong style={{ color: '#cdd6f4' }}>Alt+Click</strong> to locate the exact source line for any DOM element (source locator mode).</li>
        <li style={s.li}><strong style={{ color: '#cdd6f4' }}>Tree panel</strong> (left sidebar) — expand nodes to navigate the fiber tree.</li>
      </ul>

      <h2 style={s.h2}>Editing Props & Content</h2>
      <ul style={s.ul}>
        <li style={s.li}>The Inspector panel shows all props and JSX text of the selected component.</li>
        <li style={s.li}>Edit any field inline — changes are written back to source via AST rewriting (no regex).</li>
        <li style={s.li}>Diagnostics run automatically on save (TypeScript errors appear in the panel).</li>
      </ul>

      <h2 style={s.h2}>Pages</h2>
      <p style={s.p}>
        Pages are full-screen route components discovered from <span style={s.code}>src/pages/*Page.tsx</span>.
      </p>
      <ul style={s.ul}>
        <li style={s.li}>Click a page in the left panel to preview it in the canvas.</li>
        <li style={s.li}>Use the <strong style={{ color: '#cdd6f4' }}>+ Add page</strong> button to scaffold a new page file.</li>
        <li style={s.li}>Right-click a page to delete it.</li>
        <li style={s.li}>Use the <strong style={{ color: '#cdd6f4' }}>State</strong> dropdown in the breadcrumb to switch between saved prop states.</li>
      </ul>

      <h2 style={s.h2}>Components</h2>
      <p style={s.p}>
        Components are reusable UI building blocks from <span style={s.code}>src/components/*.tsx</span>.
      </p>
      <ul style={s.ul}>
        <li style={s.li}>Preview individual components in isolation.</li>
        <li style={s.li}>Inspect their props and internal structure independently from a page.</li>
      </ul>

      <h2 style={s.h2}>Expressions</h2>
      <p style={s.p}>
        Expressions are wrapper components that add conditional or looping logic around JSX.
        They live in <span style={s.code}>src/expressions/</span> and accept <span style={s.code}>children: ReactNode</span>.
      </p>
      <ul style={s.ul}>
        <li style={s.li}><span style={s.code}>IfExpression</span> — conditionally renders children based on a boolean prop.</li>
        <li style={s.li}><span style={s.code}>LoopExpression</span> — repeats children N times.</li>
        <li style={s.li}><span style={s.code}>IfElseExpression</span> / <span style={s.code}>ElseExpression</span> — branching pairs.</li>
        <li style={s.li}>Select nodes in the tree and click <strong style={{ color: '#cdd6f4' }}>Wrap</strong> to apply an expression.</li>
      </ul>

      <div style={s.divider} />

      <h2 style={s.h2}>Scope Panel</h2>
      <p style={s.p}>
        When a node is selected, the <strong style={{ color: '#cdd6f4' }}>Scope</strong> tab in the Inspector shows the parent component
        hierarchy with color-coded binding links — so you can trace exactly which prop or variable
        flows down to the selected element.
      </p>

      <h2 style={s.h2}>Settings Panel</h2>
      <p style={s.p}>
        Click <strong style={{ color: '#cdd6f4' }}>⚙</strong> in the top bar to open Settings. Tabs:
      </p>
      <ul style={s.ul}>
        <li style={s.li}><strong style={{ color: '#cdd6f4' }}>TypeScript</strong> — Path alias configuration, auto-detected from tsconfig.</li>
        <li style={s.li}><strong style={{ color: '#cdd6f4' }}>Packages</strong> — Project dependencies and install new packages.</li>
        <li style={s.li}><strong style={{ color: '#cdd6f4' }}>CSS</strong> — Stylesheet imports, font links, public asset dirs.</li>
        <li style={s.li}><strong style={{ color: '#cdd6f4' }}>Builder</strong> — Override source directory paths for pages/components/expressions.</li>
      </ul>

      <div style={s.divider} />

      <h2 style={s.h2}>Keyboard Shortcuts</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', fontFamily: 'system-ui, sans-serif' }}>
        {[
          ['Alt+Click', 'Locate element source line'],
          ['Click canvas element', 'Select & inspect node'],
          ['Escape', 'Close inspector / modal'],
        ].map(([key, desc]) => (
          <>
            <span key={key + '-key'} style={{ ...s.code, whiteSpace: 'nowrap' as const }}>{key}</span>
            <span key={key + '-desc'} style={{ fontSize: 13, color: '#a6adc8', lineHeight: 1.7 }}>{desc}</span>
          </>
        ))}
      </div>
    </div>
  )
}

function ApiReferenceContent() {
  const endpoints: { method: string; path: string; desc: string }[] = [
    { method: 'GET', path: '/__source?file=<abs-path>', desc: 'Read file contents as plain text.' },
    { method: 'POST', path: '/__source', desc: 'Write { file, content } to disk.' },
    { method: 'GET', path: '/__source/diff?file=<abs>', desc: 'Get stored original↔modified diff.' },
    { method: 'POST', path: '/__diagnostics', desc: 'Run TypeScript diagnostics on { file, content? }.' },
    { method: 'GET', path: '/__source/ast-info?file=<path>', desc: 'AST component/expression metadata.' },
    { method: 'GET', path: '/__source/browse?path=<dir>', desc: 'Browse directory tree (dirs only).' },
    { method: 'GET', path: '/__source/project-info?root=<dir>', desc: 'Probe a directory: validity, pages/components/expressions dirs.' },
    { method: 'POST', path: '/__source/set-active-project', desc: 'Set active project root { root }, warm TS cache.' },
    { method: 'GET', path: '/__source/list-pages', desc: 'List pages in the configured pagesDir.' },
    { method: 'POST', path: '/__source/create-page', desc: 'Create a new page { name }.' },
    { method: 'DELETE', path: '/__source/page/:name', desc: 'Delete a page by name.' },
    { method: 'GET', path: '/__source/list-components', desc: 'List components in componentsDir.' },
    { method: 'POST', path: '/__source/create-component', desc: 'Create a new component { name }.' },
    { method: 'DELETE', path: '/__source/component/:name', desc: 'Delete a component by name.' },
    { method: 'GET', path: '/__source/list-expressions', desc: 'List expression components.' },
    { method: 'POST', path: '/__source/create-expression', desc: 'Create an expression { name, props? }.' },
    { method: 'DELETE', path: '/__source/expression/:name', desc: 'Delete an expression.' },
    { method: 'GET', path: '/__source/settings?root=<dir>', desc: 'Read .cockpit/config.json.' },
    { method: 'POST', path: '/__source/settings', desc: 'Write .cockpit/config.json.' },
    { method: 'GET', path: '/__source/project-deps?root=<dir>', desc: 'All dependency names from package.json.' },
    { method: 'GET', path: '/__source/project-deps-full?root=<dir>', desc: 'Full { dependencies, devDependencies } with versions.' },
    { method: 'POST', path: '/__source/install-project-package', desc: 'Install package into project via npm { packageName, root, dev? } — SSE stream.' },
    { method: 'POST', path: '/__source/create-project', desc: 'Scaffold new project { name, location }.' },
    { method: 'POST', path: '/__source/init-project', desc: 'Init .cockpit/config.json in existing dir { root }.' },
    { method: 'GET', path: '/__source/tsconfig-paths?root=<dir>', desc: 'Extract path aliases from tsconfig.json.' },
    { method: 'GET', path: '/__source/check-imports?file=<abs>', desc: 'Check for unresolved imports in a file.' },
    { method: 'POST', path: '/__source/install-package', desc: 'Install into builder\'s own node_modules { packageName } — SSE stream.' },
  ]

  const methodColor: Record<string, string> = {
    GET: '#a6e3a1',
    POST: '#89b4fa',
    DELETE: '#f38ba8',
  }

  return (
    <div>
      <h1 style={s.h1}>API Reference</h1>
      <p style={s.p}>
        All endpoints are served by the Express source server on port <span style={s.code}>3001</span> and proxied
        through Vite at <span style={s.code}>/__source*</span>. File paths must be absolute and within the monorepo root.
      </p>

      <div style={s.divider} />

      <h2 style={s.h2}>Source API</h2>

      {/* Header row */}
      <div style={{ ...s.endpointRow, borderBottom: '1px solid #313244', paddingBottom: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#6c7086', fontFamily: 'system-ui, sans-serif' }}>METHOD</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#6c7086', fontFamily: 'system-ui, sans-serif' }}>ENDPOINT</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#6c7086', fontFamily: 'system-ui, sans-serif' }}>DESCRIPTION</span>
      </div>

      {endpoints.map(ep => (
        <div key={ep.method + ep.path} style={s.endpointRow}>
          <span style={{ ...s.badge, background: `${methodColor[ep.method]}22`, color: methodColor[ep.method], border: `1px solid ${methodColor[ep.method]}44` }}>
            {ep.method}
          </span>
          <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#cdd6f4', wordBreak: 'break-all' as const }}>{ep.path}</span>
          <span style={{ fontSize: 12, color: '#a6adc8', fontFamily: 'system-ui, sans-serif', lineHeight: 1.5 }}>{ep.desc}</span>
        </div>
      ))}

      <div style={s.divider} />

      <h2 style={s.h2}>File Conventions</h2>
      <div style={{ ...s.endpointRow, borderBottom: '1px solid #313244', paddingBottom: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#6c7086', fontFamily: 'system-ui, sans-serif' }}>PATTERN</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#6c7086', fontFamily: 'system-ui, sans-serif', gridColumn: '2 / -1' }}>CONVENTION</span>
      </div>
      {[
        ['src/pages/*Page.tsx', 'Named export MyPage, interface MyPageProps — auto-discovered as a page.'],
        ['src/components/*.tsx', 'Named export Button, interface ButtonProps — auto-discovered as a component.'],
        ['src/expressions/*Expression.tsx', 'Named export, must accept children: ReactNode — auto-discovered as expression.'],
      ].map(([pat, desc]) => (
        <div key={pat} style={{ ...s.endpointRow, gridTemplateColumns: '1fr 1fr' }}>
          <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#89b4fa' }}>{pat}</span>
          <span style={{ fontSize: 12, color: '#a6adc8', fontFamily: 'system-ui, sans-serif', lineHeight: 1.5 }}>{desc}</span>
        </div>
      ))}

      <div style={s.divider} />

      <h2 style={s.h2}>Architecture Principles</h2>
      <ul style={s.ul}>
        <li style={s.li}><strong style={{ color: '#cdd6f4' }}>React fiber as source of truth</strong> — DOM elements map to source via <span style={s.code}>_debugSource</span> on React fiber nodes. <span style={s.code}>fiberSource.ts</span> extracts file/line for parent component tracking.</li>
        <li style={s.li}><strong style={{ color: '#cdd6f4' }}>AST-based editing</strong> — <span style={s.code}>@babel/parser</span> parses source files; targeted rewrites add/update props via AST (never regex).</li>
        <li style={s.li}><strong style={{ color: '#cdd6f4' }}>Line offset correction</strong> — <span style={s.code}>@vitejs/plugin-react</span> prepends fast-refresh wrapper lines. <span style={s.code}>fixSourceLineNumbers()</span> subtracts the offset.</li>
        <li style={s.li}><strong style={{ color: '#cdd6f4' }}>HMR propagation</strong> — <span style={s.code}>projectHmrNotify()</span> Vite plugin watches target files and sends custom HMR events. <span style={s.code}>ComponentLoader.tsx</span> clears its lazy-import cache on HMR.</li>
        <li style={s.li}><strong style={{ color: '#cdd6f4' }}>Path safety</strong> — all file operations validate paths stay within monorepo root via <span style={s.code}>isSafeFile()</span>.</li>
      </ul>
    </div>
  )
}

// ── Main DocsPanel ─────────────────────────────────────────────────────────────

export function DocsPanel({ onClose }: DocsPanelProps) {
  const [activeSection, setActiveSection] = useState<DocSection>('introduction')

  const content: Record<DocSection, React.ReactNode> = {
    introduction: <IntroductionContent />,
    installation: <InstallationContent />,
    'how-to-use': <HowToUseContent />,
    'api-reference': <ApiReferenceContent />,
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#1e1e2e',
        border: '1px solid #313244',
        borderRadius: 12,
        width: 920,
        maxWidth: 'calc(100vw - 48px)',
        height: 680,
        maxHeight: 'calc(100vh - 80px)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0.75rem 1.2rem',
          borderBottom: '1px solid #313244',
          background: '#181825',
          flexShrink: 0,
        }}>
          <span style={{ color: '#cdd6f4', fontWeight: 700, fontSize: 14, fontFamily: 'system-ui, sans-serif', letterSpacing: 0.3 }}>
            ✦ Cockpit Docs
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', color: '#6c7086',
              fontSize: 20, cursor: 'pointer', lineHeight: 1, padding: '0 2px',
            }}
          >
            ×
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Sidebar */}
          <nav style={{
            width: 200,
            flexShrink: 0,
            background: '#181825',
            borderRight: '1px solid #313244',
            padding: '12px 0',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}>
            {SECTIONS.map(sec => (
              <button
                key={sec.id}
                onClick={() => setActiveSection(sec.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9,
                  padding: '7px 16px',
                  background: activeSection === sec.id ? 'rgba(137,180,250,0.1)' : 'transparent',
                  border: 'none',
                  borderLeft: activeSection === sec.id ? '2px solid #89b4fa' : '2px solid transparent',
                  color: activeSection === sec.id ? '#cdd6f4' : '#6c7086',
                  fontSize: 12.5,
                  fontFamily: 'system-ui, sans-serif',
                  fontWeight: activeSection === sec.id ? 600 : 400,
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'color 0.12s, background 0.12s',
                  width: '100%',
                }}
              >
                <span style={{ fontSize: 13, width: 16, textAlign: 'center' }}>{sec.icon}</span>
                {sec.label}
              </button>
            ))}
          </nav>

          {/* Content */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: '24px 28px',
          }}>
            {content[activeSection]}
          </div>
        </div>
      </div>
    </div>
  )
}
