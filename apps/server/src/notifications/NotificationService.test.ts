// @effect-diagnostics-next-line nodeBuiltinImport:off -- a raw server stands in for the source's callback endpoint.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type NotificationError,
  NotificationId,
  type NotificationListResult,
  type NotificationUpsertRequest,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as NotificationService from "./NotificationService.ts";

const SECRET = "test-callback-secret";

interface ReceivedCallback {
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
  /** Answers the request; the server holds it open until then. */
  readonly respond: (status: number, body?: unknown) => void;
}

/** A local stand-in for the source's callback endpoint that hands each request to the test. */
const startCallbackServer = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{
        readonly origin: string;
        readonly url: string;
        readonly received: Array<ReceivedCallback>;
        readonly nextRequest: () => Promise<ReceivedCallback>;
        readonly server: NodeHttp.Server;
      }>((resolve) => {
        const received: Array<ReceivedCallback> = [];
        const unclaimed: Array<ReceivedCallback> = [];
        const waiters: Array<(request: ReceivedCallback) => void> = [];
        const server = NodeHttp.createServer((request, response) => {
          let body = "";
          request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
          request.on("end", () => {
            const callback: ReceivedCallback = {
              headers: request.headers,
              body,
              respond: (status, json) => {
                response.writeHead(status, { "content-type": "application/json" });
                response.end(json === undefined ? "" : JSON.stringify(json));
              },
            };
            received.push(callback);
            const waiter = waiters.shift();
            if (waiter) waiter(callback);
            else unclaimed.push(callback);
          });
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;
          const origin = `http://127.0.0.1:${port}`;
          resolve({
            origin,
            url: `${origin}/v1/t3/notifications/action`,
            received,
            nextRequest: () => {
              const pending = unclaimed.shift();
              return pending
                ? Promise.resolve(pending)
                : new Promise((resolveRequest) => waiters.push(resolveRequest));
            },
            server,
          });
        });
      }),
  ),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
);

const layerFor = (env: Record<string, string>) =>
  NotificationService.layer.pipe(
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Layer.provide(NodeServices.layer),
  );

const card = (overrides: Partial<NotificationUpsertRequest> = {}): NotificationUpsertRequest => ({
  kind: "approval",
  title: "Slack message held: Dan in #general",
  body: "hello <b>world</b>",
  bodyTrust: "external",
  ...overrides,
});

const actionsCard = (callbackUrl: string) =>
  card({
    actions: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "disapprove", label: "Disapprove", style: "danger" },
    ],
    callbackUrl,
  });

const failureOf = <A>(exit: Exit.Exit<A, NotificationError>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (error?._tag !== "Fail") throw new Error("expected a typed failure");
  return error.error;
};

const id = (value: string) => NotificationId.make(value);

it.effect("upserts idempotently and never exposes the callback URL", () =>
  Effect.gen(function* () {
    const service = yield* NotificationService.NotificationService;
    expect(
      yield* service.upsert({ source: "pps", sourceId: "h1", request: card({ title: "First" }) }),
    ).toEqual({ id: "pps:h1", state: "open" });
    yield* service.upsert({
      source: "pps",
      sourceId: "h1",
      request: { ...actionsCard("http://127.0.0.1:8791/cb"), title: "Second" },
    });
    const { notifications } = yield* service.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      id: "pps:h1",
      source: "pps",
      sourceId: "h1",
      title: "Second",
      body: "hello <b>world</b>",
      state: "open",
      resolution: null,
    });
    expect(notifications[0]?.actions.map((action) => action.id)).toEqual(["approve", "disapprove"]);
    expect(JSON.stringify(notifications)).not.toContain("8791");
  }).pipe(Effect.provide(layerFor({ T3_NOTIFICATION_CALLBACK_ORIGINS: "http://127.0.0.1:8791" }))),
);

it.effect("resolves idempotently and does not let a later upsert reopen it", () =>
  Effect.gen(function* () {
    const service = yield* NotificationService.NotificationService;
    yield* service.upsert({ source: "pps", sourceId: "h1", request: card() });
    const resolveExternal = service.resolve({
      source: "pps",
      sourceId: "h1",
      request: { resolution: "external", resolvedBy: "alfred" },
    });
    expect(yield* resolveExternal).toEqual({ id: "pps:h1", state: "resolved" });
    expect(yield* resolveExternal).toEqual({ id: "pps:h1", state: "resolved" });
    expect(
      yield* service.upsert({ source: "pps", sourceId: "h1", request: card({ title: "again" }) }),
    ).toEqual({ id: "pps:h1", state: "resolved" });
    expect((yield* service.list()).notifications).toEqual([]);
    // A second resolve does not overwrite the first resolution.
    yield* service.resolve({ source: "pps", sourceId: "h1", request: { resolution: "approve" } });
    expect(yield* service.dismiss({ id: id("pps:h1") })).toEqual({
      id: "pps:h1",
      state: "resolved",
      resolution: "external",
    });

    const unknown = yield* service
      .resolve({ source: "pps", sourceId: "nope", request: { resolution: "external" } })
      .pipe(Effect.exit);
    expect(failureOf(unknown).reason).toBe("not_found");
  }).pipe(Effect.provide(layerFor({}))),
);

it.effect("dismisses for every client without contacting the source", () =>
  Effect.gen(function* () {
    const callbacks = yield* startCallbackServer;
    yield* Effect.gen(function* () {
      const service = yield* NotificationService.NotificationService;
      yield* service.upsert({ source: "pps", sourceId: "h1", request: actionsCard(callbacks.url) });
      expect(yield* service.dismiss({ id: id("pps:h1") })).toEqual({
        id: "pps:h1",
        state: "resolved",
        resolution: "dismissed",
      });
      expect((yield* service.list()).notifications).toEqual([]);
      expect(callbacks.received).toHaveLength(0);
      const missing = yield* service.dismiss({ id: id("pps:missing") }).pipe(Effect.exit);
      expect(failureOf(missing).reason).toBe("not_found");
    }).pipe(
      Effect.provide(
        layerFor({
          T3_NOTIFICATION_CALLBACK_ORIGINS: callbacks.origin,
          T3_NOTIFICATION_CALLBACK_SECRET: SECRET,
        }),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("expires overdue notifications and prunes week-old resolved ones", () =>
  // Set the clock before the layer starts its sweep loop, or every 30 s step since 1970 would run.
  TestClock.setTime(Date.parse("2026-10-19T12:00:00.000Z")).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const service = yield* NotificationService.NotificationService;
        yield* service.upsert({
          source: "pps",
          sourceId: "soon",
          request: card({ expiresAt: "2026-10-19T14:01:00+02:00" }),
        });
        expect(
          yield* service.upsert({
            source: "pps",
            sourceId: "past",
            request: card({ expiresAt: "2026-10-19T11:00:00Z" }),
          }),
        ).toEqual({ id: "pps:past", state: "resolved" });
        expect((yield* service.list()).notifications.map((n) => [n.id, n.expiresAt])).toEqual([
          ["pps:soon", "2026-10-19T12:01:00.000Z"],
        ]);

        // The periodic sweep (every 30 s) expires it without anyone asking.
        yield* TestClock.adjust("90 seconds");
        expect((yield* service.list()).notifications).toEqual([]);
        expect(yield* service.dismiss({ id: id("pps:soon") })).toEqual({
          id: "pps:soon",
          state: "resolved",
          resolution: "expired",
        });

        // Backdate the resolution rather than advance the clock 8 days through the 30 s sweep loop.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE notifications SET resolved_at = '2026-10-11T00:00:00.000Z' WHERE notification_id = 'pps:soon'`;
        yield* service.sweep;
        expect(
          yield* service.resolve({
            source: "pps",
            sourceId: "past",
            request: { resolution: "external" },
          }),
        ).toEqual({ id: "pps:past", state: "resolved" });
        const pruned = yield* service
          .resolve({ source: "pps", sourceId: "soon", request: { resolution: "external" } })
          .pipe(Effect.exit);
        expect(failureOf(pruned).reason).toBe("not_found");
      }).pipe(Effect.provide(layerFor({}))),
    ),
  ),
);

it.effect("re-emits the open list to subscribers after every change", () =>
  Effect.gen(function* () {
    const service = yield* NotificationService.NotificationService;
    const emissions = yield* Queue.unbounded<NotificationListResult>();
    yield* service.subscribeList().pipe(
      Stream.runForEach((list) => Queue.offer(emissions, list)),
      Effect.forkScoped,
    );
    const nextIds = Queue.take(emissions).pipe(
      Effect.map((list) => list.notifications.map((notification) => notification.id)),
    );
    expect(yield* nextIds).toEqual([]);
    yield* service.upsert({ source: "pps", sourceId: "h1", request: card() });
    expect(yield* nextIds).toEqual(["pps:h1"]);
    yield* service.dismiss({ id: id("pps:h1") });
    expect(yield* nextIds).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(layerFor({}))),
);

it.effect("rejects invalid keys, duplicate actions and unlisted callback origins", () =>
  Effect.gen(function* () {
    const service = yield* NotificationService.NotificationService;
    const reasonOf = (input: Parameters<typeof service.upsert>[0]) =>
      service.upsert(input).pipe(
        Effect.exit,
        Effect.map((exit) => failureOf(exit)),
      );
    expect(
      (yield* reasonOf({ source: "x".repeat(33), sourceId: "a", request: card() })).reason,
    ).toBe("invalid_request");
    expect((yield* reasonOf({ source: "pps", sourceId: "a b", request: card() })).reason).toBe(
      "invalid_request",
    );
    const noCallback = yield* reasonOf({
      source: "pps",
      sourceId: "a",
      request: card({ actions: [{ id: "approve", label: "Approve" }] }),
    });
    expect(noCallback.message).toContain("callbackUrl is required");
    const duplicate = yield* reasonOf({
      source: "pps",
      sourceId: "a",
      request: card({
        actions: [
          { id: "approve", label: "A" },
          { id: "approve", label: "B" },
        ],
        callbackUrl: "http://127.0.0.1:8791/cb",
      }),
    });
    expect(duplicate.message).toContain("unique");
    const foreign = yield* reasonOf({
      source: "pps",
      sourceId: "a",
      request: actionsCard("http://127.0.0.1:9999/cb"),
    });
    expect(foreign.message).toContain("origin is not allowed");
    // Without actions the callback URL is not needed and is ignored.
    expect(
      yield* service.upsert({
        source: "pps",
        sourceId: "plain",
        request: card({ callbackUrl: "http://evil.example/cb" }),
      }),
    ).toEqual({ id: "pps:plain", state: "open" });
  }).pipe(
    Effect.provide(layerFor({ T3_NOTIFICATION_CALLBACK_ORIGINS: " http://127.0.0.1:8791/ , " })),
  ),
);

it.effect("rejects every notification with actions when no callback origins are configured", () =>
  Effect.gen(function* () {
    const service = yield* NotificationService.NotificationService;
    const exit = yield* service
      .upsert({ source: "pps", sourceId: "a", request: actionsCard("http://127.0.0.1:8791/cb") })
      .pipe(Effect.exit);
    expect(failureOf(exit).reason).toBe("invalid_request");
  }).pipe(Effect.provide(layerFor({}))),
);

it.effect("delivers a signed action and resolves when the source accepts it", () =>
  Effect.gen(function* () {
    const callbacks = yield* startCallbackServer;
    yield* TestClock.setTime(Date.parse("2026-10-19T12:00:00.000Z"));
    yield* Effect.gen(function* () {
      const service = yield* NotificationService.NotificationService;
      yield* service.upsert({ source: "pps", sourceId: "h1", request: actionsCard(callbacks.url) });
      const acting = yield* service
        .act({ id: id("pps:h1"), actionId: "approve" })
        .pipe(Effect.forkScoped);
      const request = yield* Effect.promise(() => callbacks.nextRequest());
      request.respond(200, { ok: true });
      expect(yield* Fiber.join(acting)).toEqual({
        id: "pps:h1",
        state: "resolved",
        resolution: "approve",
      });

      expect(JSON.parse(request.body)).toEqual({
        notificationId: "pps:h1",
        source: "pps",
        sourceId: "h1",
        actionId: "approve",
        actedAt: "2026-10-19T12:00:00.000Z",
      });
      expect(request.headers["content-type"]).toContain("application/json");
      const signature = request.headers["x-t3-signature"];
      const timestamp = Math.floor(Date.parse("2026-10-19T12:00:00.000Z") / 1000);
      expect(signature).toBe(
        NotificationService.signNotificationCallback(SECRET, timestamp, request.body),
      );
      expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

      // Acting again on a resolved notification reports it without a second delivery.
      expect(yield* service.act({ id: id("pps:h1"), actionId: "disapprove" })).toEqual({
        id: "pps:h1",
        state: "resolved",
        resolution: "approve",
      });
      expect(callbacks.received).toHaveLength(1);
    }).pipe(
      Effect.provide(
        layerFor({
          T3_NOTIFICATION_CALLBACK_ORIGINS: callbacks.origin,
          T3_NOTIFICATION_CALLBACK_SECRET: SECRET,
        }),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("treats a source's already_resolved answer as resolved elsewhere", () =>
  Effect.gen(function* () {
    const callbacks = yield* startCallbackServer;
    yield* Effect.gen(function* () {
      const service = yield* NotificationService.NotificationService;
      yield* service.upsert({ source: "pps", sourceId: "h1", request: actionsCard(callbacks.url) });
      const acting = yield* service
        .act({ id: id("pps:h1"), actionId: "approve" })
        .pipe(Effect.forkScoped);
      (yield* Effect.promise(() => callbacks.nextRequest())).respond(409, {
        status: "already_resolved",
      });
      expect(yield* Fiber.join(acting)).toEqual({
        id: "pps:h1",
        state: "resolved",
        resolution: "external",
      });
    }).pipe(
      Effect.provide(
        layerFor({
          T3_NOTIFICATION_CALLBACK_ORIGINS: callbacks.origin,
          T3_NOTIFICATION_CALLBACK_SECRET: SECRET,
        }),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("keeps the notification open when delivery fails or times out", () =>
  Effect.gen(function* () {
    const callbacks = yield* startCallbackServer;
    yield* Effect.gen(function* () {
      const service = yield* NotificationService.NotificationService;
      yield* service.upsert({ source: "pps", sourceId: "h1", request: actionsCard(callbacks.url) });

      const failing = yield* service
        .act({ id: id("pps:h1"), actionId: "approve" })
        .pipe(Effect.exit, Effect.forkScoped);
      (yield* Effect.promise(() => callbacks.nextRequest())).respond(500, { error: "boom" });
      const failed = failureOf(yield* Fiber.join(failing));
      expect(failed.reason).toBe("delivery_failed");
      expect(failed.message).toBe("Could not deliver 'Approve' — try again.");

      // A 404 without the already_resolved marker is a failure, not a resolution.
      const missingRoute = yield* service
        .act({ id: id("pps:h1"), actionId: "approve" })
        .pipe(Effect.exit, Effect.forkScoped);
      (yield* Effect.promise(() => callbacks.nextRequest())).respond(404);
      expect(failureOf(yield* Fiber.join(missingRoute)).reason).toBe("delivery_failed");

      const hanging = yield* service
        .act({ id: id("pps:h1"), actionId: "approve" })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.promise(() => callbacks.nextRequest());
      yield* TestClock.adjust("5 seconds");
      expect(failureOf(yield* Fiber.join(hanging)).reason).toBe("delivery_failed");

      expect((yield* service.list()).notifications.map((n) => n.state)).toEqual(["open"]);
    }).pipe(
      Effect.provide(
        layerFor({
          T3_NOTIFICATION_CALLBACK_ORIGINS: callbacks.origin,
          T3_NOTIFICATION_CALLBACK_SECRET: SECRET,
        }),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("refuses a second click while the first is being delivered", () =>
  Effect.gen(function* () {
    const callbacks = yield* startCallbackServer;
    yield* Effect.gen(function* () {
      const service = yield* NotificationService.NotificationService;
      yield* service.upsert({ source: "pps", sourceId: "h1", request: actionsCard(callbacks.url) });
      const first = yield* service
        .act({ id: id("pps:h1"), actionId: "approve" })
        .pipe(Effect.forkScoped);
      const request = yield* Effect.promise(() => callbacks.nextRequest());
      const second = yield* service
        .act({ id: id("pps:h1"), actionId: "disapprove" })
        .pipe(Effect.exit);
      expect(failureOf(second).reason).toBe("in_flight");
      request.respond(204);
      expect((yield* Fiber.join(first)).resolution).toBe("approve");
      expect(callbacks.received).toHaveLength(1);
    }).pipe(
      Effect.provide(
        layerFor({
          T3_NOTIFICATION_CALLBACK_ORIGINS: callbacks.origin,
          T3_NOTIFICATION_CALLBACK_SECRET: SECRET,
        }),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("fails acting clearly when no callback secret is configured", () =>
  Effect.gen(function* () {
    const service = yield* NotificationService.NotificationService;
    yield* service.upsert({
      source: "pps",
      sourceId: "h1",
      request: actionsCard("http://127.0.0.1:8791/cb"),
    });
    const noSecret = yield* service
      .act({ id: id("pps:h1"), actionId: "approve" })
      .pipe(Effect.exit);
    expect(failureOf(noSecret).reason).toBe("not_configured");
    const unknownAction = yield* service
      .act({ id: id("pps:h1"), actionId: "maybe" })
      .pipe(Effect.exit);
    expect(failureOf(unknownAction).reason).toBe("unknown_action");
    expect((yield* service.list()).notifications).toHaveLength(1);
  }).pipe(Effect.provide(layerFor({ T3_NOTIFICATION_CALLBACK_ORIGINS: "http://127.0.0.1:8791" }))),
);
