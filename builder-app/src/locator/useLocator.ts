import { useEffect } from 'react'
import type { SourceLocation } from '../App'
import { findNearestSourceElement } from '../fiberSource'

// useLocator — Alt+Click any element to resolve its source location via
// React fiber _debugSource (injected by @babel/plugin-transform-react-jsx-source,
// which @vitejs/plugin-react enables automatically in development).
export function useLocator(onLocate: (loc: SourceLocation) => void, extraWindow?: Window | null) {
  useEffect(() => {
    if (import.meta.env.PROD) return

    function handleClick(e: MouseEvent) {
      if (!e.altKey) return
      e.preventDefault()
      e.stopPropagation()

      const target = e.target as HTMLElement | null
      if (!target) return

      const hit = findNearestSourceElement(target)
      if (hit) {
        console.log('[useLocator] fiber source:', hit.info)
        onLocate({ file: hit.info.file, line: hit.info.line })
      }
    }

    window.addEventListener('click', handleClick, true)
    extraWindow?.addEventListener('click', handleClick, true)
    return () => {
      window.removeEventListener('click', handleClick, true)
      extraWindow?.removeEventListener('click', handleClick, true)
    }
  }, [onLocate, extraWindow])
}