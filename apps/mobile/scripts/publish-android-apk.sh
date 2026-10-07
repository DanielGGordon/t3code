#!/usr/bin/env bash
# Build the sideloadable `preview` Android APK and publish it through android-sideload
# (slot `t3code`, com.t3tools.t3code.preview). Phones update via Settings > About >
# "Check for updates"; first installs come from https://15.204.108.12:7443/sideload/.
#
# Usage: publish-android-apk.sh "what changed"
# Env:
#   SKIP_BUILD=1        publish the APK already at $APK (default: android/app/build/outputs/apk/release/app-release.apk)
#   APK=<path>          APK to publish
#   SIDELOAD_DIR=<dir>  publish to a scratch dir instead of /var/lib/sideload-apk (testing)
#   BUILD_ONLY=1        build (and verify the signature) but don't publish
#   T3CODE_ANDROID_ABIS arm64-v8a (default; phones) | x86_64 (emulator) | arm64-v8a,x86_64
# Bump ANDROID_VERSION_CODE in apps/mobile/app.config.ts before every publish: the
# versionCode must be strictly higher than the published one (`sideload publish` enforces it).
set -euo pipefail

NOTES="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SIDELOAD="${SIDELOAD_BIN:-$HOME/projects/android-sideload/bin/sideload}"
SLOT=t3code
APK="${APK:-$MOBILE_DIR/android/app/build/outputs/apk/release/app-release.apk}"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  export JAVA_HOME="${JAVA_HOME:-$(mise where java)}"
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
  export APP_VARIANT=preview EXPO_NO_GIT_STATUS=1
  cd "$MOBILE_DIR"
  npx expo prebuild --clean --platform android
  # The Expo template signs release with its own bundled (public RN) debug key. Every
  # sideloaded app must use ~/.android/debug.keystore, so swap it in (read-only use).
  cp "$HOME/.android/debug.keystore" android/app/debug.keystore
  (cd android && ./gradlew :app:assembleRelease --max-workers=8 \
    "-PreactNativeArchitectures=${T3CODE_ANDROID_ABIS:-arm64-v8a}")
fi

SDK_ROOT="${ANDROID_HOME:-$HOME/Android/Sdk}"
APKSIGNER="$(ls "$SDK_ROOT"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)"
EXPECTED_CERT=e22364d7125807c3d20e1bbe5237347e3dcbab3d29780a1c538593f52a3c1aa4
[ -f "$APK" ] || { echo "APK not found: $APK" >&2; exit 1; }
"$APKSIGNER" verify --print-certs "$APK" | grep -q "certificate SHA-256 digest: $EXPECTED_CERT" \
  || { echo "APK is not signed with ~/.android/debug.keystore ($EXPECTED_CERT)" >&2; exit 1; }
[ "${BUILD_ONLY:-0}" = "1" ] && { echo "Built and verified: $APK"; exit 0; }
"$SIDELOAD" publish "$SLOT" "$APK" ${NOTES:+--notes "$NOTES"}
echo "Download: https://15.204.108.12:7443/sideload/"
