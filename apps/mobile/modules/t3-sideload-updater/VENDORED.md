# Vendored: android-sideload updater

`android/src/main/java/com/dgordon/sideload/updater/*.kt`, `android/src/main/res/xml/sideload_updater_paths.xml`
and `android/src/main/AndroidManifest.xml` are verbatim copies of
`~/projects/android-sideload/android/updater/src/main/`
(source commit `cad44da`, vendored 2026-10-07). Do not edit them here; re-copy from
android-sideload and update this note. Everything else in this module is T3-specific glue:
`T3SideloadUpdaterModule.kt` (Expo wrapper), `android/build.gradle`, `expo-module.config.json`.

Android only. The module is only used by sideload builds (see `extra.sideloadUpdates` in
`app.config.ts`); iOS/web JS calls are no-ops (`src/features/updates/sideload-updates.ts`).
