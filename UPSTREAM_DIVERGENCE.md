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

## 2026-07-27 — True merge of upstream through `f4c394323` (2026-07-26)

Sidebar v2 beta, the glass redesign, "Auto" runtime mode, thread snoozing,
shared `t3.json` project config, remote server updates. **79 commits** new since
the `6f34ad3e8` cut point (git reported 208 — see the ancestry note below).
18 files conflicted; 38 more were modified on both sides and auto-merged.

### Ancestry repair (do this before any future sync)

PR #42 was **squash-merged**, which discards the second parent. `origin/main`
carried the merged content of the 2026-07-23 sync but git no longer believed
`6f34ad3e8` was an ancestor, so `merge-base` resolved back to `dad088976`
(2026-07-07). Measured cost: **76 conflicted files / 238 hunks / 10 add-add**
instead of 18 / 40 / 0.

Repaired by re-merging PR #42's original merge commit, which still existed on
GitHub as `origin/t3code/upstream-sidebar-change` (the repo keeps merged
branches). The tree was byte-identical, so the graft commit has an empty diff
and only restores provenance. A rule was added to `AGENTS.md`: sync PRs land as
merge commits or ff-push, never squash, never rebase, never `git revert -m 1`.

Note: `upstream/main` advanced from `89c5a192f` to `f4c394323` between planning
and merging, so this sync includes one commit beyond the planned cut point
(`f4c394323`, background preview capture / picture-in-picture).

### Migration numbering — permanent fork divergence

Upstream shipped `033_ProjectionThreadsSettled` and `034_ProjectionThreadsSnoozed`.
This fork already owns id 33 (`ProjectionThreadRestartRequest`), **recorded in
production's `effect_sql_migrations` since 2026-07-09**. Effect's Migrator run
loop is purely ordinal — `if (currentId <= latestMigrationId) continue`, with no
name or checksum comparison — so renumbering the fork's migration upward would
mean upstream's id-33 never runs on prod, `settled_override`/`settled_at` are
never created, and the (silently auto-merged) `ProjectionThreads.ts` queries
that name those columns fail on every thread read and write. **A full outage
that CI and every fresh-DB test-deploy pass green.**

Resolution: the fork keeps 33; **upstream's two are renumbered locally to 034
and 035**. Prod's high-water mark of 33 then simply admits them on next boot,
with zero database surgery. Every future sync must re-apply this offset
(currently +1, growing by one per fork-only migration added).

**Known hole while the offset stands:** a `state.sqlite` created by a stock
`npx t3` release (e.g. the ARM Pi) records 33 = `ProjectionThreadsSettled`, so a
fork build opening such a database would skip the fork's restart-request
migration by number and fail every thread read on `requesting_restart`. **Fork
builds must not be pointed at stock-created databases.** Closed permanently by a
planned `ensureForkSchema` seam — the first follow-up PR, never bundled with a
merge.

### Taken from upstream, replacing fork implementations

- **Claude Opus 5.** Fork PR #44 is retired for upstream's `41a430a88`, a strict
  superset: a 200k/1M `contextWindow` descriptor (so the API id is really
  `claude-opus-5[1m]`) and a dedicated `MINIMUM_CLAUDE_OPUS_5_VERSION = 2.1.219`
  gate. The fork reused Fable 5's 2.1.169 gate and advertised 1M while sending
  200k. Removed with it: the `case "claude-opus-5"` short-circuit in
  `selectedClaudeContextWindow` (`ClaudeAdapter.ts`), which would have silently
  overridden upstream's descriptor — **that file auto-merged with no conflict**.
  Also removed: the fork's Opus-5 assertions inside the Fable-5 registry tests,
  which asserted presence at CLI 2.1.169 and would now fail. One live prod thread
  on `claude-opus-5` with no persisted `contextWindow` moves from 200k to 1M —
  what the UI already claimed, but a real cost change.
- **`connectionStatusHeadline`** retired for upstream's `connectionStatusTitle`
  (`315b27385`), which delegates to `connectionStatusText` and stays in sync with
  the phase table automatically. Same pattern as the #40 shell-sync retirement.
- **`ui/alert.tsx` / `ComposerBannerStack`**: the fork's flex-wrap refactor
  reverted. Upstream's banner stack handles narrow screens with grid utilities
  that assume upstream markup.

### Deliberately kept against upstream

- **`showsHorizontalScrollIndicator={false}`** on `MessagesTimeline`. LegendList
  otherwise emits an inline `overflowX: auto` that overrides `overflow-x-hidden`
  and lets a stray horizontal axis hijack left-edge text selection. No test
  covers this; it will re-conflict.
- **No eager `threadModelSelections` write at turn start** in
  `ProviderCommandReactor`. Upstream added one alongside `pendingTurnStart`; the
  fork's deferred model-change recycle decides whether a pending recycle is still
  needed by comparing against that map, so writing it eagerly makes every pending
  recycle look already applied. Taking upstream's side broke 7 deferred-recycle
  tests. Upstream's `pendingTurnStart: true` flag is kept.
- **`importCommand`** in `bin.ts` alongside upstream's new `serviceCommand`.

### Sidebar — fork work culled by owner decision

Only the host CPU/memory readout survives. It moved out of `Sidebar.tsx` into
the shared `components/sidebar/SidebarChrome.tsx`, so it now renders in **both**
sidebar v1 and the v2 beta (previously v1 only). Upstream had extracted
`SidebarChromeHeader`/`Footer` into that file with no host-stats slot, so taking
their side of the hunk would have deleted the mount and stranded the imports.

Dropped: `sidebarChatListView` (the grouped/flat toggle), boxed project cards,
the restart-request sidebar pill and its test. **The restart-request feature
itself is untouched** — server detection, chat surfacing and migration 033 all
remain; only its sidebar affordance is gone.

Sidebar v2 ships **default OFF** (upstream's own default).

### Color schemes culled to Solarized

Upstream's glass redesign introduced a token family (`--sidebar-*`, `--glass-*`,
`--chat-composer-*`, `--surface-raised`) that every scheme must re-declare.
Maintaining five against an upstream that keeps hard-coding palettes into new
surfaces was not worth it. Dracula, Gruvbox, Catppuccin and Tokyo Night are
removed; a stored value for one of them falls back to `default`.

**Upstream's `[data-sidebar-version]` block had its ten generic tokens stripped**
(`--background`, `--foreground`, `--card`, `--card-foreground`, `--accent`,
`--accent-foreground`, `--muted`, `--muted-foreground`, `--border`, `--input`).
That block applies unconditionally — `AppSidebarLayout` sets the attribute even
with the beta off — and element-scoped custom properties beat every
`:root[data-scheme]` declaration regardless of specificity, so keeping them would
kill Solarized inside the entire sidebar subtree, including the host-stats
readout. Only the `--sidebar-*` family and `background-color` are retained, and
Solarized now declares that family itself. **Expect this to re-conflict on every
upstream sidebar-styling sync.**

Resolving this hunk by naive union does not build: both sides are `+1` brace
depth and share one closing `}` past the marker. This is the second time that
trap has appeared in `index.css` — verify with a brace-balance check and a real
`@t3tools/web build`, not just a typecheck.

### Merged but gated or must-not-run

- **"Auto" runtime mode** (`fbd77420f`) is merged but **hidden behind a Features
  per-device toggle** (`composerAutoRuntimeModeVisible`, default off). It hands
  tool-call approval to an AI reviewer inside a workspace-write sandbox. It is
  also a one-way door for rollback: `ProjectionThread.runtimeMode` has no
  decoding default and `listThreadRows` is a `findAll`, so one thread set to
  Auto makes the whole shell snapshot undecodable on a pre-merge build. See
  `docs/operations/rollback-2026-07-27-sync.md`.
- **`t3 service install` / `uninstall`** (`ab4a88386`) is merged but **must never
  be run on the deploy host**. `bootService.ts` hard-codes the unit name
  `t3code.service` and unconditionally writes/deletes
  `~/.config/systemd/user/t3code.service` — the hand-written production unit. A
  reference copy is now committed at `deploy/t3code.service`.
- **Server self-update** (`ab4a88386`) merged and **audited as inert here**:
  `resolveServerSelfUpdateCapability` returns `boot-service` only when
  `T3_BOOT_SERVICE_UNIT === "t3code.service"` (the prod unit does not set it) and
  returns null outright whenever `INVOCATION_ID` is set (it is, under systemd).
  The respawn path additionally needs a published `node_modules/t3/dist/`; prod
  runs a source checkout. The UI action never renders. Re-audit if the fork ever
  adopts upstream's boot service.

### Verified clean, no action needed

State-directory resolution is **unchanged** for a production `t3 serve`:
`deriveServerPaths` and `resolveBaseDir` are byte-identical to the cut point, and
`a17cbc3b4`'s worktree-local `.t3` default is confined to `scripts/dev-runner.ts`
(nothing under `apps/` imports it). No `.github/` changes since the cut; no Node
or pnpm engine bump; packaging churn is Electron-only; the new blocked-port list
contains nothing in 7444-7453 or 3773.

`apps/mobile/**` taken wholesale per the standing no-mobile policy — zero
conflicts. The one fork-only line preserved is the
`withAndroidSelfSignedServerTrust.cjs` plugin entry in `app.config.ts`
(`withAndroidGradleHeap.cjs` is now upstream's own), along with
`certs/t3-server.crt` and `scripts/publish-android-apk.sh`. Not built, not tested.

### Deferred to follow-up PRs

1. `t3code/migration-seam` — the durable `ensureForkSchema` + a one-time guarded
   ledger repair. Must account for `t3-claude-import.timer` running a second
   migrating process against the same database.
2. Culling `useComposerProjectSkills`, now redundant with upstream's server-side
   `ClaudeSkills.ts` (`6b9a5987f`); giving `ProjectionThread.requestingRestart` a
   decoding default; switching test-deploy's `--seed copy` from `cpSync` on a hot
   WAL database to a real `backup()` that also runs `neutralizeWorkspacePaths`.
3. `scripts/test-deploy-lib.ts` pins `PRUNE_SCHEMA_VERSION = 32` while prod has
   been at 33 since 2026-07-09, so the **default curated seed has been silently
   falling back for 18 days**. Bump it and republish the template.

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
