package expo.modules.t3sideloadupdater

import com.dgordon.sideload.updater.Updater
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Expo wrapper over the vendored android-sideload [Updater]; see ../../../../../VENDORED.md. */
class T3SideloadUpdaterModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3SideloadUpdater")

    // The "Check for updates" button: always answers with a dialog.
    Function("checkForUpdates") { manifestUrl: String ->
      val activity = appContext.currentActivity ?: return@Function false
      activity.runOnUiThread { Updater.checkForUpdates(activity, manifestUrl) }
      true
    }

    // Quiet check for foreground/launch: rate-limited and silent unless an update exists.
    Function("checkOnLaunch") { manifestUrl: String ->
      val activity = appContext.currentActivity ?: return@Function false
      activity.runOnUiThread { Updater.checkOnLaunch(activity, manifestUrl) }
      true
    }
  }
}
