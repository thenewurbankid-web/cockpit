import { parse } from '@babel/parser'
import { getElementSourceInfo, collectExpressionInstances, fiberTreeContainsComponent, findTopmostProjectComponentName, type ElementSourceInfo, type ExpressionInstance } from '../fiberSource'
import type { RawDomNode, DisplayNode, DisplayDomNode, DisplayGhostNode } from './types'

function isLikelyReactComponentName(name: string | null | undefined): boolean {
  if (!name) return false
  return /^[A-Z]/.test(name)
}

export function hasMultipleComponents(source: string): boolean {
  try {
    const body = (parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] }).program as any).body as any[]
    const names = new Set<string>()
    for (const node of body) {
      if (node.type === 'FunctionDeclaration' && /^[A-Z]/.test(node.id?.name ?? '')) names.add(node.id.name)
      if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') {
        const d = node.declaration
        if (d?.type === 'FunctionDeclaration' && /^[A-Z]/.test(d.id?.name ?? '')) names.add(d.id.name)
        if (d?.type === 'VariableDeclaration') {
          for (const vd of d.declarations ?? []) {
            if (/^[A-Z]/.test(vd.id?.name ?? '') &&
                (vd.init?.type === 'ArrowFunctionExpression' || vd.init?.type === 'FunctionExpression')) {
              names.add(vd.id.name)
            }
          }
        }
      }
      if (node.type === 'VariableDeclaration') {
        for (const vd of node.declarations ?? []) {
          if (/^[A-Z]/.test(vd.id?.name ?? '') &&
              (vd.init?.type === 'ArrowFunctionExpression' || vd.init?.type === 'FunctionExpression')) {
            names.add(vd.id.name)
          }
        }
      }
      if (names.size > 1) return true
    }
    return names.size > 1
  } catch {
    return false
  }
}

export function collectComponentFiles(nodes: DisplayNode[], out: Set<string>): void {
  for (const node of nodes) {
    if (node.kind === 'component' && node.file) out.add(node.file)
    if (node.kind === 'loop' && node.sourceFile) out.add(node.sourceFile)
    collectComponentFiles(node.children, out)
  }
}

export function buildRawDomTree(root: Element): RawDomNode {
  const sourceInfo = getElementSourceInfo(root)
  const children: RawDomNode[] = []
  for (const child of Array.from(root.children)) {
    children.push(buildRawDomTree(child))
  }
  return {
    kind: 'dom',
    el: root,
    tag: root.tagName.toLowerCase(),
    sourceInfo,
    children,
  }
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

function collectSourceInfos(node: RawDomNode, out: ElementSourceInfo[]): void {
  if (node.sourceInfo) out.push(node.sourceInfo)
  for (const child of node.children) collectSourceInfos(child, out)
}

export function inferPageRoot(
  rawRoots: RawDomNode[],
  preferredRootComponentName?: string,
  projectDirs?: string[]
): { name: string; file: string; line: number } | null {
  const allRaw: ElementSourceInfo[] = []
  for (const root of rawRoots) collectSourceInfos(root, allRaw)

  // Build a predicate that matches files inside any of the configured project
  // source dirs (e.g. 'src/subframe-pages') or falls back to the generic
  // '/pages/' / '/components/' heuristic for login-app style projects.
  function isProjectFile(filePath: string): boolean {
    const f = normalizeSlashes(filePath)
    if (projectDirs && projectDirs.length > 0) {
      return projectDirs.some(dir => f.startsWith(normalizeSlashes(dir)))
    }
    return f.includes('/pages/') || f.includes('/components/')
  }

  function isBuilderFile(filePath: string): boolean {
    return normalizeSlashes(filePath).includes('builder-app/src/')
  }

  // Never let builder-app source files appear as the page root.
  const all = allRaw.filter(info => !isBuilderFile(info.file) && !isBuilderFile(info.ownerFile ?? ''))

  if (preferredRootComponentName && isLikelyReactComponentName(preferredRootComponentName)) {
    for (const info of all) {
      if (
        info.ownerComponentName === preferredRootComponentName &&
        isProjectFile(info.file)
      ) {
        return {
          name: preferredRootComponentName,
          file: info.file,
          line: info.ownerLine ?? info.line,
        }
      }
    }

    // Subframe pages render Subframe components (in src/ui/) rather than DOM
    // elements directly. Their leaf elements' `file` is in src/ui/ (not in
    // pagesDir/componentsDir), but their `ownerFile` points back to the page
    // file (where <BadgeRoot/> etc. appear in JSX). Check ownerFile first.
    const srcInfo =
      all.find((info) => isProjectFile(info.ownerFile ?? '')) ??
      all.find((info) => isProjectFile(info.file))
    if (srcInfo) {
      const useOwner = srcInfo.ownerFile && isProjectFile(srcInfo.ownerFile)
      return {
        name: preferredRootComponentName,
        file: useOwner ? srcInfo.ownerFile! : srcInfo.file,
        line: useOwner ? (srcInfo.ownerLine ?? srcInfo.line) : srcInfo.line,
      }
    }

    const first = all[0]
    if (first) {
      const useOwner = first.ownerFile && isProjectFile(first.ownerFile)
      return {
        name: preferredRootComponentName,
        file: useOwner ? first.ownerFile! : first.file,
        line: useOwner ? (first.ownerLine ?? first.line) : first.line,
      }
    }

    return {
      name: preferredRootComponentName,
      file: '',
      line: 1,
    }
  }

  for (const info of all) {
    if (
      isLikelyReactComponentName(info.ownerComponentName) &&
      isProjectFile(info.file)
    ) {
      return {
        name: info.ownerComponentName as string,
        file: info.file,
        line: info.ownerLine ?? info.line,
      }
    }
  }

  for (const info of all) {
    if (isLikelyReactComponentName(info.ownerComponentName)) {
      return {
        name: info.ownerComponentName as string,
        file: info.file,
        line: info.ownerLine ?? info.line,
      }
    }
  }

  return null
}

function toMixedTree(
  node: RawDomNode,
  depth: number,
  parentOwnerName: string | null,
  keyPrefix: string
): DisplayNode | null {
  // Exclude DOM elements whose own JSX definition lives in builder-app source.
  // NOTE: we intentionally do NOT check ownerFile here. In the iframe preview
  // the page component (e.g. AlSignIn) is instantiated from ComponentLoader.tsx
  // (builder-app), so its direct DOM children have ownerFile=ComponentLoader.tsx.
  // Checking ownerFile would wrongly filter out all of the page's DOM output.
  // Builder-app DOM elements are already excluded by addRawRoots() which skips
  // builder-app wrapper elements before they ever reach toMixedTree.
  const elementFile = normalizeSlashes(node.sourceInfo?.file ?? '')
  if (elementFile.includes('builder-app/src/')) return null

  const ownerName = isLikelyReactComponentName(node.sourceInfo?.ownerComponentName)
    ? node.sourceInfo?.ownerComponentName ?? null
    : null

  const effectiveOwnerName = ownerName
  const currentOwnerName = effectiveOwnerName ?? parentOwnerName

  const domNode: DisplayDomNode = {
    kind: 'dom',
    key: `${keyPrefix}-dom`,
    el: node.el,
    tag: node.tag,
    sourceInfo: node.sourceInfo,
    depth,
    children: node.children
      .map((child, i) => toMixedTree(child, depth + 1, currentOwnerName, `${keyPrefix}-${i}`))
      .filter((n): n is DisplayNode => n !== null),
  }

  if (effectiveOwnerName && effectiveOwnerName !== parentOwnerName) {
    return {
      kind: 'component',
      key: `${keyPrefix}-comp-${effectiveOwnerName}`,
      name: effectiveOwnerName,
      file: node.sourceInfo?.file ?? '',
      line: node.sourceInfo?.line ?? 1,
      usageFile: node.sourceInfo?.ownerFile ?? null,
      usageLine: node.sourceInfo?.ownerLine ?? null,
      depth,
      children: [domNode],
    }
  }

  return domNode
}

export function buildMixedTree(root: Element, preferredRootComponentName?: string, projectDirs?: string[]): DisplayNode[] | null {
  const rawRoots: RawDomNode[] = []

  // Collect raw DOM roots from canvas children, but transparently unwrap any
  // builder-app wrapper elements (e.g. the <div> rendered by PreviewCanvas in
  // ComponentLoader.tsx). We detect these by their own JSX definition file
  // (fiber._debugSource.fileName). We do NOT check ownerFile here because
  // the page component (e.g. AlSignIn) is instantiated from ComponentLoader.tsx,
  // making ownerFile=ComponentLoader.tsx for every element AlSignIn renders —
  // checking ownerFile would wrongly strip the entire page structure.
  function addRawRoots(el: Element) {
    const info = getElementSourceInfo(el)
    const file = normalizeSlashes(info?.file ?? '')
    if (file.includes('builder-app/src/')) {
      // Transparent builder wrapper (e.g. PreviewCanvas div) — recurse into children
      for (const child of Array.from(el.children)) addRawRoots(child)
    } else {
      rawRoots.push(buildRawDomTree(el))
    }
  }
  for (let i = 0; i < root.children.length; i++) {
    addRawRoots(root.children[i])
  }

  // If a specific page/component is expected, verify the canvas actually contains
  // that component anywhere in its React fiber tree before building the tree.
  // Using ownerComponentName on leaf elements is not reliable: pages that only
  // render Subframe sub-components (no direct DOM output) will never show the
  // page root as ownerComponentName since it is never the nearest parent of
  // any DOM element.  Instead we walk the fiber.return chain from the canvas's
  // first child upward — if the page component is mounted it will appear there.
  //
  // If the preferred name is NOT found, check whether the canvas has any React
  // content from outside builder-app. It might be present because the exported
  // function name differs from the file name (e.g. SignInPage.tsx exports
  // `AlSignIn`). In that case we still build the tree — canvasEl is nulled out
  // on every page change so stale content from a previous page can't bleed
  // through. We just drop the preferred-name hint so inferPageRoot auto-detects
  // the actual root component name from the fiber data.
  if (preferredRootComponentName) {
    // Use the first unwrapped project element for fiber chain walking.
    // root.firstElementChild may be a builder-app wrapper (PreviewCanvas div).
    const firstProjectEl = rawRoots[0]?.el ?? root.firstElementChild
    const found = firstProjectEl
      ? fiberTreeContainsComponent(firstProjectEl, preferredRootComponentName)
      : false
    if (!found) {
      // Check if the canvas has any non-builder React source infos — i.e. the
      // page has actually rendered but its export name ≠ its file name.
      const allInfos: ElementSourceInfo[] = []
      for (const raw of rawRoots) collectSourceInfos(raw, allInfos)
      const hasProjectContent = allInfos.some(
        info => !normalizeSlashes(info.file).includes('builder-app/src/')
      )
      // No project content → canvas still loading / Suspense fallback only.
      if (!hasProjectContent) return null
      // Project content is present but the exported function name differs from
      // the file name (e.g. SignInPage.tsx exports AlSignIn). Walk the fiber
      // chain to find the real topmost project component and use that name.
      const actualName = firstProjectEl ? findTopmostProjectComponentName(firstProjectEl) : null
      preferredRootComponentName = actualName ?? undefined
    }
  }

  const pageRoot = inferPageRoot(rawRoots, preferredRootComponentName, projectDirs)

  const out: DisplayNode[] = rawRoots
    .map((raw, i) => toMixedTree(raw, pageRoot ? 1 : 0, pageRoot?.name ?? null, `root-${i}`))
    .filter((n): n is DisplayNode => n !== null)

  if (pageRoot) {
    return [
      {
        kind: 'component',
        key: `page-root-${pageRoot.name}`,
        name: pageRoot.name,
        file: pageRoot.file,
        line: pageRoot.line,
        depth: 0,
        children: out,
      },
    ]
  }

  return out
}

export function firstDomElement(node: DisplayNode): Element | null {
  if (node.kind === 'dom') return node.el
  for (const child of node.children) {
    const el = firstDomElement(child)
    if (el) return el
  }
  return null
}

/** Recursively increment depth of a node and all its descendants (used when wrapping in a loop node). */
function bumpDepth(node: DisplayNode): DisplayNode {
  return { ...node, depth: node.depth + 1, children: node.children.map(bumpDepth) } as DisplayNode
}

/** Returns a stable key for grouping siblings that originate from the same source line. */
function nodeSourceKey(node: DisplayNode): string | null {
  if (node.kind === 'component' && node.usageFile && node.usageLine != null) {
    return `${node.usageFile}:${node.usageLine}`
  }
  if (node.kind === 'ghost' && node.file && node.line != null) {
    return `${node.file}:${node.line}`
  }
  if (node.kind === 'dom' && node.sourceInfo) {
    return `${node.sourceInfo.file}:${node.sourceInfo.line}`
  }
  return null
}

/**
 * Group consecutive siblings that share the same source location (file:line)
 * under a synthetic DisplayLoopNode. Only groups runs of 2+.
 */
function groupSiblingLoops(
  children: DisplayNode[],
  _fileSources: Map<string, string>,
): DisplayNode[] {
  if (children.length < 2) return children
  const result: DisplayNode[] = []
  let i = 0
  while (i < children.length) {
    const key = nodeSourceKey(children[i])
    if (!key) { result.push(children[i]); i++; continue }
    let j = i + 1
    while (j < children.length && nodeSourceKey(children[j]) === key) j++
    if (j - i < 2) { result.push(children[i]); i++; continue }
    const sepIdx = key.lastIndexOf(':')
    const file = key.slice(0, sepIdx)
    const line = parseInt(key.slice(sepIdx + 1), 10)
    const groupDepth = children[i].depth
    result.push({
      kind: 'loop',
      key: `loop-${i}-${file.slice(-20)}-${line}`,
      depth: groupDepth,
      sourceLine: line,
      sourceFile: file || null,
      count: j - i,
      children: children.slice(i, j).map(bumpDepth),
    })
    i = j
  }
  return result
}

function propsToStrings(props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(props)) {
    if (k === 'children') continue
    if (v == null) out[k] = String(v)
    else if (typeof v === 'boolean' || typeof v === 'number') out[k] = String(v)
    else if (typeof v === 'string') out[k] = `"${v}"`
    else if (typeof v === 'function') out[k] = 'fn()'
    else if (typeof v === 'object' && '$$typeof' in (v as object)) {
      const t = (v as any).type
      out[k] = `<${typeof t === 'string' ? t : (t?.name ?? '?')}>`
    }
    else out[k] = '{\u2026}'
  }
  return out
}

function buildGhostChildren(children: unknown, depth: number): DisplayNode[] {
  if (!children) return []
  const arr: unknown[] = Array.isArray(children) ? children : [children]
  const result: DisplayNode[] = []
  arr.forEach((child, i) => {
    if (!child || typeof child !== 'object') return
    const el = child as any
    if (!el.type) return
    const tag = typeof el.type === 'string' ? el.type : (el.type.displayName || el.type.name || '?')
    result.push({
      kind: 'ghost',
      key: `ghost-child-${tag}-${i}-${depth}`,
      name: tag,
      exprProps: {},
      file: null,
      line: null,
      depth,
      children: buildGhostChildren(el.props?.children, depth + 1),
    })
  })
  return result
}

export function mergeExpressionData(
  nodes: DisplayNode[],
  instances: ExpressionInstance[],
  fileSources: Map<string, string>,
): DisplayNode[] {
  const activeCounters: Record<string, number> = {}
  const activeByName: Record<string, ExpressionInstance[]> = {}
  const inactiveByParent = new Map<Element, ExpressionInstance[]>()
  for (const inst of instances) {
    if (inst.active) {
      ;(activeByName[inst.name] ??= []).push(inst)
    } else if (inst.parentDomEl) {
      let arr = inactiveByParent.get(inst.parentDomEl)
      if (!arr) { arr = []; inactiveByParent.set(inst.parentDomEl, arr) }
      arr.push(inst)
    }
  }

  function process(nodes: DisplayNode[]): DisplayNode[] {
    const mapped = nodes.map(node => {
      if (node.kind === 'component') {
        const idx = activeCounters[node.name] ?? 0
        activeCounters[node.name] = idx + 1
        const inst = activeByName[node.name]?.[idx]
        return {
          ...node,
          exprProps: inst ? propsToStrings(inst.props) : {},
          usageFile: inst?.source?.fileName ?? null,
          usageLine: inst?.source?.lineNumber ?? null,
          children: groupSiblingLoops(process(node.children), fileSources),
        }
      }
      if (node.kind === 'dom') {
        const inactiveHere = inactiveByParent.get(node.el)
        if (!inactiveHere || inactiveHere.length === 0) {
          return { ...node, children: groupSiblingLoops(process(node.children), fileSources) }
        }

        const ghosts: Array<{ ghost: DisplayGhostNode; nextEl: Element | null }> =
          inactiveHere.map((inst, i) => ({
            ghost: {
              kind: 'ghost',
              key: `ghost-${inst.name}-${inst.source?.lineNumber ?? i}-${node.key}`,
              name: inst.name,
              exprProps: propsToStrings(inst.props),
              file: inst.source?.fileName ?? null,
              line: inst.source?.lineNumber ?? null,
              depth: node.depth + 1,
              children: buildGhostChildren(inst.props.children, node.depth + 2),
            } satisfies DisplayGhostNode,
            nextEl: inst.nextDomSiblingEl,
          }))

        const processedChildren = process(node.children)
        const result: DisplayNode[] = []
        for (const child of processedChildren) {
          const childFirstEl = firstDomElement(child)
          for (const { ghost, nextEl } of ghosts) {
            if (nextEl !== null && nextEl === childFirstEl) result.push(ghost)
          }
          result.push(child)
        }
        // Append ghosts whose next sibling wasn't found (they go at the end).
        for (const { ghost, nextEl } of ghosts) {
          if (nextEl === null) result.push(ghost)
        }
        return { ...node, children: groupSiblingLoops(result, fileSources) }
      }
      return { ...node, children: groupSiblingLoops(process(node.children as DisplayNode[]), fileSources) }
    })
    return groupSiblingLoops(mapped, fileSources)
  }

  return process(nodes)
}
