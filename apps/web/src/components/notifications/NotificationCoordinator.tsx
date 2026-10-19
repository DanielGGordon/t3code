import { useAtomValue } from "@effect/atom-react";
import { BellIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { getClientSettings } from "../../hooks/useSettings";
import { primaryNotificationsAtom } from "../../state/notifications";
import { hasDesktopNotifications } from "../../threadNotifications";
import { toastManager } from "../ui/toast";
import { detectArrivals } from "./notifications.logic";

/**
 * Announces external notifications that arrive while the app is open: one toast
 * each, plus an OS notification when the tab is hidden and the user already
 * granted permission under the existing thread-notification mode. Never asks
 * for permission itself.
 */
export function NotificationCoordinator() {
  const notifications = useAtomValue(primaryNotificationsAtom);
  const seenRef = useRef<ReadonlySet<string> | null>(null);
  const osRef = useRef(new Map<string, Notification>());

  useEffect(() => {
    if (notifications === null) {
      // No snapshot (disconnected or still loading): the next one is a new baseline.
      seenRef.current = null;
      return;
    }
    const { arrivals, seen } = detectArrivals(seenRef.current, notifications);
    seenRef.current = seen;

    for (const [id, osNotification] of osRef.current) {
      if (!seen.has(id)) {
        osNotification.close();
        osRef.current.delete(id);
      }
    }

    for (const arrival of arrivals) {
      toastManager.add({
        type: "info",
        title: arrival.title,
        description: arrival.source,
        data: {
          hideCopyButton: true,
          leadingIcon: <BellIcon aria-hidden className="size-4" />,
        },
      });
      if (
        document.visibilityState === "hidden" &&
        hasDesktopNotifications(getClientSettings().notificationMode) &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          osRef.current.set(
            arrival.id,
            new Notification(arrival.title, { body: arrival.source, tag: arrival.id }),
          );
        } catch {
          // Some browsers expose Notification but reject desktop presentation.
        }
      }
    }
  }, [notifications]);

  return null;
}
