---
name: redeploy
description: Redeploy this self-hosted T3 Code prod server (https://t3.gordonlabs.dev) to the latest origin/main. Syncs the deploy checkout to a detached copy of origin/main, rebuilds, and restarts t3code.service via a detached unit. Always waits for every other thread to be idle (2 minutes quiet) before restarting; never interrupts running work. Use when the user says "/redeploy", "redeploy T3", or wants prod updated to main. Only runs on the T3 deploy host.
---

# Redeploy T3 Code (prod)

Redeploys the self-hosted T3 Code server to the current `origin/main`. The logic lives in
`redeploy.sh` next to this file; your job is to run it and report what it prints.

## HARD RULE — never redeploy while other threads are active

**`/redeploy` ALWAYS means "wait until every other thread has been idle for 2 minutes, then
deploy".** Restarting `t3code.service` kills every running agent turn on the box, and the user
has lost real work to this. So:

- **Never assume the user wants an immediate restart.** Not because they said "now", "asap",
  "quickly", or "just redeploy"; not because the deploy "looks small"; not because the
  threads "look finished". Only the idle gate decides when it is safe.
- **Never bypass the gate.** `redeploy.sh` waits for idle on its own (before the checkout and
  again before the restart) and has no flag to skip it. Do not edit the script, set
  `T3_IDLE_SECS=0`, restart `t3code.service` by hand, or run `systemctl`/`systemd-run` yourself
  to get around the wait.
- **Never use `--ignore-thread` to release a thread that is actually working.** It exists for
  your own chat and for a run you have _verified_ is a zombie. If you are unsure, wait.
- **Just run it and let it wait**, in the background, up to the two-hour limit. Do not ask the
  user "should I wait for the other threads?" — the answer is always yes. If it aborts on the
  timeout, nothing was restarted: report which threads held it and offer to retry.
- Only an explicit, unambiguous instruction to interrupt other running threads (for example
  "kill everything and redeploy now, I don't care about the other chats") changes this, and
  even then, name the threads that will be cut off and confirm first.

## What the script does

1. **Pauses the Claude transcript import.** Stops `t3-claude-import.timer` (if it was active)
   and waits up to 15 min (`T3_IMPORT_WAIT_SECS`) for any in-flight
   `t3-claude-import.service` run to finish; aborts before touching the checkout if it doesn't.
   That timer runs `t3 import sync` from this same checkout every 15 minutes, so without the
   pause it would run the _new_ CLI against the DB the _old_ server is still writing during the
   multi-minute install/build window (see "Why the import pause matters" below).
2. `git fetch` the deploy checkout (`~/projects/meta/t3code-v2`) and hard checkout a
   **detached copy of `origin/main`** — the deploy dir becomes a plain snapshot of
   `origin/main`, no branches to reason about (it also drops the leftover `deploy` label).
3. `pnpm install` + `pnpm --filter @t3tools/web build` (prod runs the server from source; the
   root `pnpm build` would also build the Electron desktop app, which needs libsecret headers).
4. If the build succeeds, fires a **detached** `systemctl --user restart t3code.service` as a
   transient systemd unit (so the restart completes even though this session dies). That unit
   waits for loopback health, **then re-starts the import timer**, and writes a health report
   to `/tmp/t3-redeploy-status.log`.

The timer is re-enabled on every path: by the detached unit after the restart (with its own
EXIT trap), or by the script's EXIT/INT/TERM/HUP trap if it stops before handing off (fetch,
install or build failure, wait timeout). A timer that was already stopped before the redeploy
is left stopped.

### Why the import pause matters

Orchestration v2 keeps its data in `~/.t3/userdata/statev2.sqlite`, seeded **once** from the
legacy `state.sqlite` when `statev2.sqlite` is missing and never re-seeded. If that seed
happened inside the build window, everything the old server wrote to `state.sqlite` after the
snapshot would be silently lost once the new server started on the already-existing
`statev2.sqlite`. Two layers now prevent it:

- **Code:** only the long-running server (`t3 serve` / `t3 start` / bare `t3`) may perform the
  seed. Any other command (`t3 import sync`, `t3 session audit`, `t3 project …`, `t3 auth …`)
  that finds `statev2.sqlite` missing while `state.sqlite` exists fails fast with
  _"The v2 database is not initialized yet … Start the T3 Code server once"_ and writes
  nothing. That error from the import service right after a v1→v2 checkout is expected and
  harmless; it clears once the new server has started.
- **Deploy:** this script pauses the timer across the window.

Don't run other `t3` CLI commands from the deploy checkout between the checkout and the
restart either.

## The idle gate (always on)

`redeploy.sh` waits for T3 to be idle on every run. Run it in the background
(`run_in_background`): it can wait up to two hours (`T3_IDLE_MAX_WAIT_SECS`, in each of its two
gates) before it aborts with nothing changed. (`--when-idle` is still accepted but does nothing
extra; waiting is no longer optional.)

- **What counts as busy:** a thread with a `pending` (queued) or `running` run, read straight
  from `statev2.sqlite` by `scripts/deploy-idle-check.ts`. A run `waiting` on a person's
  approval or answer is not busy, since it survives a restart. Any busy poll restarts the
  quiet clock; the server must stay quiet for `T3_IDLE_SECS` (default 120) in a row.
- **Two gates:** one before the checkout, so the live server's files are not swapped under a
  conversation that is still working, and another after the build, right before the restart,
  since the install and build take minutes. The import timer is only paused between them.
- **Your own chat is excluded** when it runs in a `t3code/*` worktree (the idle check matches
  the thread by worktree path). From a chat in the main checkout, pass its thread id with
  `--ignore-thread <id>`, otherwise the script waits on the chat that launched it until the
  timeout. The same flag releases a run you know is a zombie (see the hard rule above).
- **While it waits** it prints each busy thread (id, status, title) whenever that list changes.
- **Notice:** after every redeploy, the detached unit publishes
  "T3 was updated and restarted (now at <sha>)" with `t3 notice` once the new server answers.
  Every connected client shows it as a warning toast, and clients that reconnect within two
  minutes still see it. It runs from the new build against the new server on purpose: the
  new checkout's CLI must not touch the database before the old server has stopped. The
  status log gains `notice=published|failed|skipped`; a failed notice never fails the deploy.
  `t3 notice "<message>"` also works on its own, for any announcement.

## CRITICAL — this session will drop

This chat runs _inside_ `t3code.service`. When the service restarts, **this chat's own
session disconnects.** That is expected and unavoidable — the deploy still finishes in the
background. Reconnect and read the status log.

## How to run

```bash
bash "$(git rev-parse --show-toplevel)/.claude/skills/redeploy/redeploy.sh"
```

Launch it with `run_in_background: true` (it may wait up to two hours for other threads to
finish), tell the user it is waiting for the other threads and will deploy once they have been
idle for 2 minutes, and check its output as it progresses. Then:

- **If the script aborts before the restart** (e.g. build failure): report the error and do
  NOT restart anything. Nothing was deployed; the old server is still running untouched.
- **If it reaches "Redeploy launched"**: tell the user the connection will blip in a couple
  seconds, and that after reconnecting they can verify with:
  ```bash
  cat /tmp/t3-redeploy-status.log
  ```
  A healthy result shows `service-active=active`, `loopback-3773=200`, `public=200` (https://t3.gordonlabs.dev/),
  `notice=published`, `served-commit` matching the target, and `import-timer=active` (when
  `paused-by-redeploy=1`).
- **If the script aborts**, confirm the timer came back:
  `systemctl --user is-active t3-claude-import.timer` (start it by hand if the trap could not).

Never restart `t3code.service` by any other means — always go through this script so the
restart is detached and survives the session drop.

## Rolling back to a build with fewer migrations

The fork's name-aware ledger reconcile (`persistence/reconcileMigrationLedger.ts`) **refuses
to start** when the ledger has migrations above the build's last id ("migrated by a newer or
foreign T3 Code build"). After a deploy that adds migrations, the previous build will not
start on the migrated `statev2.sqlite`. When such a deploy is planned, copy the database
first, for example with node:sqlite `backup()` to `~/backups/`. To roll back, stop the
service and either restore that copy, or delete the newer rows from `effect_sql_migrations`
before starting the older build. Do this only for migrations that just add columns, tables or
indexes. The 2026-10-13 sync added ids 60–62 (see `UPSTREAM_DIVERGENCE.md`).

## Rolling back across the orchestration-v2 cutover (v2 → v1 → v2)

A v1 build reads and writes only `state.sqlite`; a v2 build reads and writes only
`statev2.sqlite`. Neither carries the other's writes across, and the v2 seed never re-runs
once `statev2.sqlite` exists. So:

- **Rolling back to a v1 build** shows state as of the cutover — threads and messages created
  under v2 are not visible (they are still in `statev2.sqlite`, untouched).
- **Rolling forward to v2 again** silently reuses the now-stale `statev2.sqlite`; everything
  written to `state.sqlite` while the v1 build was serving is invisible.

There is no merge tool. Pick which side's writes to keep **before** rolling forward:

- **Keep the v1-period writes** (usual case after a rollback that served for a while): while
  the v1 build is still serving — it never opens `statev2.sqlite`, so this is safe live — move
  the v2 files aside, outside `userdata/` (a copy inside it gets swept into `--seed copy`
  test-deploys):
  ```bash
  mkdir -p ~/backups/t3-statev2-$(date +%F)
  mv ~/.t3/userdata/statev2.sqlite* ~/backups/t3-statev2-$(date +%F)/
  ```
  (No need to stop the import timer here: a v1 build's `t3 import sync` also only touches
  `state.sqlite`, and the redeploy pauses the timer itself — a timer you stopped by hand would
  be left stopped.) Then redeploy the v2 build; the new server re-seeds `statev2.sqlite` from the current
  `state.sqlite` at startup. Writes made under v2 _before_ the rollback stay only in the backup.
- **Keep the pre-rollback v2 writes:** just redeploy; the v1-period writes stay only in
  `state.sqlite`.

General rollback mechanics (force-push `main`, never `git revert -m 1`) are in
`docs/operations/rollback-2026-07-27-sync.md`.
