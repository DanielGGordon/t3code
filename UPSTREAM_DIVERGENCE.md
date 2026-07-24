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

---

## 2026-07-23 — True merge of upstream through `6f34ad3e8` (2026-07-21)

**Strategy change:** this sync is a real `git merge 6f34ad3e8` (~130 commits), not a
cherry-pick batch. Rationale: the fork had drifted 186 commits behind and per-commit review
stopped scaling; a merge also zeroes out divergence in areas we don't customize, so future
syncs only conflict where we actually differ. The cut point is deliberate: everything through
2026-07-21, **stopping before** the churny 7/22+ wave (Sidebar v2 beta + DB migration 033,
the "glass" UI redesign, and the mobile thread-sync overhaul) — take those as a follow-up
merge once upstream's daily fix-up rate drops.

### Decisions that supersede earlier entries

- **Mobile: resolved wholesale to upstream's official Android implementation.** A merge can't
  "skip" paths both sides touched, and our hand-rolled Android commits are unmaintained per the
  standing policy — so all `apps/mobile` conflicts were resolved by taking upstream. This keeps
  the no-investment spirit (zero fork-side mobile maintenance; future mobile changes merge
  clean) while dropping our stale copies. Upstream subsumed our polish (collapse persistence →
  `mobile-preferences.ts`, Gradle heap → `withAndroidGradleHeap.cjs`, font/favicon fixes,
  serialized pref writes → Semaphore in `MobilePreferencesStore`). **Fork-only mobile files kept:**
  `plugins/withAndroidSelfSignedServerTrust.cjs` (+ its `app.config.ts` plugin entry) and
  `scripts/publish-android-apk.sh` — inert unless we build the app.
- **Clerk upgrade (#3785/#3821), desktop/electron packaging fixes, prod splash asset,
  `ca1e08b5a` reasoning labels:** previously deferred/skipped, now pulled as part of the merge.

### Conflict resolutions of note

- `apps/server/src/ws.ts` + `server.test.ts` + `client-runtime` (`rpc/client.ts`,
  `state/shell.ts`): our #40 stale-shell-cache fix collided with upstream's rework of the same
  problem (`c14a5ca49`, `db4b2d8a0`). Took upstream — it covers both our failure modes
  (cursor-ahead → snapshot, large gap → snapshot) with tests, plus bounded replay and
  completion markers. Our #40 implementation and its tests are retired.
- `GitActionsControl.tsx`: dropped our client-side `worktreePath` pass-through from the #3822
  cherry-pick — upstream's merged #3822 preserves worktree metadata server-side in the decider.
- `FileBrowserPanel.tsx` / `FilePreviewPanel.tsx` / `index.css` / `AppSidebarLayout.tsx`:
  unioned — kept fork features (dotfiles toggle + root input + 3-arg `useProjectEntriesQuery`,
  Solarized theme layer + file-viewer worker pool, ThemeToggle) alongside upstream's new
  composer file links, workspace image preview, and sidebar width/backdrop work.
- `AGENTS.md`: adopted upstream's focused-verification policy; kept all fork sections.
- `.claude/skills` → upstream's symlink to `.agents/skills/`; our `redeploy` skill moved to
  `.agents/skills/redeploy/` (same resolved path as before).
