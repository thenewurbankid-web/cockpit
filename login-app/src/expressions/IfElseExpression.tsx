import type { ReactNode } from 'react'

interface IfElseExpressionProps {
  condition: boolean
  then: ReactNode
  else: ReactNode
}

export function IfElseExpression({ condition, then: thenNode, else: elseNode }: IfElseExpressionProps) {
  return condition ? <>{thenNode}</> : <>{elseNode}</>
}
