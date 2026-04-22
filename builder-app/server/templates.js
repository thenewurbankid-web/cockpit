/**
 * File templates and prop extraction helpers for pages, components, and expressions.
 */
import { parse as babelParse } from '@babel/parser'

// ── Page template ─────────────────────────────────────────────────────────────

export function buildPageTemplate(componentName, label) {
  return [
    `import React from 'react'`,
    ``,
    `interface ${componentName}Props {`,
    `  navigate?: (page: string) => void`,
    `}`,
    ``,
    `export function ${componentName}({ navigate }: ${componentName}Props) {`,
    `  return (`,
    `    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>`,
    `      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.5rem' }}>${label}</h1>`,
    `      <p style={{ color: '#6b7280', margin: 0 }}>New page \u2014 start editing in your editor.</p>`,
    `    </div>`,
    `  )`,
    `}`,
  ].join('\n')
}

// ── Layout template ───────────────────────────────────────────────────────────

export function buildLayoutTemplate(componentName, label) {
  return [
    `import type { ReactNode } from 'react'`,
    ``,
    `interface ${componentName}Props {`,
    `  children?: ReactNode`,
    `}`,
    ``,
    `export function ${componentName}({ children }: ${componentName}Props) {`,
    `  return (`,
    `    <div style={{ minHeight: '100vh', fontFamily: 'system-ui, sans-serif' }}>`,
    `      {/* ${label} layout — add nav, sidebars, footers here */}`,
    `      {children}`,
    `    </div>`,
    `  )`,
    `}`,
  ].join('\n')
}

// ── Controller + Next.js route templates ─────────────────────────────────────

/**
 * @param {string} controllerName
 * @param {string} componentName
 * @param {string} pageImportPath
 * @param {boolean} isDefaultExport
 * @param {Array<{name: string, type: string}>} props
 * @param {{ bindings: Array<{prop: string, contextVar: string}>, actorHookName: string, actorImportPath: string } | null} [actor]
 */
export function buildControllerTemplate(controllerName, componentName, pageImportPath, isDefaultExport, props, actor = null) {
  const importLine = isDefaultExport
    ? `import ${componentName} from '${pageImportPath}'`
    : `import { ${componentName} } from '${pageImportPath}'`

  const boundProps = new Set((actor?.bindings ?? []).map(b => b.prop))

  // Props bound to actor context → const x = state.context.y (no useState)
  // Unbound props → const [x, setX] = useState<T>(default)
  const stateLines = props.map(p => {
    if (boundProps.has(p.name)) return null
    const upper = p.name.charAt(0).toUpperCase() + p.name.slice(1)
    const t = (p.type || 'string').trim()
    let defaultVal = 'null'
    if (t === 'string') defaultVal = "''"
    else if (t === 'boolean') defaultVal = 'false'
    else if (t === 'number') defaultVal = '0'
    return `  const [${p.name}, set${upper}] = useState<${t}>(${defaultVal})`
  }).filter(l => l !== null)

  const hasUseState = stateLines.length > 0
  const hasActor = !!(actor && actor.bindings.length > 0)

  // Provider name: e.g. useLoginActor → LoginProvider (strip "use", append "Provider")
  const providerName = hasActor
    ? actor.actorHookName.replace(/^use/, '').replace(/Actor$/, '') + 'Provider'
    : null

  const jsxTag = props.length === 0
    ? `    <${componentName} />`
    : [`    <${componentName}`, ...props.map(p => `      ${p.name}={${p.name}}`), `    />`].join('\n')

  const imports = [
    `'use client'`,
    ``,
    ...(hasUseState ? [`import { useState } from 'react'`] : []),
    importLine,
    ...(hasActor ? [`import { ${actor.actorHookName}, ${providerName} } from '${actor.actorImportPath}'`] : []),
  ]

  if (!hasActor) {
    // Simple controller — no actor
    const lines = [
      ...imports,
      ``,
      `export function ${controllerName}() {`,
      ...stateLines,
      stateLines.length > 0 ? `` : null,
      `  return (`,
      jsxTag,
      `  )`,
      `}`,
    ].filter(l => l !== null)
    return lines.join('\n')
  }

  // Actor-backed controller — inner component uses hook, outer wraps with Provider
  const innerName = `${controllerName}Inner`
  const actorLines = [
    `  const [machineState] = ${actor.actorHookName}()`,
    ...actor.bindings.map(b => `  const ${b.prop} = machineState.context.${b.contextVar}`),
  ]

  const lines = [
    ...imports,
    ``,
    `function ${innerName}() {`,
    ...actorLines,
    ...(stateLines.length > 0 ? ['', ...stateLines] : []),
    ``,
    `  return (`,
    jsxTag,
    `  )`,
    `}`,
    ``,
    `export function ${controllerName}() {`,
    `  return (`,
    `    <${providerName}>`,
    `      <${innerName} />`,
    `    </${providerName}>`,
    `  )`,
    `}`,
  ]

  return lines.join('\n')
}

export function buildNextRoutePageTemplate(controllerName, controllerImport) {
  return [
    `import { ${controllerName} } from '${controllerImport}'`,
    ``,
    `export default function Page() {`,
    `  return <${controllerName} />`,
    `}`,
  ].join('\n')
}

export function buildNextRouteLayoutTemplate(layoutComponentName, layoutImport) {
  return [
    `import type { ReactNode } from 'react'`,
    `import { ${layoutComponentName} } from '${layoutImport}'`,
    ``,
    `export default function Layout({ children }: { children: ReactNode }) {`,
    `  return <${layoutComponentName}>{children}</${layoutComponentName}>`,
    `}`,
  ].join('\n')
}

// ── Component template ────────────────────────────────────────────────────────

export function buildComponentTemplate(componentName, label) {
  return [
    `import React from 'react'`,
    ``,
    `interface ${componentName}Props {}`,
    ``,
    `export function ${componentName}({}: ${componentName}Props) {`,
    `  return (`,
    `    <div style={{ padding: '1rem', fontFamily: 'system-ui, sans-serif' }}>`,
    `      <span>${label}</span>`,
    `    </div>`,
    `  )`,
    `}`,
  ].join('\n')
}

// ── Feature templates (XState v5) ─────────────────────────────────────────────

/**
 * Service file: a typed async fetch function for a feature.
 * @param {string} name - PascalCase service name, e.g. "AuthService"
 */
export function buildServiceTemplate(name) {
  const fnName = name.charAt(0).toLowerCase() + name.slice(1)
  return [
    `// ${name} — feature service`,
    ``,
    `export interface ${name}Params {`,
    `  // TODO: define request params`,
    `}`,
    ``,
    `export interface ${name}Result {`,
    `  // TODO: define response shape`,
    `}`,
    ``,
    `export async function ${fnName}(params: ${name}Params): Promise<${name}Result> {`,
    `  const res = await fetch('/api/TODO', {`,
    `    method: 'POST',`,
    `    headers: { 'Content-Type': 'application/json' },`,
    `    body: JSON.stringify(params),`,
    `  })`,
    `  if (!res.ok) throw new Error(await res.text())`,
    `  return res.json()`,
    `}`,
  ].join('\n')
}

/**
 * XState v5 machine file.
 * @param {string} name - PascalCase flow name, e.g. "AuthFlow"
 */
export function buildMachineTemplate(name) {
  const camel = name.charAt(0).toLowerCase() + name.slice(1)
  return [
    `import { createMachine } from 'xstate'`,
    ``,
    `export interface ${name}Context {`,
    `  // TODO: define context shape`,
    `}`,
    ``,
    `export type ${name}Event =`,
    `  | { type: 'START' }`,
    `  | { type: 'RESET' }`,
    ``,
    `export const ${camel}Machine = createMachine({`,
    `  id: '${camel}',`,
    `  initial: 'idle',`,
    `  context: {} as ${name}Context,`,
    `  states: {`,
    `    idle: {`,
    `      on: { START: 'active' },`,
    `    },`,
    `    active: {`,
    `      on: { RESET: 'idle' },`,
    `    },`,
    `  },`,
    `})`,
  ].join('\n')
}

/**
 * XState v5 actor context file — generates useFeatureActor() hook (production, no Cockpit bridges).
 * @param {string} name - PascalCase flow name, e.g. "AuthFlow"
 */
export function buildActorTemplate(name) {
  const camel = name.charAt(0).toLowerCase() + name.slice(1)
  return [
    `import { createActorContext } from '@xstate/react'`,
    `import { ${camel}Machine } from './${name}.machine'`,
    ``,
    `const ${name}ActorContext = createActorContext(${camel}Machine)`,
    ``,
    `export const ${name}Provider = ${name}ActorContext.Provider`,
    ``,
    `/** Production hook: returns [state, send] for the ${name} machine. */`,
    `export function use${name}Actor() {`,
    `  const actor = ${name}ActorContext.useActorRef()`,
    `  const state = ${name}ActorContext.useSelector(s => s)`,
    `  return [state, actor.send] as const`,
    `}`,
  ].join('\n')
}

/**
 * XState v5 Cockpit actor context file — same hook interface as the production actor,
 * but adds the Cockpit simulation bridge (state broadcast + event/invoke intercept).
 * Lives in the target app alongside the production actor; used during preview simulation.
 * @param {string} name - PascalCase flow name, e.g. "AuthFlow"
 */
export function buildCockpitActorTemplate(name) {
  const camel = name.charAt(0).toLowerCase() + name.slice(1)
  return [
    `import { createActorContext } from '@xstate/react'`,
    `import { useEffect } from 'react'`,
    `import { fromPromise } from 'xstate'`,
    `import { ${camel}Machine } from './${name}.machine'`,
    ``,
    `/**`,
    ` * When running inside Cockpit's preview iframe, pause invokes and let the`,
    ` * simulation panel decide success/failure via cockpit:invoke-result.`,
    ` */`,
    `function cockpitInvoke<T>(actor: string, input: Record<string, unknown>): Promise<T> {`,
    `  window.parent.postMessage({ type: 'cockpit:invoke-pending', actor, input }, '*')`,
    `  return new Promise<T>((resolve, reject) => {`,
    `    function handle(e: MessageEvent) {`,
    `      if (e.data?.type !== 'cockpit:invoke-result' || e.data?.actor !== actor) return`,
    `      window.removeEventListener('message', handle)`,
    `      if (e.data.success) resolve(e.data.value as T)`,
    `      else reject(new Error(e.data.error ?? 'Simulated error'))`,
    `    }`,
    `    window.addEventListener('message', handle)`,
    `  })`,
    `}`,
    ``,
    `const ${name}CockpitMachine = ${camel}Machine.provide({`,
    `  actors: {`,
    `    // TODO: list each invoked actor name and proxy it through cockpitInvoke`,
    `    // e.g. loginApi: fromPromise(({ input }) => cockpitInvoke('loginApi', input as Record<string, unknown>)),`,
    `  },`,
    `})`,
    ``,
    `const ${name}ActorContext = createActorContext(${name}CockpitMachine)`,
    ``,
    `export const ${name}Provider = ${name}ActorContext.Provider`,
    ``,
    `/**`,
    ` * Cockpit simulation hook — same interface as use${name}Actor() in ${name}.actor.ts.`,
    ` * Broadcasts machine state to the builder panel and accepts events from it.`,
    ` */`,
    `export function use${name}Actor() {`,
    `  const actor = ${name}ActorContext.useActorRef()`,
    `  const state = ${name}ActorContext.useSelector(s => s)`,
    ``,
    `  // Broadcast current state to the Cockpit builder panel`,
    `  useEffect(() => {`,
    `    window.parent?.postMessage({`,
    `      type: 'cockpit:machine-state',`,
    `      value: typeof state.value === 'string' ? state.value : JSON.stringify(state.value),`,
    `      context: state.context,`,
    `    }, '*')`,
    `  }, [state])`,
    ``,
    `  // Receive events sent from the simulation panel`,
    `  useEffect(() => {`,
    `    function handleMessage(e: MessageEvent) {`,
    `      if (e.data?.type === 'cockpit:machine-event') actor.send(e.data.event)`,
    `    }`,
    `    window.addEventListener('message', handleMessage)`,
    `    return () => window.removeEventListener('message', handleMessage)`,
    `  }, [actor])`,
    ``,
    `  return [state, actor.send] as const`,
    `}`,
  ].join('\n')
}

/**
 * XState v5 controller file — creates and exposes an actor with injected implementations.
 * @param {string} name - PascalCase flow name, e.g. "AuthFlow"
 */
export function buildFeatureControllerTemplate(name) {
  const camel = name.charAt(0).toLowerCase() + name.slice(1)
  return [
    `import { createActor } from 'xstate'`,
    `import { ${camel}Machine } from './${name}.machine'`,
    ``,
    `// ── Types ──────────────────────────────────────────────────────────────────────`,
    ``,
    `export interface ${name}State {`,
    `  value: string`,
    `  context: Record<string, unknown>`,
    `}`,
    ``,
    `export type StateListener = (state: ${name}State) => void`,
    ``,
    `// ── Controller factory ─────────────────────────────────────────────────────────`,
    ``,
    `export function create${name}Controller() {`,
    `  const actor = createActor(${camel}Machine.provide({`,
    `    actors: {`,
    `      // TODO: map invoke sources → real API calls`,
    `      // e.g. loginApi: () => fetch('/api/auth/login', { method: 'POST' }).then(r => r.json()),`,
    `    },`,
    `    actions: {`,
    `      // TODO: map action names → side effects`,
    `      // e.g. navigateHome: () => { window.location.href = '/' },`,
    `    },`,
    `  }))`,
    ``,
    `  const listeners = new Set<StateListener>()`,
    ``,
    `  actor.subscribe(snapshot => {`,
    `    const s: ${name}State = { value: String(snapshot.value), context: snapshot.context as Record<string, unknown> }`,
    `    listeners.forEach(l => l(s))`,
    `  })`,
    ``,
    `  return {`,
    `    start() { actor.start() },`,
    `    stop() { actor.stop() },`,
    `    subscribe(listener: StateListener) {`,
    `      listeners.add(listener)`,
    `      return () => listeners.delete(listener)`,
    `    },`,
    `    getState(): ${name}State {`,
    `      const s = actor.getSnapshot()`,
    `      return { value: String(s.value), context: s.context as Record<string, unknown> }`,
    `    },`,
    `    send(event: Record<string, unknown>) { actor.send(event as never) },`,
    `    /** Dev mode — remove in production. */`,
    `    __actor: actor,`,
    `  }`,
    `}`,
  ].join('\n')
}

// ── Expression template ───────────────────────────────────────────────────────

export function buildExpressionTemplate(componentName, props) {
  // Build interface props lines (children always included at end)
  const ifaceProps = [...props.map((p) => `  ${p}: unknown`), `  children: ReactNode`]
  // Build destructure params
  const destructure = [...props, 'children'].join(', ')
  // Build a trivial body — return children, ignore extra props for now
  const body = props.length > 0
    ? `  // TODO: use ${props.join(', ')}\n  return <>{children}</>`
    : `  return <>{children}</>`

  return [
    `import type { ReactNode } from 'react'`,
    ``,
    `interface ${componentName}Props {`,
    ...ifaceProps,
    `}`,
    ``,
    `export function ${componentName}({ ${destructure} }: ${componentName}Props) {`,
    body,
    `}`,
  ].join('\n')
}

// ── Default expressions ───────────────────────────────────────────────────────

export const DEFAULT_EXPRESSIONS = {
  IfExpression: `import type { ReactNode } from 'react'

interface IfExpressionProps {
  condition: boolean
  children: ReactNode
}

export function IfExpression({ condition, children }: IfExpressionProps) {
  return condition ? <>{children}</> : null
}
`,
  ElseExpression: `import type { ReactNode } from 'react'

interface ElseExpressionProps {
  condition: boolean
  children: ReactNode
}

export function ElseExpression({ condition, children }: ElseExpressionProps) {
  return !condition ? <>{children}</> : null
}
`,
  IfElseExpression: `import type { ReactNode } from 'react'

interface IfElseExpressionProps {
  condition: boolean
  then: ReactNode
  else: ReactNode
}

export function IfElseExpression({ condition, then: thenNode, else: elseNode }: IfElseExpressionProps) {
  return condition ? <>{thenNode}</> : <>{elseNode}</>
}
`,
  LoopExpression: `import type { ReactNode } from 'react'

interface LoopExpressionProps {
  items: unknown[]
  children: (item: unknown, index: number) => ReactNode
}

export function LoopExpression({ items, children }: LoopExpressionProps) {
  return <>{items.map((item, i) => children(item, i))}</>
}
`,
  SwitchExpression: `import type { ReactNode } from 'react'

interface SwitchExpressionProps {
  value: string | number
  cases: Record<string, ReactNode>
  default?: ReactNode
}

export function SwitchExpression({ value, cases, default: defaultCase }: SwitchExpressionProps) {
  return <>{cases[String(value)] ?? defaultCase ?? null}</>
}
`,
}

// ── Expression prop extraction ────────────────────────────────────────────────

/**
 * Read prop names from a TSInterfaceDeclaration or TSTypeAliasDeclaration named
 * `{componentName}Props`. This is more reliable than reading from the destructuring
 * parameter because Babel's error-recovery can misparse reserved words (like `else`,
 * `then`) in parameter destructuring position, while property names in interface
 * bodies are always parsed as IdentifierName tokens without ambiguity.
 */
function propsFromInterface(ast, componentName) {
  const ifaceName = `${componentName}Props`
  for (const node of ast.program.body) {
    // interface FooProps { a: T; b: T }
    if (
      (node.type === 'TSInterfaceDeclaration') &&
      node.id?.name === ifaceName
    ) {
      return (node.body?.body ?? [])
        .filter((m) => m.type === 'TSPropertySignature')
        .map((m) => m.key?.name ?? null)
        .filter((name) => name !== null)
    }
    // type FooProps = { a: T; b: T }
    if (
      node.type === 'TSTypeAliasDeclaration' &&
      node.id?.name === ifaceName &&
      node.typeAnnotation?.type === 'TSTypeLiteral'
    ) {
      return (node.typeAnnotation.members ?? [])
        .filter((m) => m.type === 'TSPropertySignature')
        .map((m) => m.key?.name ?? null)
        .filter((name) => name !== null)
    }
  }
  return null
}

function propsFromParams(params) {
  if (!params || params.length === 0) return []
  const first = params[0]
  // Strip TS type annotation wrapper
  const pattern = first.type === 'AssignmentPattern' ? first.left : first

  if (pattern.type !== 'ObjectPattern') return []
  return pattern.properties
    .filter((p) => p.type === 'ObjectProperty' || p.type === 'RestElement')
    .map((p) => {
      if (p.type === 'RestElement') return null
      const key = p.key
      // key.name works for both Identifier and keyword nodes
      return key?.name ?? null
    })
    .filter((name) => name !== null)
}

/** Extract prop names (excluding children) from the first param of the exported function. */
export function extractExpressionProps(source) {
  let ast
  try {
    ast = babelParse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true,
    })
  } catch {
    return []
  }

  for (const node of ast.program.body) {
    // export function Foo({ a, b }: FooProps) {}
    if (
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'FunctionDeclaration'
    ) {
      const compName = node.declaration.id?.name
      // Prefer reading from the interface (avoids keyword-in-destructuring parse issues)
      const fromIface = compName ? propsFromInterface(ast, compName) : null
      return fromIface ?? propsFromParams(node.declaration.params)
    }
    // export const Foo = ({ a, b }) => {}
    if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration') {
      for (const decl of node.declaration.declarations) {
        const init = decl.init
        if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') {
          const compName = decl.id?.name
          const fromIface = compName ? propsFromInterface(ast, compName) : null
          return fromIface ?? propsFromParams(init.params)
        }
      }
    }
  }
  return []
}
