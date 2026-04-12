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
| `src/pages/` | `<PageName>/page.tsx`, named export (any name), interface `*Props` | `SignInPage/page.tsx` |
| `src/components/` | `*.tsx`, named export `Button`, interface `ButtonProps` | `Button.tsx` |
| `src/expressions/` | `*Expression.tsx`, named export, interface with `children: ReactNode` | `IfExpression.tsx` |

### Page structure (Next.js-style)

Each page lives in its own **folder** inside `src/pages/`. The file is always named `page.tsx`:

```
src/pages/
  SignInPage/
    page.tsx          ← exports the component (any name, e.g. AlSignIn)
    states/           ← state fixtures for this page
      default/
        data.json
        model.ts
      loading/
        data.json
        model.ts
      order.json      ← custom state ordering (array of state keys)
```

> **Important**: The exported component name inside `page.tsx` does **not** need to match the folder name. The builder reads the first exported component name from the AST and uses it as `root` in the pages list. This is the name that must match what React fiber reports — scope hierarchy and `rootComponentName` comparisons all depend on it.

## Auto-Discovery

The builder discovers files via API endpoints:
- Pages: any directory containing `page.tsx` in `src/pages/` → `GET /__source/list-pages`
- Components: any `*.tsx` in `src/components/` → `GET /__source/list-components`
- Expressions: any `*.tsx` in `src/expressions/` → `GET /__source/list-expressions`

No registration or import map is needed — just create the file/folder with the right naming convention.

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
