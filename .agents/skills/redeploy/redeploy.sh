#!/usr/bin/env bash
# /redeploy — sync the T3 Code deploy checkout to a detached copy of origin/main,
# rebuild, and restart the prod service (t3code.service, fronted by Caddy on :7443).
#
# Run this from a T3 chat. The chat lives INSIDE t3code.service, so the chat's own
# session WILL drop when the service restarts. The restart is fired as a detached
# systemd unit so it completes regardless; results land in $STATUS_LOG.
set -euo pipefail

DEPLOY_DIR="${T3_DEPLOY_DIR:-/home/dgordon/projects/meta/t3code-v2}"
SERVICE="${T3_SERVICE:-t3code.service}"
LOOPBACK_URL="${T3_HEALTH_URL:-http://127.0.0.1:3773/}"
PUBLIC_URL="${T3_PUBLIC_URL:-https://15.204.108.12:7443/}"
STATUS_LOG="${T3_REDEPLOY_LOG:-/tmp/t3-redeploy-status.log}"
# The 15-minute Claude transcript import runs `t3 import sync` from THIS checkout.
# It must not run between the checkout below and the server restart: it would be
# running new CLI code against the DB the old server is still writing (on the
# orchestration-v2 cutover that used to snapshot state.sqlite -> statev2.sqlite
# early and silently lose everything the old server wrote afterwards).
IMPORT_TIMER="${T3_IMPORT_TIMER:-t3-claude-import.timer}"
IMPORT_SERVICE="${T3_IMPORT_SERVICE:-t3-claude-import.service}"
IMPORT_WAIT_SECS="${T3_IMPORT_WAIT_SECS:-900}"

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
    code=\$(curl -s -o /dev/null -w '%{http_code}' '$LOOPBACK_URL' 2>/dev/null || echo 000)
    [ \"\$code\" = '200' ] && break
    sleep 1
  done
  resume_timer
  {
    echo \"redeploy \$(date -Is)\"
    echo \"target=$TARGET_SHORT ($TARGET_SUBJ)\"
    echo \"service-active=\$(systemctl --user is-active $SERVICE)\"
    echo \"loopback-3773=\$(curl -s -o /dev/null -w '%{http_code}' '$LOOPBACK_URL' 2>/dev/null)\"
    echo \"public-7443=\$(curl -sk -o /dev/null -w '%{http_code}' '$PUBLIC_URL' 2>/dev/null)\"
    echo \"served-commit=\$(git -C '$DEPLOY_DIR' rev-parse --short HEAD)\"
    echo \"import-timer=\$(systemctl --user is-active '$IMPORT_TIMER' 2>/dev/null) (paused-by-redeploy=$TIMER_PAUSED)\"
  } > '$STATUS_LOG' 2>&1
"
HANDED_OFF=1

echo
echo "Redeploy launched for $TARGET_SHORT ($TARGET_SUBJ)."
echo "The service restarts in ~2s; this chat will disconnect."
echo "Reconnect, then verify with:  cat $STATUS_LOG"
