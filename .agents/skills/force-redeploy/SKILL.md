---
name: force-redeploy
description: Redeploy this self-hosted T3 Code prod server (https://t3.gordonlabs.dev) to the latest origin/main RIGHT NOW, even while other threads are running, then nudge every thread that was cut off to continue. Interrupts running work. Use ONLY when the user explicitly says "/force-redeploy", "force redeploy", or clearly tells you to restart T3 without waiting for other threads. Never pick this on your own instead of /redeploy. Only runs on the T3 deploy host.
---

# Force-redeploy T3 Code (prod)

Same deploy as `/redeploy` (sync `~/projects/meta/t3code-v2` to `origin/main`, install, build web,
detached restart of `t3code.service`), except it **does not wait for other threads to go idle**.
Every thread with a running or queued turn (or a running subagent) at the moment of the restart is
cut off, so afterwards each of them is nudged:

> Sorry, another thread had to reboot T3 and this conversation may have been interrupted. Please
> continue where you left off.

The logic is `redeploy.sh --interrupt-running` in `../redeploy/`; see the `redeploy` skill for the
checkout, import-timer pause, lock and rollback details, which are all unchanged.

## When to use it

- **Only on the user's explicit request** ("force redeploy", "restart T3 now, I don't care about the
  other chats"). `/redeploy` is the default and waits for idle; do not escalate to this because the
  wait is long or the threads "look done". If the user just said "redeploy", run `/redeploy`.
- The user's request is the authorization: do not ask again, but do tell them up front which threads
  will be cut off (step 1).

## How to run

1. See who will be interrupted (read-only):
   ```bash
   node "$(git rev-parse --show-toplevel)/scripts/deploy-idle-check.ts" --base-dir ~/.t3
   ```
   It prints one `busy <threadId> <status> "<title>"` line per working thread, including this chat.
   Mention them to the user in one line; no output means nothing will be cut off.
2. Run it in the background (`run_in_background: true`; install + build take a few minutes):
   ```bash
   bash "$(git rev-parse --show-toplevel)/.claude/skills/redeploy/redeploy.sh" --interrupt-running
   ```
3. Tell the user the connection will drop when the server restarts (this chat runs inside
   `t3code.service` and is itself nudged afterwards), and that after reconnecting they can verify with
   `cat /tmp/t3-redeploy-status.log`. A healthy result has the usual `service-active=active`,
   `loopback-3773=200`, `public=200`, `notice=published`, `served-commit` matching the target, plus
   `nudged=sent (N thread(s))`. Per-thread results are in `/tmp/t3-redeploy-nudge.log`
   (`nudged <id>` / `FAILED <id> <reason>`).

If it prints "nothing to do", `origin/main` is already what is serving: nothing was restarted and no
thread was cut off. (`--force` redeploys anyway; only add it if the user wants a restart of the same
commit.)

## How it behaves

- **Idle gates skipped, snapshot taken at the end.** The running threads are read right before the
  restart (the build takes minutes), so only threads still working then are nudged. Threads waiting
  on a person's approval or answer are not busy, survive a restart, and get no nudge.
- **A `/redeploy` already waiting for idle is released, not duplicated.** The force call drops a flag
  the waiting deploy sees on its next poll; it stops waiting and restarts, doing the nudge too.
  Running `/force-redeploy` while another deploy is already building simply upgrades it the same way.
- **The nudge is a queued system message** (`t3 nudge`, `POST /api/fork/thread/nudge`), sent from the
  new build once the new server answers, so it never interrupts a turn. T3's own "continue after server
  update" feature (on by default) may already resume an interrupted turn with "Continue where you left
  off."; the nudge then follows as a second queued message that explains why. Both are harmless.
- **Best effort.** A thread that cannot take the message (archived, deleted) shows as `FAILED` in the
  nudge log and never fails the deploy.
- Never restart `t3code.service` any other way: the script's detached unit is what survives the
  session drop.
