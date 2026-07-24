#!/usr/bin/env bash
# /token — issue a fresh pairing token for the T3 Code prod server
# (t3code.service, fronted by Caddy on 15.204.108.12:7443) without restarting
# anything. Writes a token directly into the running server's live database.
set -euo pipefail

DEPLOY_DIR="${T3_DEPLOY_DIR:-/home/dgordon/projects/meta/t3code-v2}"
SERVICE="${T3_SERVICE:-t3code.service}"
BASE_DIR="${T3_BASE_DIR:-$HOME/.t3}"
SERVER_PORT="${T3_SERVER_PORT:-3773}"
PUBLIC_URL="${T3_PUBLIC_URL:-https://15.204.108.12:7443}"
TTL="${1:-15m}"

# --- guard: only run on the actual T3 deploy/prod host ---
if [ ! -e "$DEPLOY_DIR/.git" ]; then
  echo "token: deploy dir '$DEPLOY_DIR' not found — this is not the T3 deploy host. Aborting." >&2
  exit 1
fi
if ! systemctl --user cat "$SERVICE" >/dev/null 2>&1; then
  echo "token: user service '$SERVICE' not found — this is not the T3 deploy host. Aborting." >&2
  exit 1
fi
if [ ! -d "$BASE_DIR/userdata" ]; then
  echo "token: base dir '$BASE_DIR' has no userdata/ — does not look like the live prod state dir. Aborting." >&2
  exit 1
fi

export PATH="$HOME/.local/share/mise/shims:$DEPLOY_DIR/node_modules/.bin:$PATH"

RESULT="$(cd "$DEPLOY_DIR" && T3CODE_PORT="$SERVER_PORT" node apps/server/src/bin.ts auth pairing create \
  --base-dir "$BASE_DIR" \
  --base-url "$PUBLIC_URL" \
  --ttl "$TTL" \
  --label "manual-login-$(date +%Y%m%d-%H%M%S)" \
  --json)"

PAIR_URL="$(echo "$RESULT" | jq -r '.pairUrl')"
EXPIRES_AT="$(echo "$RESULT" | jq -r '.expiresAt')"

echo "Pair URL (single-use, expires $EXPIRES_AT):"
echo "$PAIR_URL"
