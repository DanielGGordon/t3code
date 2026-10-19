import { useAtomValue } from "@effect/atom-react";
import { BellIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { getClientSettings } from "../../hooks/useSettings";
import {
  primaryNotificationsAtom,
  primaryNotificationsConnectedAtom,
} from "../../state/notifications";
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
  const connected = useAtomValue(primaryNotificationsConnectedAtom);
  const seenRef = useRef<ReadonlySet<string> | null>(null);
  // While disconnected, the list we last saw. The subscription keeps it until the new
  // session's snapshot replaces it, so it must not be mistaken for that snapshot.
  const staleRef = useRef<ReadonlyArray<unknown> | null>(null);
  const wasConnectedRef = useRef(false);
  const osRef = useRef(new Map<string, Notification>());

  useEffect(() => {
    if (notifications === null || !connected) {
      // No snapshot, or transport lost: the next fresh one is a new baseline, so
      // cards that arrived while offline are not announced as arrivals.
      seenRef.current = null;
      if (wasConnectedRef.current) staleRef.current = notifications;
      wasConnectedRef.current = false;
      return;
    }
    wasConnectedRef.current = true;
    if (notifications === staleRef.current) return;
    staleRef.current = null;
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
  }, [notifications, connected]);

  return null;
}
