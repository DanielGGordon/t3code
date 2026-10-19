#!/usr/bin/env bash
# /redeploy — sync the T3 Code deploy checkout to a detached copy of origin/main,
# rebuild, and restart the prod service (t3code.service, public at https://t3.gordonlabs.dev).
#
# Run this from a T3 chat. The chat lives INSIDE t3code.service, so the chat's own
# session WILL drop when the service restarts. The restart is fired as a detached
# systemd unit so it completes regardless; results land in $STATUS_LOG.
#
#   redeploy.sh [--ignore-thread <id>]...
#
# ALWAYS waits until no T3 conversation has had a queued or running turn for
# T3_IDLE_SECS (default 120) before touching the checkout, and again before the restart
# (the build takes minutes). There is deliberately no way to skip this: a restart kills
# every running agent turn, and "/redeploy" never means "interrupt my other threads".
# The chat running this script is excluded automatically when it lives in a git
# worktree; otherwise pass its id with --ignore-thread (also releases a known zombie).
# Once the new server answers, every connected client gets a notice.
set -euo pipefail

IGNORE_THREADS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --when-idle) ;; # accepted for old callers; waiting for idle is no longer optional
    --ignore-thread)
      [ $# -ge 2 ] || { echo "redeploy: --ignore-thread needs a thread id" >&2; exit 2; }
      IGNORE_THREADS+=("$2")
      shift
      ;;
    *) echo "redeploy: unknown argument '$1' (usage: redeploy.sh [--ignore-thread <id>]...)" >&2; exit 2 ;;
  esac
  shift
done

DEPLOY_DIR="${T3_DEPLOY_DIR:-/home/dgordon/projects/meta/t3code-v2}"
SERVICE="${T3_SERVICE:-t3code.service}"
LOOPBACK_URL="${T3_HEALTH_URL:-http://127.0.0.1:3773/}"
PUBLIC_URL="${T3_PUBLIC_URL:-https://t3.gordonlabs.dev/}"
STATUS_LOG="${T3_REDEPLOY_LOG:-/tmp/t3-redeploy-status.log}"
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
trap resume_import_timer EXIT
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

wait_until_idle "before checkout"

PREV_HEAD="$(git -C "$DEPLOY_DIR" rev-parse HEAD)"
if systemctl --user cat "$IMPORT_TIMER" >/dev/null 2>&1 &&
  systemctl --user is-active --quiet "$IMPORT_TIMER"; then
  echo "==> Pausing $IMPORT_TIMER until the new server is up"
  TIMER_PAUSED=1
  systemctl --user stop "$IMPORT_TIMER"
else
  echo "==> $IMPORT_TIMER not active — leaving it as is"
fi
# Stopping the timer does not stop a run already in flight; wait it out.
waited=0
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

echo "==> Fetching origin and syncing $DEPLOY_DIR to a copy of origin/main"
git -C "$DEPLOY_DIR" fetch origin --quiet
TARGET_SHORT="$(git -C "$DEPLOY_DIR" rev-parse --short origin/main)"
TARGET_SUBJ="$(git -C "$DEPLOY_DIR" log -1 --format='%s' origin/main)"
git -C "$DEPLOY_DIR" checkout --detach --force origin/main
# Drop the throwaway 'deploy' label if it lingers — the deploy dir is now just a
# detached snapshot of origin/main, so there is no mystery branch to reason about.
git -C "$DEPLOY_DIR" branch -D deploy >/dev/null 2>&1 || true
echo "    now at $TARGET_SHORT — $TARGET_SUBJ"

echo "==> Installing dependencies"
( cd "$DEPLOY_DIR" && pnpm install --prefer-offline )

echo "==> Building web bundle"
# Prod runs the server from source and serves apps/web/dist, so only the web
# bundle is needed (same as test-deploy). The root `pnpm build` also builds the
# Electron desktop app, which needs libsecret headers this headless box lacks.
( cd "$DEPLOY_DIR" && pnpm --filter @t3tools/web build )

# The build takes minutes, so conversations may have started since the first gate.
wait_until_idle "before restart"

echo "==> Build OK. Firing detached restart of $SERVICE"
echo "    (this chat's session will drop when the server restarts)"
UNIT="t3-redeploy-$(date +%s)"
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
  resume_timer
  {
    echo \"redeploy \$(date -Is)\"
    echo \"target=$TARGET_SHORT ($TARGET_SUBJ)\"
    echo \"service-active=\$(systemctl --user is-active $SERVICE)\"
    echo \"loopback-3773=\$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' '$LOOPBACK_URL' 2>/dev/null)\"
    echo \"public=\$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}' '$PUBLIC_URL' 2>/dev/null)\"
    echo \"notice=\$notice\"
    echo \"served-commit=\$(git -C '$DEPLOY_DIR' rev-parse --short HEAD)\"
    echo \"import-timer=\$(systemctl --user is-active '$IMPORT_TIMER' 2>/dev/null) (paused-by-redeploy=$TIMER_PAUSED)\"
  } > '$STATUS_LOG' 2>&1
"
HANDED_OFF=1

echo
echo "Redeploy launched for $TARGET_SHORT ($TARGET_SUBJ)."
echo "The service restarts in ~2s; this chat will disconnect."
echo "Reconnect, then verify with:  cat $STATUS_LOG"
