# Construct Cockpit

Construct's Cockpit UI (`ui/client` + `ui/server`) as its own standalone
repository, split out of `thenewurbankid-web/construct` per
[construct#540](https://github.com/thenewurbankid-web/construct/issues/540)
steps 1-2. This branch (`540-cockpit-ui`) is the first real content on this
repo's new topology; it does not touch or build on `001-open-project-folder`
(this repo's existing, unrelated prototype branch) in any way.

A local, click-through web UI over Construct's four capabilities
(create / refactor / research / import), a chat-style wizard for
`import --route`, and a visual pages/JSX editor.

## Layout

```
ui/
  client/   Next.js (App Router, TypeScript) frontend. Organized as real
            Construct features (dashboard, settings, wizard, help,
            pages-editor, project-gate, auth, clone, ...), each a
            domain/service/workflow/hook/component/page/controller slice,
            with its own architecture.yml (framework: nextjs) -- it passes
            `construct validate` against itself. Own package.json/
            package-lock.json.
  server/   Node.js backend (Express + ws). Imports Construct's core
            CLI functions (packages/core/cli.mjs et al) directly -- no
            subprocess, no shelling out to the `construct` binary. Own
            package.json/package-lock.json.
packages/   NOT checked into this repo -- see "Cross-repo dependency on
            construct" below. Populated by `scripts/vendor-construct.sh`.
scripts/
  vendor-construct.sh   Fetches packages/{core,ast,engine,cli} from
                        thenewurbankid-web/construct at a pinned ref.
```

`ui/e2e` (the Playwright end-to-end suite) and the rest of construct's docs
have **not** moved yet -- they're still in `thenewurbankid-web/construct`.
Moving them is a natural follow-up to this split (see "What #540's later
steps will find" below), not part of steps 1-2.

## Cross-repo dependency on construct

`ui/server` imports Construct's core/CLI directly by relative path
(`../../../packages/core/cli.mjs`, `../../../packages/engine/palette.mjs`,
etc. -- 3 levels up from `ui/server/src` lands at this repo's root, which
is why `ui/client`/`ui/server` keep those exact names instead of being
flattened to `client`/`server`). Those packages are not published to any
registry today (`packages/cli`, `packages/core` in construct declare a
GitHub Packages `publishConfig`, but that has only ever been a dry run),
so there is nothing to `npm install` by name yet.

**This repo resolves that dependency by fetching, not by vendoring
(committing) a copy:**

```bash
npm run vendor     # runs scripts/vendor-construct.sh
npm install
```

`scripts/vendor-construct.sh` does a pinned, shallow, sparse-checkout clone
of `thenewurbankid-web/construct` and copies `packages/{core,ast,engine,cli}`
into this repo's `packages/` -- **git-ignored, never committed here.**

### Why fetch instead of commit a copy (the tradeoff)

Construct's own repo already solves an equivalent problem for its own
npm-distribution story (`ui/pack-npm.sh` + `ui/cockpit-npm-meta/`, #485):
it **copies** `packages/{core,ast,engine,cli}` into `packages/cockpit/` at
build time, at the same relative depth, for exactly the reason above
(several core modules resolve sibling files relative to their own
`import.meta.url` at runtime -- `packageRoot` in `packages/core/cli.mjs`,
`REPO` in `packages/engine/testRunner.mjs`, `BIN` in
`packages/engine/botRunner.mjs` -- so bundling collapses those and breaks
them). This repo reuses that same proven copy, with one difference:

- **`thenewurbankid-web/cockpit` (this repo) is currently PUBLIC, while
  `thenewurbankid-web/construct` is currently PRIVATE** -- the opposite of
  the two repos' intended end state (construct#540's target: construct
  public, cockpit private). Committing a copy of construct's core source
  into this repo's git history would make previously-private code public
  ahead of construct's own visibility flip, which construct#540 deliberately
  sequences last and reserves for an explicit owner decision. Fetching at
  build time instead means this repo's pushed history never contains that
  source -- only a script, which needs read access to construct (the
  builder's own `gh auth login` or SSH key) for as long as construct stays
  private.
- **Cost of this choice**: no live semver range, no lockfile entry -- re-
  vendoring is a deliberate, reviewed action (`CONSTRUCT_REF=<sha>
  scripts/vendor-construct.sh` then commit whatever *this* repo's own files
  changed as a result, if any), not something `npm update` ever does for
  you. `packages/.vendored-from` (written by the script, also git-ignored)
  records exactly which construct commit is currently checked out, for
  whoever's debugging a build.
- **The right long-term fix** is construct's own epic #480 (publishing
  `@line/construct-core`/`@line/construct` for real, to a registry both
  repos can reach) -- once that lands, this script can be replaced with an
  ordinary `"dependencies"` entry and a lockfile, no fetch step, no auth
  requirement, and this whole section goes away in favor of a normal
  README dependency line.

Pinned by default at `434962fcfe9ece14afe6c0c7a44312bfd5bcaa7f`
(construct's `work/2026-09-23` branch, at the time of the #540 steps 1-2
split). Override with `CONSTRUCT_REF=<sha-or-tag>`.

## Install / build / run

```bash
npm run vendor        # fetch packages/{core,ast,engine,cli} (see above)
npm install           # installs ui/client, ui/server, and the root deps
                       # packages/{core,ast,engine} need (axios, js-yaml,
                       # minimatch, estree-walker, typescript, ...)

# Terminal 1 -- backend, default port 4000
npm run dev:server    # or: cd ui/server && npm run dev

# Terminal 2 -- frontend, default port 3000
npm run dev:client    # or: cd ui/client && npm run dev
```

Open http://localhost:3000. The frontend talks to `http://localhost:4000`
directly (REST + the wizard's WebSocket); override with
`NEXT_PUBLIC_API_BASE`/`NEXT_PUBLIC_WS_BASE` (read at build time) if the
backend runs elsewhere. The backend's port is `PORT` (e.g. `PORT=4001 npm
--workspace=ui/server run dev`).

Production build:

```bash
npm run build:client   # next build
npm run build:server   # esbuild bundle -> ui/server/dist/ (still imports
                        # ../../../packages/core, ../../../packages/engine
                        # by relative path -- keep packages/ vendored
                        # alongside dist/, same depth, when deploying it)
```

### Workspace, auth and other environment variables

The server can only ever open/browse/read/write/run commands in **one
workspace folder** and starts with **no project open**
(`CONSTRUCT_WORKSPACE_ROOT`, default `$HOME/workspace`). Every path is
containment-checked against it. Unauthenticated + reachable from another
machine is remote code execution, so binding to a non-loopback `HOST`
**refuses to start** unless GitHub login (`CONSTRUCT_GITHUB_CLIENT_ID`/
`_SECRET`/`CONSTRUCT_ALLOWED_LOGINS`/`CONSTRUCT_SESSION_SECRET`) is
configured; on loopback with nothing configured it starts with a loud
`Authentication is OFF` banner. These behaviors live entirely in
`ui/server/src/` (auth.mjs, projectGuard.mjs, workspace.mjs) and are
unchanged by this repo split -- see that source for the full list of
`CONSTRUCT_*` variables.

## License

See `LICENSE`: this repo's own code (`ui/client`, `ui/server`) is
proprietary. The fetched `packages/{core,ast,engine,cli}` (never committed
here) remain under construct's own MIT license, independently of this
repo's license.

## What #540's later steps will find

Observations from doing steps 1-2, useful context for steps 3-8:

- **Step 2's "wire a real dependency" is not fully closeable until #480
  publishes core for real.** What's here is the most pragmatic real option
  today (see "Cross-repo dependency" above) — deliberately not
  `npm install github:...`, which doesn't fit construct's actual package
  shape (its root `package.json` is workspace-only, not a consumable
  package; `ui/server`'s imports need a specific physical `packages/*`
  layout, not a package resolved by name).
- **The repo-visibility mismatch found here (cockpit public, construct
  private) is worth flagging before step 7**, not just noting in this
  README -- it means step 7's "flip cockpit to private, construct to
  public" is two real flips in the opposite direction from where both
  repos sit today, not one.
- **`ui/e2e` didn't move with this split** (out of scope for steps 1-2)
  but rule 11's Playwright-test requirement will need it (or an
  equivalent) here once UI changes start landing in this repo — right now
  this repo has zero automated UI test coverage of its own.
- **`docs/DEPLOY.md`, `docs/commit-on-save.md` and other docs the old
  `ui/README.md` linked to (`../docs/...`) stayed in construct** — several
  cross-references in the copied source/comments still point at paths
  relative to construct's own repo root and will 404/dangle from here
  until step 3 (or a follow-up) either copies the relevant docs or rewrites
  those references to point at construct's public docs site.
- **`ui/build.sh`, `ui/pack-npm.sh`, `ui/cockpit-npm-meta/` stayed in
  construct** (not copied here) since they build construct's own
  `@line/cockpit` npm-distribution artifact from *construct's* checkout,
  not this repo's — worth an explicit decision in step 3 on whether that
  distribution path still makes sense once this repo is the source of
  truth for `ui/client`/`ui/server`, or whether it should be retired in
  favor of this repo publishing its own build.
