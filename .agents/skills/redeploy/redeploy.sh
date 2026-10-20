#!/usr/bin/env bash
# /redeploy — sync the T3 Code deploy checkout to a detached copy of origin/main,
# rebuild, and restart the prod service (t3code.service, public at https://t3.gordonlabs.dev).
#
# Run this from a T3 chat. The chat lives INSIDE t3code.service, so the chat's own
# session WILL drop when the service restarts. The restart is fired as a detached
# systemd unit so it completes regardless; results land in $STATUS_LOG.
#
#   redeploy.sh [--ignore-thread <id>]... [--force]
#   redeploy.sh --interrupt-running [--force]     (the /force-redeploy skill only)
#   redeploy.sh --status
#
# Only one redeploy runs at a time, and a second request never starts a second one:
#   * another redeploy is waiting/building -> this call JOINS it and exits 0 at once.
#     The running deploy re-fetches origin/main right before it restarts (and rebuilds if
#     it moved), so it carries whatever the joiner merged. Everyone gets the "T3 was updated"
#     notice afterwards, and `--status` reports the outcome.
#   * origin/main is already what is deployed and serving -> nothing to do (`--force` overrides).
#   * the restart is already in flight -> nothing to do if it is for origin/main, else re-run later.
#
# ALWAYS waits until no T3 conversation has had a queued or running turn for
# T3_IDLE_SECS (default 120) before touching the checkout, and again before the restart
# (the build takes minutes). There is deliberately no way to skip this: a restart kills
# every running agent turn, and "/redeploy" never means "interrupt my other threads".
# The chat running this script is excluded automatically when it lives in a git
# worktree; otherwise pass its id with --ignore-thread (also releases a known zombie).
# Once the new server answers, every connected client gets a notice.
#
# The one exception is --interrupt-running, used only by the /force-redeploy skill when the user
# explicitly asks to restart regardless of running threads: both idle gates are skipped, the threads
# that were working at the moment of the restart are recorded, and once the new server answers each
# gets a queued message saying why it was cut off. A /force-redeploy that finds a /redeploy already
# waiting for idle does not join it quietly: it drops $STATE_DIR/interrupt, which that waiting
# deploy sees on its next poll and stops waiting.
set -euo pipefail

IGNORE_THREADS=()
FORCE=0
INTERRUPT=0
SHOW_STATUS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --when-idle) ;; # accepted for old callers; waiting for idle is no longer optional
    --force) FORCE=1 ;;
    --interrupt-running) INTERRUPT=1 ;;
    --status) SHOW_STATUS=1 ;;
    --ignore-thread)
      [ $# -ge 2 ] || { echo "redeploy: --ignore-thread needs a thread id" >&2; exit 2; }
      IGNORE_THREADS+=("$2")
      shift
      ;;
    *) echo "redeploy: unknown argument '$1' (usage: redeploy.sh [--ignore-thread <id>]... [--force] [--interrupt-running] | --status)" >&2; exit 2 ;;
  esac
  shift
done

DEPLOY_DIR="${T3_DEPLOY_DIR:-/home/dgordon/projects/meta/t3code-v2}"
SERVICE="${T3_SERVICE:-t3code.service}"
LOOPBACK_URL="${T3_HEALTH_URL:-http://127.0.0.1:3773/}"
PUBLIC_URL="${T3_PUBLIC_URL:-https://t3.gordonlabs.dev/}"
STATUS_LOG="${T3_REDEPLOY_LOG:-/tmp/t3-redeploy-status.log}"
# Coordination between concurrent /redeploy calls: a lock held for as long as a deploy is
# in progress, the deploy's phase (read by joiners), the commit last deployed, and who joined.
STATE_DIR="${T3_REDEPLOY_STATE_DIR:-/tmp/t3-redeploy}"
LOCK_FILE="$STATE_DIR/lock"
STATE_FILE="$STATE_DIR/state"
DEPLOYED_FILE="$STATE_DIR/deployed"
JOINERS_FILE="$STATE_DIR/joiners"
INTERRUPT_FILE="$STATE_DIR/interrupt"
MAX_SYNC_ROUNDS="${T3_REDEPLOY_MAX_SYNC_ROUNDS:-3}"
# The 15-minute Claude transcript import runs `t3 import sync` from THIS checkout.
# It must not run between the checkout below and the server restart: it would be
# running new CLI code against the DB the old server is still writing (on the
# orchestration-v2 cutover that used to snapshot state.sqlite -> statev2.sqlite
# early and silently lose everything the old server wrote afterwards).
IMPORT_TIMER="${T3_IMPORT_TIMER:-t3-claude-import.timer}"
IMPORT_SERVICE="${T3_IMPORT_SERVICE:-t3-claude-import.service}"
IMPORT_WAIT_SECS="${T3_IMPORT_WAIT_SECS:-900}"
# Idle gate (always on): how long the server must be quiet, how long to wait for that in each
# of the two gates (before the checkout, and again right before the restart), and
# where the state lives. T3_BASE_DIR must match the deployed server's --base-dir.
IDLE_SECS="${T3_IDLE_SECS:-120}"
IDLE_MAX_WAIT_SECS="${T3_IDLE_MAX_WAIT_SECS:-7200}"
IDLE_POLL_SECS="${T3_IDLE_POLL_SECS:-5}"
T3_BASE_DIR="${T3_BASE_DIR:-$HOME/.t3}"
MISE_BIN="${T3_MISE_BIN:-$HOME/.local/bin/mise}"
# The repo this script runs from (an agent worktree, usually), not the deploy dir:
# it carries the idle checker and names the chat that is running the deploy.
SKILL_REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
CALLER_TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || true)"

# --- guard: only run on the actual deploy host ---
if [ ! -e "$DEPLOY_DIR/.git" ]; then
  echo "redeploy: deploy dir '$DEPLOY_DIR' not found — this is not the T3 deploy host. Aborting." >&2
  exit 1
fi
if ! systemctl --user cat "$SERVICE" >/dev/null 2>&1; then
  echo "redeploy: user service '$SERVICE' not found — this is not the T3 deploy host. Aborting." >&2
  exit 1
fi

export PATH="$HOME/.local/share/mise/shims:$DEPLOY_DIR/node_modules/.bin:$PATH"
export CI=true

# --- coordination with other /redeploy calls ---
mkdir -p "$STATE_DIR"
REQUESTER="${CALLER_TOPLEVEL:-unknown checkout} ($(git branch --show-current 2>/dev/null || true))"
HOLDS_LOCK=0
ST_TARGET=""
ST_UNIT=""

# The deploy's phase, for joiners and --status. Only the lock holder writes it.
write_state() {
  {
    echo "phase=$1"
    echo "holder=$REQUESTER"
    echo "pid=$$"
    echo "target=$ST_TARGET"
    echo "unit=$ST_UNIT"
    echo "since=$(date -Is)"
  } >"$STATE_FILE.$$" && mv -f "$STATE_FILE.$$" "$STATE_FILE"
}
state_get() { sed -n "s/^$1=//p" "$STATE_FILE" 2>/dev/null | head -n 1 || true; }

# What origin/main is right now, without touching the deploy checkout. Empty if unreachable.
REMOTE_MAIN="$(git -C "$DEPLOY_DIR" ls-remote origin refs/heads/main 2>/dev/null | cut -f1 || true)"
deployed_sha() { cat "$DEPLOYED_FILE" 2>/dev/null || true; }
lock_is_held() { ( flock -n 8 ) 8>"$LOCK_FILE" 2>/dev/null && return 1 || return 0; }

if [ "$SHOW_STATUS" = 1 ]; then
  if lock_is_held; then
    echo "deploy: IN PROGRESS — phase=$(state_get phase), started by $(state_get holder), since $(state_get since)"
  else
    echo "deploy: none in progress (last phase: $(state_get phase))"
  fi
  echo "deployed:    $(deployed_sha | cut -c1-10)"
  echo "origin/main: $(printf '%s' "$REMOTE_MAIN" | cut -c1-10)"
  if [ -n "$REMOTE_MAIN" ] && [ "$REMOTE_MAIN" = "$(deployed_sha)" ]; then
    echo "up to date — what origin/main points at is what was last deployed"
  else
    echo "origin/main is not what was last deployed — a redeploy is still needed"
  fi
  [ -r "$STATUS_LOG" ] && { echo "--- $STATUS_LOG"; cat "$STATUS_LOG"; }
  exit 0
fi

# A deploy is already waiting or building: join it instead of deploying a second time.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  printf '%s\t%s\t%s\n' "$(date -Is)" "$REQUESTER" "$REMOTE_MAIN" >>"$JOINERS_FILE"
  if [ "$INTERRUPT" = 1 ]; then
    printf '%s\n' "$REQUESTER" >"$INTERRUPT_FILE"
    echo "redeploy: another redeploy is already pending (phase: $(state_get phase), started by $(state_get holder))."
    echo "  --interrupt-running: told it to stop waiting for other threads. It restarts without the idle"
    echo "  wait (re-fetching origin/main first) and nudges every thread it cuts off. Check on it with:"
    echo "    bash \"$0\" --status"
    exit 0
  fi
  echo "redeploy: another redeploy is already pending (phase: $(state_get phase), started by $(state_get holder))."
  echo "  Not starting a second one. It re-fetches origin/main right before it restarts and rebuilds if"
  echo "  that moved, so it will carry origin/main as of your call (${REMOTE_MAIN:0:10})."
  echo "  It waits for every other thread to be idle first. When it finishes, every connected client"
  echo "  gets a \"T3 was updated and restarted\" notice; check on it any time with:"
  echo "    bash \"$0\" --status"
  exit 0
fi

# Lock is ours. A restart handed off by the previous deploy may still be in flight.
if [ "$(state_get phase)" = restarting ] && [ -n "$(state_get unit)" ] &&
  systemctl --user is-active --quiet "$(state_get unit)"; then
  if [ -n "$REMOTE_MAIN" ] && [ "$REMOTE_MAIN" = "$(state_get target)" ]; then
    echo "redeploy: the restart into origin/main (${REMOTE_MAIN:0:10}) is already in flight — nothing to do."
    echo "  Reconnect in a moment; verify with: bash \"$0\" --status"
    exit 0
  fi
  echo "redeploy: a restart into $(state_get target | cut -c1-10) is in flight, but origin/main has moved on" >&2
  echo "  (${REMOTE_MAIN:0:10}). Re-run /redeploy once it has finished (bash \"$0\" --status)." >&2
  exit 3
fi
if [ "$FORCE" = 0 ] && [ -n "$REMOTE_MAIN" ] && [ "$REMOTE_MAIN" = "$(deployed_sha)" ] &&
  [ "$(git -C "$DEPLOY_DIR" rev-parse HEAD 2>/dev/null)" = "$REMOTE_MAIN" ] &&
  systemctl --user is-active --quiet "$SERVICE"; then
  echo "redeploy: origin/main (${REMOTE_MAIN:0:10}) is already deployed and serving — nothing to do. (--force to redeploy anyway)"
  exit 0
fi
HOLDS_LOCK=1
: >"$JOINERS_FILE"
# A leftover from a deploy that was killed hard must not make this one skip the idle wait.
rm -f "$INTERRUPT_FILE"

# --- pause the import timer for the whole checkout -> restart window ---
# TIMER_PAUSED: we stopped a timer that was running, so we owe a restart of it.
# HANDED_OFF:   the detached restart unit now owns re-enabling it (after the
#               server is back), so this script's own exit must not do it early.
TIMER_PAUSED=0
HANDED_OFF=0
resume_import_timer() {
  if [ "$TIMER_PAUSED" = 1 ] && [ "$HANDED_OFF" = 0 ]; then
    echo "==> Re-enabling $IMPORT_TIMER (redeploy did not reach the restart)" >&2
    if [ "$(git -C "$DEPLOY_DIR" rev-parse HEAD 2>/dev/null)" != "${PREV_HEAD:-}" ]; then
      echo "    NOTE: $DEPLOY_DIR is already checked out at the new commit while the OLD" >&2
      echo "    server is still running; imports run the new CLI until a redeploy succeeds." >&2
    fi
    systemctl --user start "$IMPORT_TIMER" ||
      echo "redeploy: WARNING — failed to restart $IMPORT_TIMER; run: systemctl --user start $IMPORT_TIMER" >&2
  fi
}
# A deploy that stops before handing off the restart leaves its phase as "ended", so --status
# does not report a dead deploy as in progress (the lock itself frees when the process exits).
on_exit() {
  local rc=$?
  [ "$HOLDS_LOCK" = 1 ] && rm -f "$INTERRUPT_FILE"
  resume_import_timer
  if [ "$HOLDS_LOCK" = 1 ] && [ "$HANDED_OFF" = 0 ]; then
    write_state "ended (exit $rc, nothing was restarted)" || true
  fi
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Block until no conversation has been working for IDLE_SECS in a row. Any busy poll
# restarts the clock. Aborts (exit 1) after IDLE_MAX_WAIT_SECS so a stuck run cannot
# hold a deploy forever; --ignore-thread <id> releases a run you know is a zombie.
wait_until_idle() {
  local label="$1" args=() id start now quiet_since="" last_report="" out rc
  for id in "${IGNORE_THREADS[@]}"; do args+=(--ignore-thread "$id"); done
  if [ -n "$CALLER_TOPLEVEL" ] && [ "$CALLER_TOPLEVEL" != "$DEPLOY_DIR" ]; then
    args+=(--ignore-worktree "$CALLER_TOPLEVEL")
  fi
  start="$(date +%s)"
  echo "==> Waiting for T3 to be idle for ${IDLE_SECS}s ($label)"
  while :; do
    if [ "$INTERRUPT" = 1 ] || [ -e "$INTERRUPT_FILE" ]; then
      INTERRUPT=1
      echo "    interrupt requested — not waiting for running threads ($label)"
      return 0
    fi
    rc=0
    out="$("$MISE_BIN" exec node@24 -- node "$SKILL_REPO/scripts/deploy-idle-check.ts" \
      --base-dir "$T3_BASE_DIR" "${args[@]}")" || rc=$?
    now="$(date +%s)"
    case "$rc" in
      0)
        [ -n "$quiet_since" ] || { quiet_since="$now"; echo "    idle — confirming for ${IDLE_SECS}s"; }
        if [ $((now - quiet_since)) -ge "$IDLE_SECS" ]; then
          echo "    idle for ${IDLE_SECS}s — proceeding"
          return 0
        fi
        ;;
      1)
        if [ -n "$quiet_since" ]; then echo "    activity resumed — restarting the ${IDLE_SECS}s clock"; fi
        quiet_since=""
        if [ "$out" != "$last_report" ]; then
          echo "    busy:"
          printf '      %s\n' "$out"
          last_report="$out"
        fi
        ;;
      *)
        echo "redeploy: could not read T3 state to check for activity (idle check exit $rc) — aborting." >&2
        exit 1
        ;;
    esac
    if [ $((now - start)) -ge "$IDLE_MAX_WAIT_SECS" ]; then
      echo "redeploy: T3 was not idle for ${IDLE_SECS}s within ${IDLE_MAX_WAIT_SECS}s ($label) — aborting; nothing was restarted." >&2
      exit 1
    fi
    sleep "$IDLE_POLL_SECS"
  done
}

PREV_HEAD="$(git -C "$DEPLOY_DIR" rev-parse HEAD)"

# Pause the import timer (once) and let an in-flight import run finish, before the checkout moves.
IMPORT_PAUSE_DONE=0
pause_import_timer() {
  [ "$IMPORT_PAUSE_DONE" = 0 ] || return 0
  IMPORT_PAUSE_DONE=1
  if systemctl --user cat "$IMPORT_TIMER" >/dev/null 2>&1 &&
    systemctl --user is-active --quiet "$IMPORT_TIMER"; then
    echo "==> Pausing $IMPORT_TIMER until the new server is up"
    TIMER_PAUSED=1
    systemctl --user stop "$IMPORT_TIMER"
  else
    echo "==> $IMPORT_TIMER not active — leaving it as is"
  fi
  # Stopping the timer does not stop a run already in flight; wait it out.
  local waited=0 state
  while :; do
    state="$(systemctl --user is-active "$IMPORT_SERVICE" 2>/dev/null || true)"
    case "$state" in
      active | activating | deactivating | reloading) ;;
      *) break ;;
    esac
    if [ "$waited" -ge "$IMPORT_WAIT_SECS" ]; then
      echo "redeploy: $IMPORT_SERVICE still running after ${IMPORT_WAIT_SECS}s — aborting before checkout." >&2
      exit 1
    fi
    [ "$waited" = 0 ] && echo "    waiting for the in-flight $IMPORT_SERVICE run to finish…"
    sleep 5
    waited=$((waited + 5))
  done
}

# Other /redeploy calls join this deploy rather than starting their own (see the header), so
# it must deliver whatever lands on origin/main until the very moment of the restart: after
# the pre-restart idle gate, re-fetch and, if origin/main moved, sync and build again.
round=0
while :; do
  round=$((round + 1))
  write_state waiting
  wait_until_idle "before checkout"
  pause_import_timer

  write_state building
  echo "==> Fetching origin and syncing $DEPLOY_DIR to a copy of origin/main"
  git -C "$DEPLOY_DIR" fetch origin --quiet
  TARGET_FULL="$(git -C "$DEPLOY_DIR" rev-parse origin/main)"
  TARGET_SHORT="$(git -C "$DEPLOY_DIR" rev-parse --short origin/main)"
  TARGET_SUBJ="$(git -C "$DEPLOY_DIR" log -1 --format='%s' origin/main)"
  ST_TARGET="$TARGET_FULL"
  git -C "$DEPLOY_DIR" checkout --detach --force origin/main
  # Drop the throwaway 'deploy' label if it lingers — the deploy dir is now just a
  # detached snapshot of origin/main, so there is no mystery branch to reason about.
  git -C "$DEPLOY_DIR" branch -D deploy >/dev/null 2>&1 || true
  echo "    now at $TARGET_SHORT — $TARGET_SUBJ"

  echo "==> Installing dependencies"
  ( cd "$DEPLOY_DIR" && pnpm install --prefer-offline 9>&- )

  echo "==> Building web bundle"
  # Prod runs the server from source and serves apps/web/dist, so only the web
  # bundle is needed (same as test-deploy). The root `pnpm build` also builds the
  # Electron desktop app, which needs libsecret headers this headless box lacks.
  ( cd "$DEPLOY_DIR" && pnpm --filter @t3tools/web build 9>&- )

  # The build takes minutes, so conversations may have started since the first gate.
  write_state waiting-for-restart
  wait_until_idle "before restart"

  git -C "$DEPLOY_DIR" fetch origin --quiet
  LATEST_FULL="$(git -C "$DEPLOY_DIR" rev-parse origin/main)"
  [ "$LATEST_FULL" = "$TARGET_FULL" ] && break
  if [ "$round" -ge "$MAX_SYNC_ROUNDS" ]; then
    echo "==> origin/main moved again (${LATEST_FULL:0:10}) but this is round $round — deploying $TARGET_SHORT; run /redeploy again for the rest"
    break
  fi
  echo "==> origin/main moved to ${LATEST_FULL:0:10} while $TARGET_SHORT was building — syncing again"
done

if [ -s "$JOINERS_FILE" ]; then
  echo "==> Also requested while this deploy was pending (all covered by it):"
  cut -f2 "$JOINERS_FILE" | sort -u | sed 's/^/    /'
fi

# Who the restart is about to cut off, read at the last moment (the build took minutes). The
# running thread that launched this is included on purpose: its turn dies too and needs the nudge.
NUDGE_IDS=()
if [ "$INTERRUPT" = 1 ]; then
  nudge_out="$("$MISE_BIN" exec node@24 -- node "$SKILL_REPO/scripts/deploy-idle-check.ts" \
    --base-dir "$T3_BASE_DIR" || true)"
  while read -r _ thread_id _; do
    [ -n "$thread_id" ] && NUDGE_IDS+=("$thread_id")
  done <<<"$nudge_out"
  if [ "${#NUDGE_IDS[@]}" -gt 0 ]; then
    echo "==> Interrupting ${#NUDGE_IDS[@]} running thread(s); they get a message after the restart:"
    printf '%s\n' "$nudge_out" | sed 's/^busy /    /'
  else
    echo "==> --interrupt-running, but no thread was running — nothing to nudge"
  fi
fi
rm -f "$INTERRUPT_FILE"

echo "==> Build OK. Firing detached restart of $SERVICE"
echo "    (this chat's session will drop when the server restarts)"
UNIT="t3-redeploy-$(date +%s)"
# No single quotes: it is spliced into a single-quoted argument of the unit's script below.
NUDGE_MESSAGE="Sorry, another thread had to reboot T3 and this conversation may have been interrupted. Please continue where you left off."
ST_UNIT="$UNIT"
write_state restarting
# The detached unit re-enables the import timer only once the restart has been
# attempted and the health wait is over (the new server performs any one-shot DB
# migration, e.g. the v2 seed, before it answers on loopback). Its own EXIT trap
# re-enables it even if something in the unit fails.
systemd-run --user --collect --unit="$UNIT" bash -c "
  resume_timer() { [ '$TIMER_PAUSED' = 1 ] && systemctl --user start '$IMPORT_TIMER'; true; }
  trap resume_timer EXIT
  sleep 2
  systemctl --user restart $SERVICE
  for i in \$(seq 1 40); do
    code=\$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' '$LOOPBACK_URL' 2>/dev/null || echo 000)
    [ \"\$code\" = '200' ] && break
    sleep 1
  done
  # Tell every client that reconnects. Done from the NEW build against the NEW server:
  # a CLI run from the new checkout before the restart could migrate the database the
  # old server is still using. Best effort: a failed health wait or notice never blocks.
  notice=skipped
  if [ \"\$code\" = '200' ]; then
    if ( cd '$DEPLOY_DIR/apps/server' && '$MISE_BIN' exec node@24 -- node src/bin.ts notice 'T3 was updated and restarted (now at $TARGET_SHORT).' --base-dir '$T3_BASE_DIR' ) >/dev/null 2>&1; then notice=published; else notice=failed; fi
  fi
  nudged=none
  if [ \"\$code\" = '200' ] && [ -n '${NUDGE_IDS[*]:-}' ]; then
    if ( cd '$DEPLOY_DIR/apps/server' && '$MISE_BIN' exec node@24 -- node src/bin.ts nudge --id '$UNIT' --message '$NUDGE_MESSAGE' --base-dir '$T3_BASE_DIR' ${NUDGE_IDS[*]:-} ) >/tmp/t3-redeploy-nudge.log 2>&1; then nudged=sent; else nudged=failed; fi
  fi
  resume_timer
  [ \"\$code\" = '200' ] && git -C '$DEPLOY_DIR' rev-parse HEAD > '$DEPLOYED_FILE'
  {
    echo \"redeploy \$(date -Is)\"
    echo \"target=$TARGET_SHORT ($TARGET_SUBJ)\"
    echo \"service-active=\$(systemctl --user is-active $SERVICE)\"
    echo \"loopback-3773=\$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' '$LOOPBACK_URL' 2>/dev/null)\"
    echo \"public=\$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}' '$PUBLIC_URL' 2>/dev/null)\"
    echo \"notice=\$notice\"
    echo \"nudged=\$nudged (${#NUDGE_IDS[@]} thread(s); details in /tmp/t3-redeploy-nudge.log)\"
    echo \"served-commit=\$(git -C '$DEPLOY_DIR' rev-parse --short HEAD)\"
    echo \"import-timer=\$(systemctl --user is-active '$IMPORT_TIMER' 2>/dev/null) (paused-by-redeploy=$TIMER_PAUSED)\"
  } > '$STATUS_LOG' 2>&1
"
HANDED_OFF=1

echo
echo "Redeploy launched for $TARGET_SHORT ($TARGET_SUBJ)."
echo "The service restarts in ~2s; this chat will disconnect."
echo "Reconnect, then verify with:  cat $STATUS_LOG"
