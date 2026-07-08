#!/usr/bin/env bash
# Publish the sideloadable Android APK to the self-hosted download route
# (Caddy serves /var/lib/t3code-apk at https://15.204.108.12:7443/downloads/).
# The previous build is kept alongside as *.previous.apk for rollback.
#
# Usage: publish-android-apk.sh [apk-path]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APK="${1:-$SCRIPT_DIR/../android/app/build/outputs/apk/release/app-release.apk}"
HOST="${T3_APK_HOST:-dgordon@15.204.108.12}"
DST_DIR="${T3_APK_DST:-/var/lib/t3code-apk}"
NAME="${T3_APK_NAME:-t3code-android-preview.apk}"

if [ ! -f "$APK" ]; then
  echo "APK not found: $APK" >&2
  echo "Build it first: cd apps/mobile && APP_VARIANT=preview EXPO_NO_GIT_STATUS=1 npx expo prebuild --clean --platform android && (cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a)" >&2
  exit 1
fi

ssh "$HOST" "cd '$DST_DIR' && if [ -f '$NAME' ]; then cp -f '$NAME' '${NAME%.apk}.previous.apk'; fi"
scp "$APK" "$HOST:$DST_DIR/$NAME"

echo "Published: https://15.204.108.12:7443/downloads/$NAME"
