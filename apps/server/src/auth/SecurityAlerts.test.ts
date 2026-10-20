// @effect-diagnostics-next-line nodeBuiltinImport:off -- a raw server stands in for the remote webhook endpoint.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import { NotificationService } from "../notifications/NotificationService.ts";
import * as SecurityAlerts from "./SecurityAlerts.ts";

const layerSecurityAlerts = (env: Record<string, string>) =>
  SecurityAlerts.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

const pairedAlert: SecurityAlerts.SecurityAlert = {
  kind: "session-paired",
  sessionId: AuthSessionId.make("1a2b3c4d-0000-4000-8000-000000000000"),
  method: "browser-session-cookie",
  client: {
    label: "Dan's <!channel> phone",
    ipAddress: "203.0.113.7",
    userAgent: "Mozilla/5.0 (iPhone)",
    deviceType: "mobile",
    os: "iOS",
    browser: "Safari",
  },
};

// A local stand-in for a Slack incoming webhook; resolves with each request body.
const startWebhook = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{
        readonly url: string;
        readonly bodies: Array<string>;
        server: NodeHttp.Server;
      }>((resolve) => {
        const bodies: Array<string> = [];
        const server = NodeHttp.createServer((request, response) => {
          let body = "";
          request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
          request.on("end", () => {
            bodies.push(body);
            response.writeHead(200).end("ok");
          });
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;
          resolve({ url: `http://127.0.0.1:${port}/hook`, bodies, server });
        });
      }),
  ),
  ({ server }) =>
    Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
);

it.layer(NodeServices.layer)("SecurityAlerts", (it) => {
  it.effect("formats a pairing alert without letting client text inject Slack markup", () =>
    Effect.sync(() => {
      expect(SecurityAlerts.formatSecurityAlert(pairedAlert, "t3-host")).toBe(
        [
          ":rotating_light: *T3 Code security* (t3-host): a new device paired.",
          '• Device: "Dan\'s &lt;!channel&gt; phone" — mobile, iOS, Safari',
          "• IP: 203.0.113.7",
          "• Session: 1a2b3c4d (browser-session-cookie)",
          "• User agent: Mozilla/5.0 (iPhone)",
          "Not you? Revoke it in Settings → Connections.",
        ].join("\n"),
      );
      expect(
        SecurityAlerts.formatSecurityAlert(
          {
            kind: "new-client-ip",
            sessionId: pairedAlert.sessionId,
            method: "bearer-access-token",
            client: { deviceType: "unknown", ipAddress: "198.51.100.4" },
            previousIp: "203.0.113.7",
          },
          "t3-host",
        ).split("\n"),
      ).toEqual([
        ":warning: *T3 Code security* (t3-host): a known session connected from a new IP.",
        "• Device: unlabeled — unknown",
        "• IP: 198.51.100.4 (previously 203.0.113.7)",
        "• Session: 1a2b3c4d (bearer-access-token)",
        "• User agent: unknown",
        "Not you? Revoke it in Settings → Connections.",
      ]);
    }),
  );

  it.effect("delivers the alert to the configured webhook and command", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-security-alert-" });
      const outputPath = `${directory}/alert.txt`;
      const webhook = yield* startWebhook;

      // Join inside the layer: closing it interrupts in-flight deliveries.
      yield* Effect.gen(function* () {
        const alerts = yield* SecurityAlerts.SecurityAlerts;
        yield* Fiber.join(yield* alerts.notify(pairedAlert));
      }).pipe(
        Effect.provide(
          layerSecurityAlerts({
            T3CODE_SECURITY_ALERT_WEBHOOK_URL: webhook.url,
            T3CODE_SECURITY_ALERT_COMMAND: `printf '%s' "$T3CODE_SECURITY_ALERT_TEXT" > '${outputPath}'`,
          }),
        ),
      );

      const delivered = yield* fileSystem.readFileString(outputPath);
      expect(delivered).toContain("a new device paired.");
      expect(delivered).toContain("• IP: 203.0.113.7");
      expect(webhook.bodies.map((body) => JSON.parse(body))).toEqual([{ text: delivered }]);
    }).pipe(Effect.scoped),
  );

  it.effect("logs a failed delivery without failing or leaking the webhook URL", () => {
    const warnings: Array<string> = [];
    const logger = Logger.make(({ logLevel, message }) => {
      const line = Array.isArray(message) ? message[0] : message;
      if (logLevel === "Warn" && typeof line === "string") warnings.push(line);
    });
    return Effect.gen(function* () {
      const alerts = yield* SecurityAlerts.SecurityAlerts;
      const delivery = yield* alerts.notify(pairedAlert);
      // Joining succeeds: delivery failures never reach the caller.
      yield* Fiber.join(delivery);

      const failures = warnings.filter((line) =>
        line.startsWith("Security alert delivery failed."),
      );
      expect(failures.toSorted()).toEqual([
        'Security alert delivery failed. channel=command reason="exit code 3"',
        'Security alert delivery failed. channel=webhook reason="TransportError"',
      ]);
      expect(warnings.join("\n")).not.toContain("secret-token");
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerSecurityAlerts({
            // Nothing listens on port 1, so the POST is refused.
            T3CODE_SECURITY_ALERT_WEBHOOK_URL: "http://127.0.0.1:1/hooks/secret-token",
            T3CODE_SECURITY_ALERT_COMMAND: "exit 3",
          }),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("raises a notification card for pairing and for each new IP", () => {
    type UpsertInput = Parameters<NotificationService["Service"]["upsert"]>[0];
    const upserts: Array<UpsertInput> = [];
    const notifications = Layer.succeed(
      NotificationService,
      NotificationService.of({
        upsert: (input: UpsertInput) =>
          Effect.sync(() => {
            upserts.push(input);
            return { id: `${input.source}:${input.sourceId}` as never, state: "open" as const };
          }),
      } as never),
    );
    return Effect.gen(function* () {
      const alerts = yield* SecurityAlerts.SecurityAlerts;
      yield* Fiber.join(yield* alerts.notify(pairedAlert));
      yield* Fiber.join(
        yield* alerts.notify({
          kind: "new-client-ip",
          sessionId: pairedAlert.sessionId,
          method: "bearer-access-token",
          client: { deviceType: "unknown", ipAddress: "198.51.100.4" },
          previousIp: "203.0.113.7",
        }),
      );

      expect(upserts.map(({ source, sourceId }) => [source, sourceId.split("-")[0]])).toEqual([
        ["security", "paired"],
        ["security", "new"],
      ]);
      expect(upserts[0]?.sourceId).toBe(`paired-${pairedAlert.sessionId}`);
      expect(upserts[0]?.request).toEqual({
        kind: "security",
        title: "New device connected to T3 Code",
        body: expect.stringContaining(
          'Device: "Dan\'s &lt;!channel&gt; phone" — mobile, iOS, Safari',
        ),
        bodyTrust: "external",
      });
      expect(upserts[1]?.request.title).toBe("T3 Code session connected from a new IP");
      expect(upserts[1]?.request.body).toContain("IP: 198.51.100.4 (previously 203.0.113.7)");
    }).pipe(Effect.provide(Layer.provideMerge(layerSecurityAlerts({}), notifications)));
  });
});
