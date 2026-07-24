# AGENTS.md

## Task Completion Requirements

- Keep local verification focused on the files and packages changed. Run the smallest relevant test set; do not run the full workspace test suite as a routine completion step.
  - Use `vp test run <test-files>` for focused built-in Vite+ tests. Use `vp run test` only when the affected package specifically requires its `test` script.
  - Backend changes must include and run focused tests for the changed behavior.
  - Run targeted formatting, lint, and type checks for the affected scope when available.
- Do not run repo-wide `vp check`, `vp run typecheck`, `vp run test`, or equivalent full-suite commands locally unless the user explicitly requests them. CI is responsible for the full verification suite.
- After frontend feature development or any user-visible frontend behavior change, the primary agent must run one integrated verification pass for each affected client surface after integrating the work:
  - Web: use the `test-t3-app` skill. Launch one isolated environment, authenticate through the printed pairing URL, and verify the affected flow in the controlled browser.
  - Mobile: use the `test-t3-mobile` skill. Connect one representative iOS Simulator or Android Emulator available on the host to one isolated environment and verify the affected flow. On compatible macOS hosts, prefer iOS for cross-platform changes and stream it through serve-sim in the T3 Code in-app browser or another available agent browser; use Android when it is the affected or viable platform.
  - Subagents must not independently launch dev servers or repeat integrated client verification unless their delegated task explicitly requires it.
  - Stop dev servers, watchers, and other long-running verification processes when the focused verification is complete.

## Local Dev & Testing (start here in a fresh worktree)

A freshly-created `t3code/*` worktree ships **without `node_modules`** — install before running
anything:

- `pnpm install --frozen-lockfile --prefer-offline` — packages come from the shared pnpm store, so
  this is ~10s and fully offline, not a cold download.

Then, to exercise a change without spinning up the whole app (fastest feedback loop):

- Run one test file from its package dir: `cd apps/server && npx vp test run src/workspace/WorkspaceFileSystem.test.ts`
  (`vp test` is Vitest under the hood; add `run` for a single non-watch pass).
- Typecheck one package: `npx tsgo --noEmit -p apps/server/tsconfig.json`.
- Lint changed files' area: `npx vp lint apps/server/src/workspace/`.

Server behavior (filesystem, workspace, VCS, etc.) is very testable in isolation — copy an existing
`*.test.ts` in the same directory as a template rather than booting a server. `apps/server/src/workspace/*.test.ts`
are good examples: they use `it.layer(TestLayer)` + a `makeTempDir` helper to run the real Effect services
against a scratch dir, so you can reproduce a "does the server accept/reject this file?" bug in seconds.

Gotchas when writing these tests:

- This repo's Effect build has **no `Effect.either`** — use `Effect.exit` (with `Exit.isSuccess`/`Exit.isFailure`)
  or `Effect.flip` to capture the error channel.
- `vp test` **suppresses `console.log`** on passing tests — assert the values you want to see (a failing
  `expect(...).toEqual(...)` prints the actual object) instead of logging them.

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

This is a fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code). See
[`UPSTREAM_DIVERGENCE.md`](./UPSTREAM_DIVERGENCE.md) for the running log of which upstream
changes we've pulled in, which we've deliberately skipped, and why. Update it whenever you
review or merge upstream commits. Standing policy: **do not pull Android / native-mobile
changes** — we are not investing in the mobile app on this fork.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Claude Transcript Import (15-minute timer on the T3 Code host)

A systemd **user** timer, `t3-claude-import.timer`, runs every 15 minutes on the host that serves
T3 (`journalctl --user -u t3-claude-import.service` for logs). It executes
`~/projects/meta/t3-ops/import-all-claude.sh`, which runs `t3 import sync` from the deployed
checkout at `~/projects/meta/t3code-v2` to mirror every Claude Code transcript under
`~/.claude/projects` into T3 as backdated, resumable threads (thread id `claude-import-<sessionId>`).
The sweep logic lives in `apps/server/src/cli/import.ts` and `apps/server/src/import/syncPlan.ts`.
When debugging duplicate or missing conversations, look here first. Key invariants: transcripts of
sessions T3 itself spawned are skipped (`skipped-owned` — session id found in another thread's
`provider_session_runtime` resume cursor; `skipped-worktree` — transcript cwd inside the T3
worktrees dir; `skipped-copy` — a forkSession copy whose message uuids largely already live on
another thread), and deleted imported threads stay deleted via the event-log tombstone.

## Finishing a feature: MANDATORY test-deploy + PR flow

When a feature or bugfix is complete in a `t3code/*` worktree, do NOT merge to `main`. Follow **[docs/test-deployments.md](docs/test-deployments.md)**: open a PR, deploy the branch to a test port from the pool (`node scripts/test-deploy.ts --pr <url> --note "<desc>" --comment`), and comment the test URL on the PR so the user can jump straight into the running instance. Prod (external `7443` / loopback `3773` / unit `t3code.service`) is only redeployed from `main` after the user approves the PR — and `t3code.service` is never restarted without explicit user approval in the conversation. The scripts refuse all prod targets; never work around the guard.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vpr sync:repos`; use `vpr sync:repos --repo <id>` to sync one configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.
