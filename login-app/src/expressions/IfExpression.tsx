import type { ReactNode } from 'react'

interface IfExpressionProps {
  condition: boolean
  children: ReactNode
}

export function IfExpression({ condition, children }: IfExpressionProps) {
  return condition ? <>{children}</> : null
}
