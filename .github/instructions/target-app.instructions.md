---
applyTo: "**"
description: "Use when editing pages, components, or expressions in the active target project. Covers naming conventions, file templates, and how the builder auto-discovers new files."
---

# Target App Development Guide

## What Is the Target App

The target app is the React application currently active in Cockpit — whatever project root has been set via the project picker. Changes to its source files are reflected live in the builder's preview canvas via Vite HMR.

## File Organization

| Directory | Convention | Example |
|-----------|-----------|---------|
| `src/pages/` | `*Page.tsx`, named export `MyPage`, interface `MyPageProps` | `LoginPage.tsx` |
| `src/components/` | `*.tsx`, named export `Button`, interface `ButtonProps` | `Button.tsx` |
| `src/expressions/` | `*Expression.tsx`, named export, interface with `children: ReactNode` | `IfExpression.tsx` |

## Auto-Discovery

The builder discovers files via API endpoints:
- Pages: any `*Page.tsx` in `src/pages/` → `GET /__source/list-pages`
- Components: any `*.tsx` in `src/components/` → `GET /__source/list-components`
- Expressions: any `*.tsx` in `src/expressions/` → `GET /__source/list-expressions`

No registration or import map is needed — just create the file with the right naming convention.

## Component Template

```tsx
interface MyComponentProps {
  // declare all props here
}

export function MyComponent({ }: MyComponentProps) {
  return (
    <div>
      {/* component content */}
    </div>
  )
}
```

## Rules

- Always use **named exports** (not default exports)
- Always declare a `*Props` interface even if empty
- Use **inline styles** (no CSS modules, no Tailwind, no styled-components)
- Expressions must accept `children: ReactNode` as a prop
- The builder reads prop types from the interface — keep it accurate
