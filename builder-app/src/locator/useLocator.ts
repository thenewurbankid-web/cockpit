import { useEffect } from 'react'
import type { SourceLocation } from '../App'

// Extend Window with the data object @locator/babel-jsx injects at runtime.
declare global {
  interface Window {
    __LOCATOR_DATA__?: Record<
      string,
      {
        filePath: string
        projectPath: string
        expressions: Array<{
          name: string
          loc: { start: { line: number; column: number } }
          wrappingComponentId?: number | null
        }>
        components?: Array<{
          name: string
          loc: { start: { line: number; column: number } }
        }>
      }
    >
  }
}

// useLocator - Alt+Click any element to open the inspector.
// @locator/babel-jsx (applied in vite.config.ts) injects two things into every
// JSX/TSX file at build time:
//   1. data-locatorjs-id="filePath::expressionIndex" on each JSX element
//   2. window.__LOCATOR_DATA__[filePath] = { expressions: [{name, loc}...] }
// We read both to get the exact file path + line number.
export function useLocator(onLocate: (loc: SourceLocation) => void) {
  useEffect(() => {
    if (import.meta.env.PROD) return

    function isAbsolutePath(p: string): boolean {
      return /^[A-Za-z]:[\\/]|^\//.test(p)
    }

    // locatorjs can emit keys like:
    //   D:\repo\builder-appD:\repo\login-app\src\Button.tsx
    // If two Windows drive prefixes exist, keep the second absolute path.
    function normalizePossiblyConcatenatedPath(raw: string): string {
      const driveHits = [...raw.matchAll(/[A-Za-z]:[\\/]/g)]
      if (driveHits.length >= 2 && driveHits[1].index !== undefined) {
        return raw.slice(driveHits[1].index)
      }
      return raw
    }

    function resolveLocatorId(locatorId: string): SourceLocation | null {
      const sep = locatorId.lastIndexOf('::')
      if (sep === -1) return null
      const rawKey = locatorId.slice(0, sep)
      const key = normalizePossiblyConcatenatedPath(rawKey)
      const idx = parseInt(locatorId.slice(sep + 2), 10)
      const locatorData = window.__LOCATOR_DATA__ ?? {}
      let fileData: (typeof locatorData)[string] | undefined = locatorData[key]

      // Fallback: if exact key misses, match entry by normalized key/file path.
      if (!fileData) {
        const pairs = Object.entries(locatorData)
        const hit = pairs.find(([k, v]) => {
          const nk = normalizePossiblyConcatenatedPath(k)
          const nfp = normalizePossiblyConcatenatedPath(v.filePath)
          return nk === key || nfp === key || nk.endsWith(key) || key.endsWith(nk)
        })
        fileData = hit?.[1]
      }

      const expr = fileData?.expressions[idx]

      // Prefer filePath from locator data because it reflects the true source file.
      let realFile = key
      if (fileData) {
        const fp = normalizePossiblyConcatenatedPath(fileData.filePath)
        realFile = isAbsolutePath(fp)
          ? fp
          : `${fileData.projectPath}${fp.startsWith('/') || fp.startsWith('\\') ? '' : '/'}${fp}`
      }

      return { file: realFile, line: expr?.loc.start.line ?? 1 }
    }

    function handleClick(e: MouseEvent) {
      if (!e.altKey) return
      e.preventDefault()
      e.stopPropagation()

      const target = e.target as HTMLElement | null
      if (!target) return

      let el: HTMLElement | null = target
      while (el) {
        const locatorId = el.getAttribute('data-locatorjs-id')
        if (locatorId) {
          console.log('[useLocator] data-locatorjs-id:', locatorId)
          console.log('[useLocator] __LOCATOR_DATA__ keys:', Object.keys(window.__LOCATOR_DATA__ ?? {}))
          const loc = resolveLocatorId(locatorId)
          console.log('[useLocator] resolved loc:', loc)
          if (loc) onLocate(loc)
          return
        }
        el = el.parentElement
      }
    }

    window.addEventListener('click', handleClick, true)
    return () => window.removeEventListener('click', handleClick, true)
  }, [onLocate])
}