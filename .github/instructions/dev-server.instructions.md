---
applyTo: "builder-app/server/**"
description: "Use when editing devServer.js or adding new API endpoints. Covers the Express source API, path safety, and TypeScript diagnostics integration."
---

# Source API Server (devServer.js)

## Security

All file operations use `isSafeFile(filePath)` which resolves the path and checks it starts with the monorepo root. On Windows, comparison is case-insensitive to handle drive letter casing (`d:` vs `D:`).

## Endpoints

### Core
- `GET /__source?file=<abs>` — read file as plain text
- `POST /__source` — write `{ file, content }` to disk (HMR auto-picks up changes)
- `POST /__diagnostics` — TypeScript diagnostics for `{ file, content? }`

### Pages (login-app/src/pages/)
- `GET /__source/list-pages` — lists `*Page.tsx` files
- `POST /__source/create-page` — creates from template with `{ name }`
- `DELETE /__source/page/:componentName` — deletes page file

### Components (login-app/src/components/)
- `GET /__source/list-components` — lists `*.tsx` files
- `POST /__source/create-component` — creates from template
- `DELETE /__source/component/:componentName` — deletes component

### Expressions (login-app/src/expressions/)
- `GET /__source/list-expressions` — lists expressions with parsed props
- `POST /__source/create-expression` — creates with `{ name, props? }`
- `DELETE /__source/expression/:name` — deletes expression

### AST Info
- `GET /__source/ast-info?file=<abs>` — parses file with `@babel/parser`, returns component and JSX expression metadata

## Adding New Endpoints

1. Define the route on `app` (Express instance)
2. Validate the file path with `isSafeFile()` before any fs operation
3. Use `path.resolve()` for path normalization
4. Return JSON responses with `{ ok: true }` on success or `{ error: string }` on failure
5. Log operations with `console.log(\`[endpoint-name] ...\`)`
