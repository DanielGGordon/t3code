import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthNotificationsWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { notificationRouteLayer } from "./http.ts";
import * as NotificationService from "./NotificationService.ts";

const NOTIFY_TOKEN = "notify-token";
const OPERATE_TOKEN = "operate-token";

const authenticateHttpRequest: EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"] =
  (request) => {
    const authorization = request.headers["authorization"] ?? "";
    const scopes =
      authorization === `Bearer ${NOTIFY_TOKEN}`
        ? [AuthNotificationsWriteScope]
        : authorization === `Bearer ${OPERATE_TOKEN}`
          ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
          : null;
    return scopes === null
      ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError())
      : Effect.succeed({
          sessionId: AuthSessionId.make("session-notifications-test"),
          subject: "alfred",
          method: "bearer-access-token" as const,
          scopes,
        });
  };
const auth = { authenticateHttpRequest } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

const send = (method: "PUT" | "POST", path: string, body: unknown, token?: string) =>
  new Request(`http://127.0.0.1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const card = {
  kind: "approval",
  title: "Slack message held",
  body: "text",
  bodyTrust: "external",
};

/** Real service over an in-memory database; one per test. */
const withRoutes = <A, E>(
  use: (call: (request: Request) => Effect.Effect<Response>) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      NotificationService.layer.pipe(
        Layer.provide(Layer.fresh(SqlitePersistence.layerMemory)),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { T3_NOTIFICATION_CALLBACK_ORIGINS: "http://127.0.0.1:8791" },
            }),
          ),
        ),
        Layer.provide(NodeServices.layer),
      ),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(
      notificationRouteLayer.pipe(Layer.provide(NodeServices.layer)),
      { disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
    const context = Context.add(services, EnvironmentAuth.EnvironmentAuth, auth);
    return yield* use((request) => Effect.promise(() => handler(request, context)));
  }).pipe(Effect.scoped);

const json = (response: Response) => Effect.promise(() => response.json() as Promise<unknown>);

it.effect("requires a notifications:write token", () =>
  withRoutes((call) =>
    Effect.gen(function* () {
      expect((yield* call(send("PUT", "/api/notifications/pps/h1", card))).status).toBe(401);
      const operate = yield* call(send("PUT", "/api/notifications/pps/h1", card, OPERATE_TOKEN));
      expect(operate.status).toBe(403);
      expect(
        (yield* call(
          send(
            "POST",
            "/api/notifications/pps/h1/resolve",
            { resolution: "external" },
            OPERATE_TOKEN,
          ),
        )).status,
      ).toBe(403);
      const ok = yield* call(send("PUT", "/api/notifications/pps/h1", card, NOTIFY_TOKEN));
      expect(ok.status).toBe(200);
      expect(yield* json(ok)).toEqual({ id: "pps:h1", state: "open" });
    }),
  ),
);

it.effect("enforces the body cap and field limits", () =>
  withRoutes((call) =>
    Effect.gen(function* () {
      const put = (body: unknown, path = "/api/notifications/pps/h1") =>
        call(send("PUT", path, body, NOTIFY_TOKEN));
      const tooLarge = yield* put({ ...card, body: "x".repeat(17 * 1024) });
      expect(tooLarge.status).toBe(413);
      expect(yield* json(tooLarge)).toEqual({ error: "Request body is larger than 16 KiB." });

      for (const body of [
        { ...card, title: "" },
        { ...card, title: "t".repeat(201) },
        { ...card, body: "b".repeat(2001) },
        { ...card, kind: "k".repeat(33) },
        { ...card, bodyTrust: "maybe" },
        { ...card, url: "javascript:alert(1)" },
        { ...card, expiresAt: "tomorrow" },
        {
          ...card,
          actions: [1, 2, 3, 4, 5].map((n) => ({ id: `a${n}`, label: "Go" })),
          callbackUrl: "http://127.0.0.1:8791/cb",
        },
        {
          ...card,
          actions: [{ id: "Bad Id", label: "Go" }],
          callbackUrl: "http://127.0.0.1:8791/cb",
        },
        "not json",
      ]) {
        const response = yield* put(body);
        expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
        expect(yield* json(response)).toHaveProperty("error");
      }
      expect((yield* put(card, `/api/notifications/${"s".repeat(33)}/h1`)).status).toBe(400);
      expect((yield* put(card, `/api/notifications/pps/${"i".repeat(65)}`)).status).toBe(400);

      const withLink = yield* put({
        ...card,
        url: "https://slack.com/archives/C1/p1",
        expiresAt: "2099-01-01T00:00:00Z",
        resolvedBy: "ignored-extra-field",
      });
      expect(withLink.status).toBe(200);
    }),
  ),
);

it.effect("rejects callback URLs outside the allowed origins", () =>
  withRoutes((call) =>
    Effect.gen(function* () {
      const actions = [{ id: "approve", label: "Approve", style: "primary" }];
      const foreign = yield* call(
        send(
          "PUT",
          "/api/notifications/pps/h1",
          { ...card, actions, callbackUrl: "http://127.0.0.1:9999/cb" },
          NOTIFY_TOKEN,
        ),
      );
      expect(foreign.status).toBe(400);
      expect(JSON.stringify(yield* json(foreign))).toContain("origin is not allowed");
      const allowed = yield* call(
        send(
          "PUT",
          "/api/notifications/pps/h1",
          { ...card, actions, callbackUrl: "http://127.0.0.1:8791/v1/t3/notifications/action" },
          NOTIFY_TOKEN,
        ),
      );
      expect(allowed.status).toBe(200);
    }),
  ),
);

it.effect("resolves idempotently, keeps it resolved, and 404s unknown ids", () =>
  withRoutes((call) =>
    Effect.gen(function* () {
      const resolve = (sourceId: string, body: unknown) =>
        call(send("POST", `/api/notifications/pps/${sourceId}/resolve`, body, NOTIFY_TOKEN));
      yield* call(send("PUT", "/api/notifications/pps/h1", card, NOTIFY_TOKEN));
      for (let attempt = 0; attempt < 2; attempt++) {
        const resolved = yield* resolve("h1", { resolution: "approve", resolvedBy: "alfred" });
        expect(resolved.status).toBe(200);
        expect(yield* json(resolved)).toEqual({ id: "pps:h1", state: "resolved" });
      }
      const reput = yield* call(send("PUT", "/api/notifications/pps/h1", card, NOTIFY_TOKEN));
      expect(yield* json(reput)).toEqual({ id: "pps:h1", state: "resolved" });

      const unknown = yield* resolve("nope", { resolution: "external" });
      expect(unknown.status).toBe(404);
      expect(yield* json(unknown)).toEqual({ error: "Notification not found." });
      expect((yield* resolve("h1", { resolution: "Not An Id" })).status).toBe(400);
    }),
  ),
);
