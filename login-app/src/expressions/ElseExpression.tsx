import type { ReactNode } from 'react'

interface ElseExpressionProps {
  condition: boolean
  children: ReactNode
}

export function ElseExpression({ condition, children }: ElseExpressionProps) {
  return !condition ? <>{children}</> : null
}
