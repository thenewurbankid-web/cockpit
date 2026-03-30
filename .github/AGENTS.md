# Cockpit Agents

## builder-dev

Expert in builder-app internals — InspectorPanel AST parsing, DOMTreePanel fiber traversal, scope hierarchy, Monaco integration, and Vite plugin development.

**When to invoke**: Modifying builder-app source code, fixing inspector bugs, adding tree panel features, or working on the dev server API.

**Key context**: 
- The inspector is modular — find the right file in `src/inspector/`: types, AST helpers, rewriters, sub-components, main panel (~2100 lines)
- The tree panel is modular — find the right file in `src/tree/`: types, tree builders, helpers, TreeRow, main panel (~1170 lines)
- The server is modular — `server/utils.js` (path safety, diagnostics), `server/astInfo.js`, `server/templates.js`, `server/devServer.js` (routes)
- All source transforms use `@babel/parser` AST — never regex
- React fiber `_debugSource` is the source-of-truth for element → file mapping
- `useLocator.ts` captures click events globally — canvas handlers must use `mousedown`

## login-app-dev

Expert in creating and modifying login-app pages, components, and expression components.

**When to invoke**: Adding new pages/components, editing existing login-app UI, or creating expression wrappers.

**Key context**:
- Named exports only, always declare `*Props` interface
- Inline styles only (no CSS frameworks)
- Files are auto-discovered by the builder via naming convention (`*Page.tsx`, `*.tsx` in components/, `*Expression.tsx`)
- Expression components must accept `children: ReactNode`

## api-dev

Expert in the Express source API server and TypeScript diagnostics integration.

**When to invoke**: Adding new API endpoints, modifying file operations, or extending the diagnostics system.

**Key context**:
- Server is split into modules: `utils.js` (REPO_ROOT, isSafeFile, diagnostics), `astInfo.js` (AST extraction), `templates.js` (file templates), `devServer.js` (routes)
- All file paths validated with `isSafeFile()` (path-traversal guard)
- Windows drive letter casing handled via case-insensitive comparison
- Endpoints proxied through Vite at `/__source*`
