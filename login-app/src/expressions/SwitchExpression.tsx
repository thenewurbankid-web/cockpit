import type { ReactNode } from 'react'

interface SwitchExpressionProps {
  value: string | number
  cases: Record<string, ReactNode>
  default?: ReactNode
}

export function SwitchExpression({ value, cases, default: defaultCase }: SwitchExpressionProps) {
  return <>{cases[String(value)] ?? defaultCase ?? null}</>
}
