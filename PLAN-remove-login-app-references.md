# Plan: Remove login-app References from Cockpit

Cockpit is a general-purpose visual builder that works with **any** imported React project. All hardcoded references to `login-app` as the default/fallback project must be removed. The `login-app` workspace may remain as an example project but must not be assumed anywhere in the builder code or docs.

---

## 1. `builder-app/server/devServer.js`

**Problem:** `getProjectRoot()` falls back to `login-app` when no project is set.

**Fix:** Return `null` (or `activeProjectRoot`) when no project root is set. All callers that currently rely on this fallback must handle `null` gracefully (return a 400 or empty response, not a path into login-app).

```js
// Before
function getProjectRoot(req) {
  const raw = req.query.projectRoot || req.body?.projectRoot
  if (raw) return path.resolve(raw)
  return path.resolve(REPO_ROOT, 'login-app')  // ← remove this
}

// After
function getProjectRoot(req) {
  const raw = req.query.projectRoot || req.body?.projectRoot
  if (raw) return path.resolve(raw)
  return activeProjectRoot ?? null
}
```

Also remove the comment: *"Falls back to login-app inside the monorepo to preserve backwards compatibility."*

---

## 2. `builder-app/vite.config.ts`

**Problem:** `@login-app` path alias is hardcoded, pointing to `../login-app/src`.

**Fix:** Remove the static alias. The `cockpitDynamicAlias` plugin already reads `cockpit.settings.json` to provide dynamic aliases per active project — that's the correct mechanism.

```ts
// Before
'@login-app': path.resolve(__dirname, '../login-app/src'),

// After: Remove this line entirely
```

Also remove the comment: *"Lets builder-app import login-app source files directly."*

---

## 3. `builder-app/tsconfig.json`

**Problem:** `@login-app/*` path alias hardcoded.

**Fix:** Remove it — dynamic aliases from `cockpit.settings.json` handle this at runtime; the builder's own TypeScript compilation doesn't need to resolve target-project paths.

```json
// Before
"@login-app/*": ["../login-app/src/*"]

// After: Remove this entry
```

---

## 4. `builder-app/src/tree/treeBuilders.ts` (line 86)

**Problem:** Comment says `'/pages/' / '/components/' heuristic for login-app style projects`.

**Fix:** Change comment to: `'/pages/' / '/components/' heuristic for Cockpit-structured projects`.

---

## 5. `builder-app/src/preview/ComponentLoader.tsx` (line 205)

**Problem:** Comment says `// login-app DOM nodes at the top level`.

**Fix:** Change to `// target app DOM nodes at the top level`.

---

## 6. `package.json` (root)

**Problem:** `login-app` listed as workspace, `dev:login` and `build:login` scripts present.

**Decision:** Keep login-app as an *example project* in the monorepo (useful for demos/testing), but rename the scripts to make clear it's just a sample:

```json
// Before
"dev:login": "npm run dev --workspace=login-app",
"build:login": "npm run build --workspace=login-app",

// After
"dev:example": "npm run dev --workspace=login-app",
"build:example": "npm run build --workspace=login-app",
```

---

## 7. `.github/copilot-instructions.md`

**Problems:**
- "An AI agent modifies **login-app** source files" → generalize
- `login-app/` described as "example target app" ✓ (keep as example)
- `loginAppHmrNotify()` section still says "login-app files"
- Common Patterns section says "Adding a new login-app page"

**Fixes:**
- Opening: "An AI agent modifies the **target project** source files..."
- HMR section: "watches target project files and sends custom HMR events"
- Common Patterns: Rename sections to "Adding a new page", "Adding a new component"
- Remove the hardcoded `login-app/src/pages/MyPage.tsx` path examples; describe the pattern generically

---

## 8. `.github/AGENTS.md`

**Problem:** `login-app-dev` agent role is specific to `login-app`.

**Fix:** Rename to `target-app-dev`, update description to be generic:

```
## target-app-dev
Expert in creating and modifying pages, components, and expression components in the active target project.
When to invoke: Adding new pages/components, editing existing UI, or creating expression wrappers in the active project.
```

---

## 9. `.github/instructions/login-app.instructions.md`

**Problem:** Entire file is `login-app`-specific.

**Fix:** Rename file to `target-app.instructions.md`. Update `applyTo` from `login-app/**` to the project root pattern. Rewrite the intro to be generic — the "target app" is whatever project is currently active in Cockpit, not specifically `login-app`.

---

## 10. `.github/instructions/vite-config.instructions.md`

**Problem:** References `login-app/src/` as the watched directory and `@login-app` alias.

**Fixes:**
- Change: "Watches `login-app/src/` for file changes" → "Watches the active project's source directory for file changes"
- Change: "`@login-app` alias — resolves to `../login-app/src`" → "Dynamic aliases resolve via `cockpit.settings.json`; no static alias needed"

---

## 11. `README.md`

**Problems (multiple lines):**
- "target app (`login-app`)" → "any target React app"
- `ComponentLoader.tsx` description mentions login-app hardcoded
- "Agent writes source files — AI agents edit `login-app/src/**`"
- `login-app/` in monorepo layout described as "target app" (fine, but note it's an example)

**Fixes:** Replace all "login-app" descriptions with generic "target project / example project" language. Keep the login-app directory entry in the layout with a note: `← example target app (not required)`.

---

## Execution Order

1. `devServer.js` — fallback removal (most impactful, affects runtime behavior)
2. `vite.config.ts` + `tsconfig.json` — remove static alias
3. `treeBuilders.ts` + `ComponentLoader.tsx` — comment fixes
4. `package.json` — rename scripts
5. `.github/` docs — instructions, AGENTS.md, copilot-instructions.md
6. `README.md` — prose updates

---

## What NOT to Change

- `login-app/` directory and its contents — keep as example project
- `loginAppHmrNotify` **plugin name** in `vite.config.ts` — internal implementation detail, rename is optional
- The `login-app` workspace entry in `package.json` — keep it, just rename the scripts
