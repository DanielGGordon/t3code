package com.dgordon.sideload.updater

import androidx.core.content.FileProvider

/** Its own class name so the manifest merger never folds it into the app's FileProvider. */
class UpdateFileProvider : FileProvider()
