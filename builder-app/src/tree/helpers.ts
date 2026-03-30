import type { DisplayNode } from './types'

export function countNodes(nodes: DisplayNode[]): number {
  function countOne(node: DisplayNode): number {
    return 1 + node.children.reduce((s, c) => s + countOne(c), 0)
  }
  return nodes.reduce((sum, n) => sum + countOne(n), 0)
}

/** Returns the key path from the root to the first node whose `el` matches `target`. */
export function findPathToEl(target: Element, nodes: DisplayNode[]): string[] | null {
  for (const node of nodes) {
    if (node.kind === 'dom' && node.el === target) return [node.key]
    const childPath = findPathToEl(target, node.children)
    if (childPath) return [node.key, ...childPath]
  }
  return null
}

export function findNodeByKey(nodes: DisplayNode[], key: string): DisplayNode | null {
  for (const node of nodes) {
    if (node.key === key) return node
    const found = findNodeByKey(node.children, key)
    if (found) return found
  }
  return null
}

// ── Helpers for source-location extraction ──────────────────────────────────

export function getNodeFile(node: DisplayNode): string | null {
  if (node.kind === 'component') return node.file || null
  if (node.kind === 'loop') return node.sourceFile
  if (node.kind === 'ghost') return node.file
  return node.sourceInfo?.file ?? null
}

export function getNodeLine(node: DisplayNode): number | null {
  if (node.kind === 'component') return node.line
  if (node.kind === 'loop') return node.sourceLine || null
  if (node.kind === 'ghost') return node.line
  return node.sourceInfo?.line ?? null
}

export function computeRelativeImportPath(fromFile: string, toFile: string): string {
  const from = fromFile.replace(/\\/g, '/').split('/')
  const to = toFile.replace(/\\/g, '/').split('/')
  const toBase = to[to.length - 1].replace(/\.tsx?$/, '')
  const fromDir = from.slice(0, -1)
  const toDir = to.slice(0, -1)
  let common = 0
  const n = Math.min(fromDir.length, toDir.length)
  for (let i = 0; i < n; i++) {
    if (fromDir[i].toLowerCase() === toDir[i].toLowerCase()) common++
    else break
  }
  const ups = fromDir.length - common
  const downs = toDir.slice(common)
  const rel = [...Array(ups).fill('..'), ...downs, toBase].join('/')
  return rel.startsWith('.') ? rel : './' + rel
}
