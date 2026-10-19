/**
 * External notifications: plain-text cards outside services push in over
 * `/api/notifications` (see `./http.ts`), streamed live to every client.
 *
 * A notification is `open` until it is resolved, which is terminal: by the
 * source (`resolve`), by a user (`dismiss`, or `act` once the source accepts
 * the signed callback), or by the expiry sweep. Resolved rows stay for 7 days
 * so a late upsert from the source cannot reopen them.
 *
 * Config (read at startup):
 * - `T3_NOTIFICATION_CALLBACK_SECRET`: HMAC key for action callbacks. Unset
 *   means notifications with actions are accepted but acting fails.
 * - `T3_NOTIFICATION_CALLBACK_ORIGINS`: comma list of allowed callback
 *   origins. Empty means any notification with actions is rejected.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import {
  NOTIFICATION_ACTION_ID_PATTERN,
  NOTIFICATION_KEY_PATTERN,
  NOTIFICATION_SOURCE_MAX_LENGTH,
  type Notification,
  NotificationAction,
  NotificationError,
  type NotificationActInput,
  type NotificationDismissInput,
  NotificationId,
  type NotificationListResult,
  type NotificationMutationResult,
  type NotificationResolveRequest,
  type NotificationResolvedBy,
  type NotificationUpsertRequest,
  type NotificationWriteResponse,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";

const NOTIFICATION_SIGNATURE_HEADER = "X-T3-Signature";
const CALLBACK_TIMEOUT = Duration.seconds(5);
const SWEEP_INTERVAL = Duration.seconds(30);
const RESOLVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Latest expiry stored (9999-12-31); keeps ISO strings fixed-width so they compare as text. */
const MAX_EXPIRES_AT_MS = 253_402_214_400_000;

/** Every stored timestamp is UTC `YYYY-MM-DDTHH:mm:ss.sssZ`, so SQL compares them as text. */
const isoAt = (epochMillis: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMillis));

const NotificationConfig = Config.all({
  callbackSecret: Config.Redacted("T3_NOTIFICATION_CALLBACK_SECRET").pipe(Config.option),
  callbackOrigins: Config.String("T3_NOTIFICATION_CALLBACK_ORIGINS").pipe(Config.withDefault("")),
});

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<rawBody>")>`. */
export function signNotificationCallback(secret: string, timestamp: number, rawBody: string) {
  const digest = NodeCrypto.createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function parseCallbackOrigins(value: string): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const entry of value.split(",")) {
    const origin = originOf(entry.trim());
    if (origin !== null && origin !== "null") origins.add(origin);
  }
  return origins;
}

const invalid = (message: string) => new NotificationError({ message, reason: "invalid_request" });
const storageError = (cause: unknown) =>
  new NotificationError({
    message: "Could not read or write notifications.",
    reason: "storage",
    cause,
  });
const notFound = (id: string) =>
  new NotificationError({
    message: "Notification not found.",
    reason: "not_found",
    notificationId: NotificationId.make(id),
  });

interface NotificationRow {
  readonly notification_id: string;
  readonly source: string;
  readonly source_id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly body_trust: string;
  readonly url: string | null;
  readonly actions_json: string;
  readonly callback_url: string | null;
  readonly state: string;
  readonly resolution: string | null;
  readonly resolved_by: string | null;
  readonly resolved_by_label: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string | null;
  readonly resolved_at: string | null;
}

const ActionsJson = Schema.fromJsonString(Schema.Array(NotificationAction));
const decodeActions = Schema.decodeUnknownOption(ActionsJson);
const encodeActions = Schema.encodeSync(ActionsJson);
const CallbackBodyJson = Schema.fromJsonString(
  Schema.Struct({
    notificationId: Schema.String,
    source: Schema.String,
    sourceId: Schema.String,
    actionId: Schema.String,
    actedAt: Schema.String,
  }),
);
const encodeCallbackBody = Schema.encodeSync(CallbackBodyJson);

function toNotification(row: NotificationRow): Notification {
  return {
    id: NotificationId.make(row.notification_id),
    source: row.source,
    sourceId: row.source_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    bodyTrust: row.body_trust === "trusted" ? "trusted" : "external",
    url: row.url,
    actions: Option.getOrElse(decodeActions(row.actions_json), () => []),
    state: row.state === "open" ? "open" : "resolved",
    resolution: row.resolution,
    resolvedBy: (row.resolved_by as NotificationResolvedBy | null) ?? null,
    resolvedByLabel: row.resolved_by_label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
  };
}

/** Path keys are checked here, not only in the route, so every caller gets the same rules. */
function notificationIdFor(source: string, sourceId: string) {
  if (
    !NOTIFICATION_KEY_PATTERN.test(source) ||
    source.length > NOTIFICATION_SOURCE_MAX_LENGTH ||
    !NOTIFICATION_KEY_PATTERN.test(sourceId)
  ) {
    return Effect.fail(
      invalid("source and sourceId must match [A-Za-z0-9._-] (source <= 32, sourceId <= 64)."),
    );
  }
  return Effect.succeed(`${source}:${sourceId}`);
}

export class NotificationService extends Context.Service<
  NotificationService,
  {
    /** Creates or updates an open notification. A resolved one is left as is (no resurrection). */
    readonly upsert: (input: {
      readonly source: string;
      readonly sourceId: string;
      readonly request: NotificationUpsertRequest;
    }) => Effect.Effect<NotificationWriteResponse, NotificationError>;
    /** Resolves on the source's behalf. Idempotent; fails `not_found` for an unknown id. */
    readonly resolve: (input: {
      readonly source: string;
      readonly sourceId: string;
      readonly request: NotificationResolveRequest;
    }) => Effect.Effect<NotificationWriteResponse, NotificationError>;
    /** Open, unexpired notifications, newest first. */
    readonly list: () => Effect.Effect<NotificationListResult, NotificationError>;
    /** `list()` now, then again after every change. */
    readonly subscribeList: () => Stream.Stream<NotificationListResult, NotificationError>;
    /** Resolves as "dismissed" by T3. The source is not told. */
    readonly dismiss: (
      input: NotificationDismissInput,
    ) => Effect.Effect<NotificationMutationResult, NotificationError>;
    /**
     * POSTs the signed action to the source's callback and resolves only if the
     * source accepts it (or says it was already handled). Otherwise it stays open.
     */
    readonly act: (
      input: NotificationActInput,
    ) => Effect.Effect<NotificationMutationResult, NotificationError>;
    /** Expires overdue notifications and prunes old resolved ones. Also runs every 30 s. */
    readonly sweep: Effect.Effect<void, NotificationError>;
  }
>()("t3/notifications/NotificationService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const httpClient = yield* HttpClient.HttpClient;
  const config = yield* NotificationConfig;
  const allowedOrigins = parseCallbackOrigins(config.callbackOrigins);
  // Sliding(1) coalesces change signals: each one triggers a full re-list anyway.
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const inFlight = yield* Ref.make<ReadonlySet<string>>(new Set());

  const nowIso = Clock.currentTimeMillis.pipe(Effect.map(isoAt));

  const findRow = (id: string) =>
    sql<NotificationRow>`SELECT * FROM notifications WHERE notification_id = ${id}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError(storageError),
    );

  const expireDue = (now: string) =>
    sql<{ readonly notification_id: string }>`
      UPDATE notifications
      SET state = 'resolved', resolution = 'expired', resolved_by = 'expiry',
          resolved_at = ${now}, updated_at = ${now}
      WHERE state = 'open' AND expires_at IS NOT NULL AND expires_at <= ${now}
      RETURNING notification_id
    `.pipe(
      Effect.mapError(storageError),
      Effect.tap((rows) => (rows.length > 0 ? notifyChanged : Effect.void)),
    );

  const markResolved = (input: {
    readonly id: string;
    readonly resolution: string;
    readonly resolvedBy: NotificationResolvedBy;
    readonly label: string | null;
    readonly now: string;
  }) =>
    sql<{ readonly notification_id: string }>`
      UPDATE notifications
      SET state = 'resolved', resolution = ${input.resolution}, resolved_by = ${input.resolvedBy},
          resolved_by_label = ${input.label}, resolved_at = ${input.now}, updated_at = ${input.now}
      WHERE notification_id = ${input.id} AND state = 'open'
      RETURNING notification_id
    `.pipe(
      Effect.mapError(storageError),
      Effect.tap((rows) => (rows.length > 0 ? notifyChanged : Effect.void)),
    );

  const mutationResult = (row: NotificationRow): NotificationMutationResult => ({
    id: NotificationId.make(row.notification_id),
    state: row.state === "open" ? "open" : "resolved",
    resolution: row.resolution,
  });

  const sweep: NotificationService["Service"]["sweep"] = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    yield* expireDue(isoAt(nowMs));
    yield* sql`
      DELETE FROM notifications
      WHERE state = 'resolved' AND resolved_at < ${isoAt(nowMs - RESOLVED_RETENTION_MS)}
    `.pipe(Effect.mapError(storageError));
  });

  const upsert: NotificationService["Service"]["upsert"] = ({ source, sourceId, request }) =>
    Effect.gen(function* () {
      const id = yield* notificationIdFor(source, sourceId);
      const actions = request.actions ?? [];
      if (new Set(actions.map((action) => action.id)).size !== actions.length) {
        return yield* invalid("Action ids must be unique.");
      }
      let callbackUrl: string | null = null;
      if (actions.length > 0) {
        if (request.callbackUrl == null) {
          return yield* invalid("callbackUrl is required when actions are given.");
        }
        const origin = originOf(request.callbackUrl);
        if (origin === null || !allowedOrigins.has(origin)) {
          return yield* invalid(
            "callbackUrl origin is not allowed (T3_NOTIFICATION_CALLBACK_ORIGINS).",
          );
        }
        callbackUrl = request.callbackUrl;
      }
      let expiresAt: string | null = null;
      if (request.expiresAt != null) {
        const parsed = DateTime.make(request.expiresAt).pipe(Option.map(DateTime.toEpochMillis));
        if (Option.isNone(parsed) || parsed.value < 0 || parsed.value > MAX_EXPIRES_AT_MS) {
          return yield* invalid("expiresAt must be an ISO-8601 timestamp.");
        }
        expiresAt = isoAt(parsed.value);
      }
      const now = yield* nowIso;
      // One transaction: rows already past their expiry are resolved first, so the conflict
      // update below cannot extend a card the sweep has not reached yet, and a new card that
      // arrives already expired is stored resolved.
      const row = yield* Effect.gen(function* () {
        yield* expireDue(now);
        // The WHERE on the conflict branch is what keeps a resolved row resolved.
        yield* sql`
          INSERT INTO notifications (
            notification_id, source, source_id, kind, title, body, body_trust, url,
            actions_json, callback_url, state, created_at, updated_at, expires_at
          ) VALUES (
            ${id}, ${source}, ${sourceId}, ${request.kind}, ${request.title}, ${request.body},
            ${request.bodyTrust}, ${request.url ?? null}, ${encodeActions(actions)}, ${callbackUrl},
            'open', ${now}, ${now}, ${expiresAt}
          )
          ON CONFLICT (notification_id) DO UPDATE SET
            kind = excluded.kind, title = excluded.title, body = excluded.body,
            body_trust = excluded.body_trust, url = excluded.url,
            actions_json = excluded.actions_json, callback_url = excluded.callback_url,
            expires_at = excluded.expires_at, updated_at = excluded.updated_at
          WHERE notifications.state = 'open'
        `.pipe(Effect.mapError(storageError));
        yield* expireDue(now);
        return yield* findRow(id);
      }).pipe(
        sql.withTransaction,
        Effect.mapError((error) =>
          error instanceof NotificationError ? error : storageError(error),
        ),
      );
      yield* notifyChanged;
      return {
        id: NotificationId.make(id),
        state: row?.state === "open" ? ("open" as const) : ("resolved" as const),
      };
    });

  const resolve: NotificationService["Service"]["resolve"] = ({ source, sourceId, request }) =>
    Effect.gen(function* () {
      const id = yield* notificationIdFor(source, sourceId);
      const now = yield* nowIso;
      const row = yield* Effect.gen(function* () {
        yield* markResolved({
          id,
          resolution: request.resolution,
          resolvedBy: "source",
          label: request.resolvedBy ?? null,
          now,
        });
        return yield* findRow(id);
      }).pipe(
        sql.withTransaction,
        Effect.mapError((error) =>
          error instanceof NotificationError ? error : storageError(error),
        ),
      );
      if (row === undefined) return yield* notFound(id);
      return {
        id: NotificationId.make(id),
        state: row.state === "open" ? ("open" as const) : ("resolved" as const),
      };
    });

  const list: NotificationService["Service"]["list"] = () =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      // Expired rows the sweep has not reached yet are hidden, not rewritten, on read.
      const rows = yield* sql<NotificationRow>`
        SELECT * FROM notifications
        WHERE state = 'open' AND (expires_at IS NULL OR expires_at > ${now})
        ORDER BY created_at DESC, notification_id
      `.pipe(Effect.mapError(storageError));
      return { notifications: rows.map(toNotification) };
    });

  const subscribeList: NotificationService["Service"]["subscribeList"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the snapshot so a change landing between the two is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(list()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
        );
      }),
    );

  const dismiss: NotificationService["Service"]["dismiss"] = ({ id }) =>
    Effect.gen(function* () {
      // Resolving mid-delivery would let the source accept an action on a card already dismissed.
      if ((yield* Ref.get(inFlight)).has(id)) {
        return yield* new NotificationError({
          message: "An action on this notification is being delivered.",
          reason: "in_flight",
          notificationId: id,
        });
      }
      yield* markResolved({
        id,
        resolution: "dismissed",
        resolvedBy: "t3",
        label: null,
        now: yield* nowIso,
      });
      const row = yield* findRow(id);
      if (row === undefined) return yield* notFound(id);
      return mutationResult(row);
    });

  /** Carries no cause: HTTP client errors embed the callback URL, which clients never see. */
  const deliveryFailed = (id: NotificationId, label: string) =>
    new NotificationError({
      message: `Could not deliver '${label}' — try again.`,
      reason: "delivery_failed",
      notificationId: id,
    });

  /** Sends the callback; `Some(resolution)` when the source accepted or had already resolved it. */
  const deliver = (input: {
    readonly row: NotificationRow;
    readonly action: NotificationAction;
    readonly callbackUrl: string;
    readonly secret: string;
  }) =>
    Effect.gen(function* () {
      const { row, action } = input;
      const id = NotificationId.make(row.notification_id);
      const nowMs = yield* Clock.currentTimeMillis;
      const rawBody = encodeCallbackBody({
        notificationId: row.notification_id,
        source: row.source,
        sourceId: row.source_id,
        actionId: action.id,
        actedAt: isoAt(nowMs),
      });
      const request = HttpClientRequest.post(input.callbackUrl).pipe(
        HttpClientRequest.bodyText(rawBody, "application/json"),
        HttpClientRequest.setHeader(
          NOTIFICATION_SIGNATURE_HEADER,
          signNotificationCallback(input.secret, Math.floor(nowMs / 1000), rawBody),
        ),
      );
      const outcome = yield* httpClient.execute(request).pipe(
        Effect.flatMap((response) => {
          if (response.status >= 200 && response.status < 300) {
            return Effect.succeedSome(action.id);
          }
          if (response.status !== 404 && response.status !== 409) {
            return Effect.succeed(Option.none<string>());
          }
          return response.json.pipe(
            Effect.map((body) =>
              typeof body === "object" &&
              body !== null &&
              (body as { readonly status?: unknown }).status === "already_resolved"
                ? Option.some("external")
                : Option.none<string>(),
            ),
            Effect.orElseSucceed(() => Option.none<string>()),
          );
        }),
        // A redirect would carry the signed body somewhere the allowlist never saw.
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeoutOption(CALLBACK_TIMEOUT),
        // Log the failure kind only: the URL and body stay out of the log line.
        Effect.tapError((error) =>
          Effect.logWarning("Notification action could not reach its source", {
            notificationId: row.notification_id,
            actionId: action.id,
            outcome: error.reason._tag,
          }),
        ),
        Effect.mapError(() => deliveryFailed(id, action.label)),
      );
      if (Option.isNone(outcome) || Option.isNone(outcome.value)) {
        yield* Effect.logWarning("Notification action was not accepted by its source", {
          notificationId: row.notification_id,
          actionId: action.id,
          outcome: Option.isNone(outcome) ? "timeout" : "rejected",
        });
        return yield* deliveryFailed(id, action.label);
      }
      return outcome.value.value;
    });

  const act: NotificationService["Service"]["act"] = ({ id, actionId }) =>
    Effect.gen(function* () {
      yield* expireDue(yield* nowIso);
      const row = yield* findRow(id);
      if (row === undefined) return yield* notFound(id);
      if (row.state !== "open") return mutationResult(row);
      const action = toNotification(row).actions.find((candidate) => candidate.id === actionId);
      if (action === undefined || !NOTIFICATION_ACTION_ID_PATTERN.test(actionId)) {
        return yield* new NotificationError({
          message: "This notification has no such action.",
          reason: "unknown_action",
          notificationId: id,
        });
      }
      const callbackUrl = row.callback_url;
      const origin = callbackUrl === null ? null : originOf(callbackUrl);
      const secret = config.callbackSecret;
      if (Option.isNone(secret) || callbackUrl === null || origin === null) {
        return yield* new NotificationError({
          message: "Notification actions are not configured on this server.",
          reason: "not_configured",
          notificationId: id,
        });
      }
      // The allowlist may have shrunk since the notification arrived.
      if (!allowedOrigins.has(origin)) {
        return yield* new NotificationError({
          message: "This notification's callback origin is no longer allowed.",
          reason: "not_configured",
          notificationId: id,
        });
      }
      const claimed = yield* Ref.modify(inFlight, (current) =>
        current.has(id) ? [false, current] : [true, new Set(current).add(id)],
      );
      if (!claimed) {
        return yield* new NotificationError({
          message: "An action on this notification is already being delivered.",
          reason: "in_flight",
          notificationId: id,
        });
      }
      return yield* Effect.gen(function* () {
        const resolution = yield* deliver({
          row,
          action,
          callbackUrl,
          secret: Redacted.value(secret.value),
        });
        yield* markResolved({
          id,
          resolution,
          resolvedBy: resolution === "external" ? "source" : "t3",
          label: null,
          now: yield* nowIso,
        });
        const updated = yield* findRow(id);
        return updated === undefined ? mutationResult(row) : mutationResult(updated);
      }).pipe(
        Effect.ensuring(
          Ref.update(inFlight, (current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          }),
        ),
      );
    });

  yield* forkParked(
    sweep.pipe(
      Effect.catch((cause) => Effect.logWarning("Notification sweep failed", { cause })),
      Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
    ),
  );

  return NotificationService.of({
    upsert,
    resolve,
    list,
    subscribeList,
    dismiss,
    act,
    sweep,
  });
});

export const layer = Layer.effect(NotificationService, make).pipe(
  Layer.provide(FetchHttpClient.layer),
);
