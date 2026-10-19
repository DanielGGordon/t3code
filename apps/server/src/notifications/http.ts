/**
 * Inbound external notifications (fork). Sources, normally through the Alfred
 * hub, push with a bearer token holding `notifications:write`:
 *
 * - `PUT  /api/notifications/:source/:sourceId` — idempotent upsert.
 * - `POST /api/notifications/:source/:sourceId/resolve` — idempotent resolve.
 *
 * Contract and examples: docs/user/notifications-api.md.
 */
import {
  AuthNotificationsWriteScope,
  NOTIFICATION_MAX_REQUEST_BYTES,
  type NotificationError,
  NotificationResolveRequest,
  NotificationUpsertRequest,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import { authenticateRawRouteWithScope } from "../http.ts";
import * as NotificationService from "./NotificationService.ts";

const NOTIFICATION_ROUTE_PATH = "/api/notifications/:source/:sourceId";
const NOTIFICATION_RESOLVE_ROUTE_PATH = "/api/notifications/:source/:sourceId/resolve";

const failure = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status });

const statusFor = (error: NotificationError) =>
  error.reason === "invalid_request" ? 400 : error.reason === "not_found" ? 404 : 500;

const decodeUpsert = Schema.decodeUnknownOption(Schema.fromJsonString(NotificationUpsertRequest));
const decodeResolve = Schema.decodeUnknownOption(Schema.fromJsonString(NotificationResolveRequest));

/** The body as text, or `None` when it is over the cap or unreadable. */
const readCappedBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const contentLength = Number(request.headers["content-length"] ?? "0");
  if (!Number.isFinite(contentLength) || contentLength > NOTIFICATION_MAX_REQUEST_BYTES) {
    return Option.none<string>();
  }
  // Chunked requests carry no content-length, so the reader itself is capped too.
  const body = yield* request.arrayBuffer.pipe(
    Effect.provideService(
      HttpIncomingMessage.MaxBodySize,
      ByteSize.bytes(NOTIFICATION_MAX_REQUEST_BYTES),
    ),
    Effect.option,
  );
  return Option.isNone(body) || body.value.byteLength > NOTIFICATION_MAX_REQUEST_BYTES
    ? Option.none<string>()
    : Option.some(new TextDecoder().decode(body.value));
});

const routeKeys = HttpRouter.params.pipe(
  Effect.map((params) => ({ source: params.source ?? "", sourceId: params.sourceId ?? "" })),
);

const upsertRoute = HttpRouter.add(
  "PUT",
  NOTIFICATION_ROUTE_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthNotificationsWriteScope);
    const raw = yield* readCappedBody;
    if (Option.isNone(raw)) return failure(413, "Request body is larger than 16 KiB.");
    const request = decodeUpsert(raw.value);
    if (Option.isNone(request)) return failure(400, "Invalid notification body.");
    const notifications = yield* NotificationService.NotificationService;
    return yield* notifications.upsert({ ...(yield* routeKeys), request: request.value }).pipe(
      Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
      Effect.catchTags({
        NotificationError: (error) => Effect.succeed(failure(statusFor(error), error.message)),
      }),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

const resolveRoute = HttpRouter.add(
  "POST",
  NOTIFICATION_RESOLVE_ROUTE_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthNotificationsWriteScope);
    const raw = yield* readCappedBody;
    if (Option.isNone(raw)) return failure(413, "Request body is larger than 16 KiB.");
    const request = decodeResolve(raw.value);
    if (Option.isNone(request)) return failure(400, "Invalid resolve body.");
    const notifications = yield* NotificationService.NotificationService;
    return yield* notifications.resolve({ ...(yield* routeKeys), request: request.value }).pipe(
      Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
      Effect.catchTags({
        NotificationError: (error) => Effect.succeed(failure(statusFor(error), error.message)),
      }),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const notificationRouteLayer = Layer.mergeAll(upsertRoute, resolveRoute);
