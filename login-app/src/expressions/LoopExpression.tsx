import type { ReactNode } from 'react'

interface LoopExpressionProps {
  items: unknown[]
  children: (item: unknown, index: number) => ReactNode
}

export function LoopExpression({ items, children }: LoopExpressionProps) {
  return <>{items.map((item, i) => children(item, i))}</>
}
