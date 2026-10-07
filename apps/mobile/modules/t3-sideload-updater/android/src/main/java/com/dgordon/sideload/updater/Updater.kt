package com.dgordon.sideload.updater

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.LinearLayout
import android.widget.ProgressBar
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * The whole in-app update flow, behind one call per entry point:
 *
 * ```kotlin
 * checkButton.setOnClickListener { Updater.checkForUpdates(this, BuildConfig.UPDATE_MANIFEST_URL) }
 * override fun onResume() { super.onResume(); Updater.checkOnLaunch(this, BuildConfig.UPDATE_MANIFEST_URL) }
 * ```
 *
 * GET `latest.json` → strictly newer `versionCode`? → "Update?" dialog → download into
 * `cacheDir/sideload-updates/`, **SHA-256 verified before the installer sees it** → the
 * system installer on a `content://` URI. The first update stops once at Android's
 * "install unknown apps" toggle for this app; we deep-link it.
 *
 * Every build is signed with the same `~/.android/debug.keystore`, so the installer
 * treats it as an upgrade in place and the app's data survives.
 */
object Updater {

    private const val DIR = "sideload-updates"
    private const val AUTHORITY_SUFFIX = ".sideload-updates"
    private const val APK_MIME = "application/vnd.android.package-archive"
    private const val PREFS = "sideload_updater"
    private const val KEY_LAST_AUTO = "last_auto_check"
    private const val AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000L
    private const val TIMEOUT_MS = 15_000

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    /** The button. Always answers: up to date, an update, or why it could not tell. */
    fun checkForUpdates(activity: Activity, manifestUrl: String) {
        val checking = progressDialog(activity, "Checking for updates…")
        io.execute {
            val result = check(activity, manifestUrl)
            onMain(activity) {
                checking.dismiss()
                when (result) {
                    is UpdateCheck.Available -> offer(activity, manifestUrl, result.manifest)
                    is UpdateCheck.UpToDate -> AlertDialog.Builder(activity)
                        .setTitle("Up to date")
                        .setMessage("${label(activity)} ${result.installedName} is the latest version.")
                        .setPositiveButton(android.R.string.ok, null)
                        .show()
                    is UpdateCheck.Failed -> AlertDialog.Builder(activity)
                        .setTitle("Couldn't check for updates")
                        .setMessage(result.reason)
                        .setPositiveButton(android.R.string.ok, null)
                        .show()
                }
            }
        }
    }

    /** Quiet check for `onResume`: at most every 6 hours, and silent unless there is an update. */
    fun checkOnLaunch(activity: Activity, manifestUrl: String) {
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (now - prefs.getLong(KEY_LAST_AUTO, 0) < AUTO_INTERVAL_MS) return
        prefs.edit().putLong(KEY_LAST_AUTO, now).apply()
        io.execute {
            val result = check(activity, manifestUrl)
            if (result is UpdateCheck.Available) onMain(activity) { offer(activity, manifestUrl, result.manifest) }
        }
    }

    /** Blocking; call off the main thread. Never throws. */
    fun check(context: Context, manifestUrl: String): UpdateCheck {
        val app = context.applicationContext
        val info = app.packageManager.getPackageInfo(app.packageName, 0)
        val body = try {
            httpGet(manifestUrl)
        } catch (e: IOException) {
            return UpdateCheck.Failed("Offline or server unreachable (${e.message ?: e.javaClass.simpleName}).")
        }
        return UpdateCheck.decide(
            UpdateManifest.parse(body),
            PackageInfoCompat.getLongVersionCode(info),
            info.versionName ?: "?",
            app.packageName,
        )
    }

    private fun offer(activity: Activity, manifestUrl: String, m: UpdateManifest) {
        val details = listOfNotNull(m.sizeLabel(), m.builtAt?.let { "built $it" }).joinToString(" · ")
        val message = buildString {
            append("${label(activity)} ${m.versionName} is available.")
            if (details.isNotEmpty()) append("\n$details")
            m.notes?.let { append("\n\n$it") }
        }
        AlertDialog.Builder(activity)
            .setTitle("Update available")
            .setMessage(message)
            .setPositiveButton("Update") { _, _ -> install(activity, manifestUrl, m) }
            .setNegativeButton("Later", null)
            .show()
    }

    private fun install(activity: Activity, manifestUrl: String, m: UpdateManifest) {
        if (!activity.packageManager.canRequestPackageInstalls()) {
            AlertDialog.Builder(activity)
                .setTitle("One-time permission")
                .setMessage(
                    "Android needs you to allow ${label(activity)} to install updates. " +
                        "Turn it on, come back, and tap Check for updates again.",
                )
                .setPositiveButton("Open settings") { _, _ ->
                    activity.startActivity(
                        Intent(
                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:${activity.packageName}"),
                        ),
                    )
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
            return
        }
        val bar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100 }
        val dialog = progressDialog(activity, "Downloading ${m.versionName}…", bar)
        io.execute {
            val outcome = runCatching { download(activity, manifestUrl, m) { p -> main.post { bar.progress = p } } }
            onMain(activity) {
                dialog.dismiss()
                outcome.onSuccess { file -> activity.startActivity(installIntent(activity, file)) }
                    .onFailure { e ->
                        AlertDialog.Builder(activity)
                            .setTitle("Update failed")
                            .setMessage(e.message ?: e.javaClass.simpleName)
                            .setPositiveButton(android.R.string.ok, null)
                            .show()
                    }
            }
        }
    }

    /** Download and verify; a cached file with the right digest is reused. */
    private fun download(context: Context, manifestUrl: String, m: UpdateManifest, onProgress: (Int) -> Unit): File {
        val dir = File(context.applicationContext.cacheDir, DIR).apply { mkdirs() }
        val target = File(dir, m.apk)
        if (target.isFile && sha256(target).equals(m.sha256, ignoreCase = true)) return target

        val part = File(dir, m.apk + ".part")
        val conn = open(m.apkUrl(manifestUrl))
        try {
            if (conn.responseCode != 200) throw IOException("HTTP ${conn.responseCode} downloading ${m.apk}")
            val total = conn.contentLengthLong.takeIf { it > 0 } ?: m.sizeBytes
            val digest = MessageDigest.getInstance("SHA-256")
            var read = 0L
            conn.inputStream.use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        digest.update(buf, 0, n)
                        read += n
                        if (total > 0) onProgress(((read * 100) / total).toInt().coerceIn(0, 100))
                    }
                }
            }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (!actual.equals(m.sha256, ignoreCase = true)) {
                throw IOException("The download did not match its checksum; nothing was installed.")
            }
        } catch (e: IOException) {
            part.delete()
            throw e
        } finally {
            conn.disconnect()
        }
        if (!part.renameTo(target)) throw IOException("Could not save the download.")
        dir.listFiles()?.forEach { if (it != target) it.delete() }
        return target
    }

    private fun installIntent(context: Context, file: File): Intent {
        val uri = FileProvider.getUriForFile(context, context.packageName + AUTHORITY_SUFFIX, file)
        return Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, APK_MIME)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    private fun httpGet(url: String): String {
        val conn = open(url)
        try {
            if (conn.responseCode != 200) throw IOException("HTTP ${conn.responseCode} from $url")
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    private fun open(url: String): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            useCaches = false
            setRequestProperty("Cache-Control", "no-cache")
        }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun progressDialog(activity: Activity, title: String, bar: ProgressBar? = null): AlertDialog {
        val pad = (24 * activity.resources.displayMetrics.density).toInt()
        val body = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad / 2)
            addView(bar ?: ProgressBar(activity))
        }
        return AlertDialog.Builder(activity).setTitle(title).setView(body).setCancelable(false).show()
    }

    private fun onMain(activity: Activity, block: () -> Unit) = main.post {
        if (!activity.isFinishing && !activity.isDestroyed) block()
    }

    private fun label(context: Context): CharSequence =
        context.applicationInfo.loadLabel(context.packageManager)
}
