/**
 * External notifications: plain-text cards that outside services (through the
 * Alfred hub) push into T3 over HTTP, shown live in every connected client.
 * A card may carry action buttons; clicking one POSTs a signed callback to the
 * source. See docs/user/notifications-api.md for the wire contract.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Largest inbound request body the HTTP routes accept. */
export const NOTIFICATION_MAX_REQUEST_BYTES = 16 * 1024;
export const NOTIFICATION_MAX_ACTIONS = 4;
export const NOTIFICATION_SOURCE_MAX_LENGTH = 32;
export const NOTIFICATION_SOURCE_ID_MAX_LENGTH = 64;
/** `source` and `sourceId` path segments; `source` is further capped at 32 characters. */
export const NOTIFICATION_KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const NOTIFICATION_ACTION_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;

/** `${source}:${sourceId}`. */
export const NotificationId = TrimmedNonEmptyString.pipe(Schema.brand("NotificationId"));
export type NotificationId = typeof NotificationId.Type;

/** Whether `body` was written by the source itself or relays third-party text (e.g. a held Slack message). */
export const NotificationBodyTrust = Schema.Literals(["trusted", "external"]);
export type NotificationBodyTrust = typeof NotificationBodyTrust.Type;

export const NotificationActionStyle = Schema.Literals(["primary", "danger", "default"]);
export type NotificationActionStyle = typeof NotificationActionStyle.Type;

export const NotificationAction = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(NOTIFICATION_ACTION_ID_PATTERN)),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  style: Schema.optionalKey(NotificationActionStyle),
});
export type NotificationAction = typeof NotificationAction.Type;

export const NotificationState = Schema.Literals(["open", "resolved"]);
export type NotificationState = typeof NotificationState.Type;

/** Who closed a notification: a T3 user (act or dismiss), the source, or the expiry sweep. */
export const NotificationResolvedBy = Schema.Literals(["t3", "source", "expiry"]);
export type NotificationResolvedBy = typeof NotificationResolvedBy.Type;

/**
 * A notification as clients see it. `resolution` is an action id, "dismissed",
 * "expired" or "external". The source's callback URL never leaves the server.
 */
export const Notification = Schema.Struct({
  id: NotificationId,
  source: Schema.String,
  sourceId: Schema.String,
  kind: Schema.String,
  title: Schema.String,
  /** Plain text. Render as text, never as HTML or Markdown. */
  body: Schema.String,
  bodyTrust: NotificationBodyTrust,
  /** "More info" link (http/https). */
  url: Schema.NullOr(Schema.String),
  actions: Schema.Array(NotificationAction),
  state: NotificationState,
  resolution: Schema.NullOr(Schema.String),
  resolvedBy: Schema.NullOr(NotificationResolvedBy),
  /** Free label the source gave when resolving, such as "alfred". */
  resolvedByLabel: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  expiresAt: Schema.NullOr(IsoDateTime),
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type Notification = typeof Notification.Type;

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const NotificationHttpUrl = Schema.String.check(
  Schema.isMaxLength(2000),
  Schema.makeFilter(isHttpUrl, { description: "an http(s) URL" }),
);

const NotificationTimestamp = Schema.String.check(
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value)), {
    description: "an ISO-8601 timestamp",
  }),
);

/** `PUT /api/notifications/:source/:sourceId` body. Absent and `null` optional fields mean the same. */
export const NotificationUpsertRequest = Schema.Struct({
  kind: Schema.String.check(Schema.isMaxLength(32)),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  body: Schema.String.check(Schema.isMaxLength(2000)),
  bodyTrust: NotificationBodyTrust,
  url: Schema.optionalKey(Schema.NullOr(NotificationHttpUrl)),
  actions: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(NotificationAction).check(Schema.isMaxLength(NOTIFICATION_MAX_ACTIONS)),
    ),
  ),
  /** Required when `actions` is non-empty; its origin must be allowlisted on the server. */
  callbackUrl: Schema.optionalKey(Schema.NullOr(NotificationHttpUrl)),
  expiresAt: Schema.optionalKey(Schema.NullOr(NotificationTimestamp)),
});
export type NotificationUpsertRequest = typeof NotificationUpsertRequest.Type;

/** `POST /api/notifications/:source/:sourceId/resolve` body. `resolution` is "external" or an action id. */
export const NotificationResolveRequest = Schema.Struct({
  resolution: Schema.String.check(Schema.isPattern(NOTIFICATION_ACTION_ID_PATTERN)),
  resolvedBy: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(32)))),
});
export type NotificationResolveRequest = typeof NotificationResolveRequest.Type;

/** 200 body of both HTTP routes. */
export const NotificationWriteResponse = Schema.Struct({
  id: NotificationId,
  state: NotificationState,
});
export type NotificationWriteResponse = typeof NotificationWriteResponse.Type;

/** Stream element of `notifications.subscribe`: every open notification, newest first. */
export const NotificationListResult = Schema.Struct({
  notifications: Schema.Array(Notification),
});
export type NotificationListResult = typeof NotificationListResult.Type;

export const NotificationActInput = Schema.Struct({
  id: NotificationId,
  actionId: Schema.String.check(Schema.isPattern(NOTIFICATION_ACTION_ID_PATTERN)),
});
export type NotificationActInput = typeof NotificationActInput.Type;

export const NotificationDismissInput = Schema.Struct({ id: NotificationId });
export type NotificationDismissInput = typeof NotificationDismissInput.Type;

/**
 * Result of acting on or dismissing a notification. When the source reports it
 * was already handled elsewhere, `resolution` is "external" rather than the action.
 */
export const NotificationMutationResult = Schema.Struct({
  id: NotificationId,
  state: NotificationState,
  resolution: Schema.NullOr(Schema.String),
});
export type NotificationMutationResult = typeof NotificationMutationResult.Type;

/**
 * - `invalid_request`: an HTTP upsert/resolve failed validation (never seen by clients).
 * - `not_found`: no such notification (or it was pruned).
 * - `unknown_action`: the notification has no action with that id.
 * - `in_flight`: another click on this notification is still being delivered.
 * - `not_configured`: the server has no callback secret, or the callback origin is no longer allowed.
 * - `delivery_failed`: the source did not accept the action; the notification stays open.
 * - `storage`: the server could not read or write notifications.
 */
export const NotificationErrorReason = Schema.Literals([
  "invalid_request",
  "not_found",
  "unknown_action",
  "in_flight",
  "not_configured",
  "delivery_failed",
  "storage",
]);
export type NotificationErrorReason = typeof NotificationErrorReason.Type;

export class NotificationError extends Schema.TaggedError<NotificationError>()(
  "NotificationError",
  {
    message: Schema.String,
    reason: NotificationErrorReason,
    notificationId: Schema.optional(NotificationId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
