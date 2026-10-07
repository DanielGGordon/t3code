package com.dgordon.sideload.updater

import org.json.JSONException
import org.json.JSONObject
import java.net.URL

/**
 * `latest.json`, written next to the APK by `android-sideload/bin/publish-apk.sh`
 * (and by Alfred's own publisher — the format is the same):
 *
 * ```json
 * { "applicationId": "com.dgordon.bruce", "versionCode": 2, "versionName": "0.1.0",
 *   "apk": "bruce-0.1.0.apk", "sha256": "…64 hex…", "sizeBytes": 5123456,
 *   "builtAt": "2026-10-07 18:00 UTC", "notes": "First real build." }
 * ```
 */
data class UpdateManifest(
    val versionCode: Long,
    val versionName: String,
    /** A bare file name, resolved against the manifest's own URL. */
    val apk: String,
    val sha256: String,
    val sizeBytes: Long = 0,
    /** Absent in Alfred's manifests; when present it must be this app's package. */
    val applicationId: String? = null,
    val builtAt: String? = null,
    val notes: String? = null,
) {
    /**
     * Worth acting on. [apk] is pasted onto a URL, so anything with a slash, a scheme or
     * `..` is a bug or an attacker; the SHA-256 is what makes the bytes installable.
     */
    val isSane: Boolean
        get() = versionCode > 0 && versionName.isNotBlank() &&
            APK_NAME.matches(apk) && HEX_64.matches(sha256)

    fun apkUrl(manifestUrl: String): String = URL(URL(manifestUrl), apk).toString()

    fun sizeLabel(): String? =
        if (sizeBytes <= 0) null else String.format("%.1f MB", sizeBytes / 1_048_576.0)

    companion object {
        private val APK_NAME = Regex("""[A-Za-z0-9._-]+\.apk""")
        private val HEX_64 = Regex("""[0-9a-fA-F]{64}""")

        /** Null for anything that is not a JSON object with the required fields. */
        fun parse(json: String): UpdateManifest? = try {
            val o = JSONObject(json)
            UpdateManifest(
                versionCode = o.getLong("versionCode"),
                versionName = o.getString("versionName"),
                apk = o.getString("apk"),
                sha256 = o.getString("sha256"),
                sizeBytes = o.optLong("sizeBytes", 0),
                applicationId = o.optStringOrNull("applicationId"),
                builtAt = o.optStringOrNull("builtAt"),
                notes = o.optStringOrNull("notes"),
            )
        } catch (e: JSONException) {
            null
        }

        private fun JSONObject.optStringOrNull(key: String): String? =
            if (isNull(key)) null else optString(key).ifBlank { null }
    }
}

sealed class UpdateCheck {
    data class UpToDate(val installedName: String) : UpdateCheck()
    data class Available(val manifest: UpdateManifest) : UpdateCheck()
    data class Failed(val reason: String) : UpdateCheck()

    companion object {
        /**
         * Strictly greater `versionCode` only: a lower one on the server is a rollback,
         * which is a decision made by re-sideloading, not something to offer silently.
         */
        fun decide(
            manifest: UpdateManifest?,
            installedCode: Long,
            installedName: String,
            packageName: String,
        ): UpdateCheck = when {
            manifest == null || !manifest.isSane ->
                Failed("the server sent an update file this app cannot read")
            manifest.applicationId != null && manifest.applicationId != packageName ->
                Failed("the server's update is for ${manifest.applicationId}, not $packageName")
            manifest.versionCode > installedCode -> Available(manifest)
            else -> UpToDate(installedName)
        }
    }
}
