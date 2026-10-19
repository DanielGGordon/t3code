import { useAtomValue } from "@effect/atom-react";
import type { Notification } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { BellIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryNotificationsAtom } from "../../state/notifications";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  formatBellCount,
  resolveNotificationBellVisible,
  safeHttpUrl,
} from "./notifications.logic";

const ACTION_VARIANT = {
  primary: "default",
  danger: "destructive",
  default: "outline",
} as const;

/** Bodies longer than this start clamped, with a Show more control. */
const CLAMP_BODY_CHARS = 240;
const CLAMP_BODY_LINES = 4;

const EMPTY: ReadonlyArray<Notification> = [];

/** Header bell for external notifications; the list and its actions live in the popover. */
export function NotificationBell() {
  const visibility = useClientSettings((settings) => settings.headerNotificationsVisibility);
  const notifications = useAtomValue(primaryNotificationsAtom) ?? EMPTY;
  if (!resolveNotificationBellVisible(visibility, notifications.length)) {
    return null;
  }
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-xs"
                  type="button"
                  aria-label={
                    notifications.length > 0
                      ? `Notifications (${notifications.length} open)`
                      : "Notifications"
                  }
                  className="relative shrink-0 touch:size-12 max-md:touch:size-10"
                />
              }
            >
              <BellIcon aria-hidden className="touch:size-5" />
              {notifications.length > 0 ? (
                <Badge
                  variant="destructive"
                  size="sm"
                  className="pointer-events-none absolute -top-1.5 -right-1.5"
                >
                  {formatBellCount(notifications.length)}
                </Badge>
              ) : null}
            </PopoverTrigger>
          }
        />
        <TooltipPopup side="bottom">Notifications</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" width="lg" padding="compact">
        <NotificationList notifications={notifications} />
      </PopoverPopup>
    </Popover>
  );
}

function NotificationList(props: { readonly notifications: ReadonlyArray<Notification> }) {
  if (props.notifications.length === 0) {
    return <p className="py-3 text-center text-sm text-muted-foreground">No open notifications.</p>;
  }
  return (
    <ul className="-my-1 flex max-h-96 flex-col divide-y divide-border overflow-y-auto">
      {props.notifications.map((notification) => (
        <NotificationItem key={notification.id} notification={notification} />
      ))}
    </ul>
  );
}

function NotificationItem(props: { readonly notification: Notification }) {
  const { notification } = props;
  const environmentId = usePrimaryEnvironmentId();
  const canOperate = useAtomValue(
    serverEnvironment.actOnNotification.permissionAtom(environmentId),
  );
  const act = useAtomCommand(serverEnvironment.actOnNotification, { reportFailure: false });
  const dismiss = useAtomCommand(serverEnvironment.dismissNotification, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  if (environmentId === null) return null;

  const external = notification.bodyTrust === "external";
  const url = safeHttpUrl(notification.url);
  const clampable =
    notification.body.length > CLAMP_BODY_CHARS ||
    notification.body.split("\n").length > CLAMP_BODY_LINES;

  const run = async (
    request: () => ReturnType<typeof act> | ReturnType<typeof dismiss>,
  ): Promise<void> => {
    setBusy(true);
    try {
      const result = await request();
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: error instanceof Error ? error.message : "Could not update the notification.",
          });
        }
        return;
      }
      if (result.value.resolution === "external") {
        toastManager.add({ type: "info", title: "Already handled elsewhere" });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-1.5 py-2.5 first:pt-1 last:pb-1">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="secondary" size="sm">
              {notification.source}
            </Badge>
            <span>{formatRelativeTimeLabel(notification.createdAt)}</span>
          </div>
          <p className="text-sm font-medium break-words">{notification.title}</p>
        </div>
        <Button
          variant="ghost-muted"
          size="icon-micro"
          type="button"
          aria-label="Dismiss notification"
          disabled={busy}
          onClick={() => void run(() => dismiss({ environmentId, input: { id: notification.id } }))}
        >
          <XIcon aria-hidden />
        </Button>
      </div>
      {notification.body.length > 0 ? (
        <div className="flex flex-col items-start gap-1">
          {external ? (
            <Badge variant="warning" size="sm">
              external · unverified
            </Badge>
          ) : null}
          <p
            className={
              (external ? "text-muted-foreground " : "text-foreground/80 ") +
              "w-full text-xs break-words whitespace-pre-wrap" +
              (clampable && !expanded ? " line-clamp-4" : "")
            }
          >
            {notification.body}
          </p>
          {clampable ? (
            <Button
              variant="link"
              size="micro"
              type="button"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show less" : "Show more"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {notification.actions.length > 0 || url !== null ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {notification.actions.map((action) => (
            <Button
              key={action.id}
              variant={ACTION_VARIANT[action.style ?? "default"]}
              size="sm"
              type="button"
              disabled={busy || !canOperate}
              onClick={() =>
                void run(() =>
                  act({ environmentId, input: { id: notification.id, actionId: action.id } }),
                )
              }
            >
              {action.label}
            </Button>
          ))}
          {url !== null ? (
            <Button
              variant="link"
              size="sm"
              render={<a href={url} target="_blank" rel="noopener noreferrer" />}
            >
              More info
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
