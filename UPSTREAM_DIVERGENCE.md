# Upstream Divergence Log

This fork (`DanielGGordon/t3code`, tracked as `origin`) is based on
[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) (`upstream`). We periodically
review upstream commits and pull in the ones we want. This file is the running record of
**what we pulled, what we skipped, and why** — so future syncs don't re-litigate decisions
already made, and so anyone reading the fork understands how it diverges.

## How to use this log

- When reviewing a batch of upstream commits, add a dated section below.
- Record the upstream review point (last upstream commit considered), what was pulled,
  and — just as important — what was **deliberately skipped** and the reasoning.
- Keep decisions durable: if we skip something now but might revisit it, say so explicitly.

## Standing policy

- **Android / native mobile: do not pull.** We are not investing in the mobile app on this
  fork. Skip all upstream Android and native-mobile changes (the app scaffolding, native
  Kotlin modules, mobile persistence layers, mobile UI polish) unless they are a prerequisite
  for a web/server change we actually want. This supersedes any of our own earlier hand-rolled
  Android commits — we are not maintaining them going forward either.

---

## 2026-07-12 — Review of upstream through `c1ec1915f`

**Upstream review point:** `c1ec1915f` (2026-07-12) — 15 upstream commits ahead of our last
sync base `dad0889` (2026-07-07).

### Pulled (cherry-picked with `-x`)

- `3201e00ad` — [codex] Preserve worktree metadata during branch sync (#3822). **The priority
  pull.** Adds an `expectedBranch` optimistic-concurrency guard so a stale git-status sync can't
  regress a freshly-generated branch back to a temporary worktree branch; stops needlessly
  rewriting `worktreePath` during branch reconcile. **Conflict in
  `apps/web/src/components/GitActionsControl.tsx`:** our fork's `persistThreadBranchSync` calls
  `updateThreadMetadata({ input: { threadId, branch, worktreePath } })`, so upstream's switch to
  `resolveThreadBranchMetadataPatch` collided. Resolved by keeping our fork's
  `updateThreadMetadata` structure but spreading
  `resolveThreadBranchMetadataPatch(branch, activeServerThread.branch)` into the input (so we gain
  the `expectedBranch` guard) while still writing `worktreePath` back. `decider.ts`,
  `contracts/orchestration.ts`, and both test files auto-merged cleanly.
- `619b0ece9` — fix(marketing): platform-appropriate commit shortcut on the website (#3644).
  Clean.
- `ef943a26a` — Fix truncated chat error alert layout (#3899). Applied against current main
  (which already carries the `<Tooltip>`-wrapped banner), so this landed as the full upstream fix:
  the container layout `mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))]` that stops truncation,
  keeping the existing Tooltip.

### Skipped — Android / native mobile (per standing policy)

- `c1ec1915f` — Add Android mobile support (#3579). Full official Android port (native Ghostty
  terminal, native review-diff view, Android dialogs/menus, embedded fonts). We don't want
  Android work.
- `843cf176e` — fix(mobile): embed fonts and render project favicons reliably (#3823). Mobile-only.
- `2250e3ee7` — feat(client): persist offline environment data and mobile preferences (#3795).
  Primarily a mobile persistence/preferences layer; touches `client-runtime` but not worth the
  merge cost for our web/server focus right now. Revisit only if we want the offline state model.
- `8619ef22e` — Show compact PR number badges in mobile thread rows (#3827). Mobile-only.
- `f61fa9499` — Expose mobile PR indicator labels to accessibility (#3828). Mobile-only.
- `7778a1cea` — Use rounded depth logo for production splash screen (#3780). Mobile splash asset
  (`apps/mobile/assets/splash-icon-prod.png`) — our fork deleted it, so it came in as a
  modify/delete conflict. Dropped per the no-mobile policy.

### Skipped — depends on newer Codex schema (revisit after a Codex bump)

- `ca1e08b5a` — [codex] Label max and ultra reasoning (#3824). Cherry-picked cleanly but **fails
  typecheck** on our fork: upstream types `REASONING_EFFORT_LABELS` as `Record<string, string>`,
  whereas our fork tightened it to `Record<V2ModelListResponse__ReasoningEffort, string>`, and our
  vendored generated schema (`packages/effect-codex-app-server/.../schema.gen.ts`) only goes up to
  `xhigh` — no `max`/`ultra`. Those effort levels don't exist in the Codex app-server version we
  vendor, so the labels would be dead code anyway. Dropped; pull when we next regenerate/bump the
  Codex schema.

### Skipped — for now (revisit)

- `e9127658a` (#3821) + `e775bc622` (#3785) — Clerk stack upgrade. Deferred; take as a block
  when we next touch auth/toolchain so it doesn't drift too far.
- `18a41388e`, `0c6656585`, `03ac1f0cd` — desktop / electron-builder + pnpm-11 asar packaging
  fixes. Only relevant if we ship the desktop build; pull alongside the Clerk block.
