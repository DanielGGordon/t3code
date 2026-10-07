package com.dgordon.sideload.updater

import android.content.Context
import java.io.File

/**
 * Slot reuse guard. A slot package (`com.dgordon.<slot>`) can host a different app over
 * its lifetime, and the new app arrives as an *upgrade* of the old one — so it inherits
 * the old app's files, databases and preferences. Call this first thing in
 * `Application.onCreate` (or the launcher activity's `onCreate`, before touching storage):
 *
 * ```kotlin
 * SlotTenant.ensure(this, BuildConfig.SLOT_TENANT)
 * ```
 *
 * If the recorded tenant differs, everything the previous tenant left in the app's data
 * dir is deleted once, then the new tenant is recorded. The same tenant is a no-op, so
 * ordinary updates keep their data. `bin/new-app.sh` writes a unique `SLOT_TENANT`.
 */
object SlotTenant {

    private const val MARKER = "sideload-slot-tenant"

    /** @return true when a previous tenant's data was wiped. */
    fun ensure(context: Context, tenant: String): Boolean {
        val app = context.applicationContext
        val dataDir = File(app.applicationInfo.dataDir)
        val marker = File(app.noBackupFilesDir, MARKER)
        val current = marker.takeIf { it.isFile }?.readText()?.trim()
        if (current == tenant) return false

        // First run of any tenant on a fresh install has nothing to wipe but is harmless.
        val wiped = current != null || hasForeignData(dataDir)
        if (wiped) {
            dataDir.listFiles()?.forEach { child ->
                if (child.name != "lib") child.deleteRecursively()
            }
        }
        app.noBackupFilesDir.mkdirs()
        marker.writeText(tenant)
        return wiped
    }

    private fun hasForeignData(dataDir: File): Boolean =
        listOf("databases", "shared_prefs", "files").any { name ->
            File(dataDir, name).listFiles()?.any { it.name != "sideload_updater.xml" } == true
        }
}
