/**
 * Out-of-band alerts for security-relevant session events: a device pairing,
 * or a known session connecting from an address it has never used.
 *
 * Every alert is written to the server log. Delivery beyond the log is opt-in
 * through the environment and off when both are unset:
 *
 * - `T3CODE_SECURITY_ALERT_WEBHOOK_URL`: POSTs `{"text": "<alert>"}`, the body
 *   a Slack incoming webhook accepts.
 * - `T3CODE_SECURITY_ALERT_COMMAND`: runs through the system shell with the
 *   alert in `$T3CODE_SECURITY_ALERT_TEXT`, e.g.
 *   `slack-send C0123 "$T3CODE_SECURITY_ALERT_TEXT"`.
 *
 * Inside a running server every alert also becomes a card in the notification
 * bell (source `security`), independent of those two settings.
 *
 * Delivery runs in the background so it never delays a pairing or a connect,
 * and a failing endpoint is logged (throttled) and otherwise ignored.
 */
import type {
  AuthClientMetadata,
  AuthSessionId,
  ServerAuthSessionMethod,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { NotificationService } from "../notifications/NotificationService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { makeLogThrottle } from "./logThrottle.ts";

const SECURITY_ALERT_TEXT_ENV = "T3CODE_SECURITY_ALERT_TEXT";

const SecurityAlertsConfig = Config.all({
  webhookUrl: Config.Redacted("T3CODE_SECURITY_ALERT_WEBHOOK_URL").pipe(Config.option),
  command: Config.String("T3CODE_SECURITY_ALERT_COMMAND").pipe(Config.option),
});

const DELIVERY_TIMEOUT = Duration.seconds(15);

interface SecurityAlertSession {
  readonly sessionId: AuthSessionId;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
}

export type SecurityAlert =
  | ({ readonly kind: "session-paired" } & SecurityAlertSession)
  | ({ readonly kind: "new-client-ip"; readonly previousIp: string } & SecurityAlertSession);

export class SecurityAlerts extends Context.Service<
  SecurityAlerts,
  {
    /**
     * Logs the alert and starts delivering it in the background. Returns the
     * delivery fiber: request paths ignore it, tests join it. Never fails.
     */
    readonly notify: (alert: SecurityAlert) => Effect.Effect<Fiber.Fiber<void>>;
  }
>()("t3/auth/SecurityAlerts") {}

// Labels and user agents come from the client, so keep them on one line, short,
// and unable to inject Slack markup such as `<!channel>` or links.
function clean(value: string | undefined, maxLength = 120): string | undefined {
  if (value === undefined) return undefined;
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length === 0) return undefined;
  const bounded =
    singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine;
  return bounded.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatSecurityAlert(alert: SecurityAlert, host: string): string {
  const { client } = alert;
  const device = [
    clean(client.label) ? `"${clean(client.label)}"` : "unlabeled",
    [client.deviceType, clean(client.os), clean(client.browser)]
      .filter((part) => part !== undefined)
      .join(", "),
  ].join(" — ");
  const ip = clean(client.ipAddress) ?? "unknown";
  const lines =
    alert.kind === "session-paired"
      ? [
          `:rotating_light: *T3 Code security* (${clean(host)}): a new device paired.`,
          `• Device: ${device}`,
          `• IP: ${ip}`,
        ]
      : [
          `:warning: *T3 Code security* (${clean(host)}): a known session connected from a new IP.`,
          `• Device: ${device}`,
          `• IP: ${ip} (previously ${clean(alert.previousIp) ?? "unknown"})`,
        ];
  return [
    ...lines,
    `• Session: ${alert.sessionId.slice(0, 8)} (${alert.method})`,
    `• User agent: ${clean(client.userAgent, 200) ?? "unknown"}`,
    "Not you? Revoke it in Settings → Connections.",
  ].join("\n");
}

/**
 * Plain-text card for the in-app notification bell. Unlike the Slack text it has
 * no markup, so client-supplied labels need no escaping beyond `clean`'s trimming.
 */
export function formatSecurityNotification(alert: SecurityAlert, host: string) {
  const { client } = alert;
  const device = [
    clean(client.label) ? `"${clean(client.label)}"` : "unlabeled",
    [client.deviceType, clean(client.os), clean(client.browser)]
      .filter((part) => part !== undefined)
      .join(", "),
  ].join(" — ");
  const ip = clean(client.ipAddress) ?? "unknown";
  const paired = alert.kind === "session-paired";
  return {
    title: paired ? "New device connected to T3 Code" : "T3 Code session connected from a new IP",
    body: [
      `Device: ${device}`,
      paired ? `IP: ${ip}` : `IP: ${ip} (previously ${clean(alert.previousIp) ?? "unknown"})`,
      `Session: ${alert.sessionId.slice(0, 8)} (${alert.method}) on ${clean(host)}`,
      "Not you? Revoke it in Settings → Connections.",
    ].join("\n"),
  };
}

// Pairing is one card per session. A new-IP alert can repeat for the same
// session, and a resolved card is never reopened, so each gets its own id.
const notificationSourceId = (alert: SecurityAlert, nowMillis: number) =>
  alert.kind === "session-paired"
    ? `paired-${alert.sessionId}`
    : `new-ip-${alert.sessionId}-${nowMillis}`;

function shellInvocation(command: string, platform: NodeJS.Platform, comSpec: string | undefined) {
  return platform === "win32"
    ? { command: comSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] }
    : { command: "/bin/sh", args: ["-c", command] };
}

const make = Effect.gen(function* () {
  const config = yield* SecurityAlertsConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const scope = yield* Effect.scope;
  const host = yield* HostProcess.Hostname;
  const platform = yield* HostProcess.Platform;
  const comSpec = (yield* HostProcess.Environment).ComSpec;
  // Absent in CLI processes that build the auth layer without a running server.
  const notifications = yield* Effect.serviceOption(NotificationService);
  // A dead endpoint must not turn every connect into a log line.
  const shouldLogFailure = makeLogThrottle({
    windowMs: Duration.toMillis(Duration.minutes(10)),
    maxKeys: 10,
  });

  const logDeliveryFailure = (channel: "webhook" | "command" | "notification", reason: string) =>
    Effect.gen(function* () {
      const decision = shouldLogFailure(channel, yield* Clock.currentTimeMillis);
      if (!decision.log) return;
      yield* Effect.logWarning(
        [
          "Security alert delivery failed.",
          `channel=${channel}`,
          `reason="${reason}"`,
          ...(decision.suppressed > 0 ? [`failures_suppressed=${decision.suppressed}`] : []),
        ].join(" "),
      );
    });

  const postWebhook = (url: string, text: string) =>
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson({ text }),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeout(DELIVERY_TIMEOUT),
      Effect.asVoid,
      // Error messages embed the URL, which carries the webhook's secret: log
      // only the failure kind.
      Effect.catch((error) =>
        logDeliveryFailure(
          "webhook",
          error._tag !== "HttpClientError"
            ? error._tag
            : error.reason._tag === "StatusCodeError"
              ? `status ${error.reason.response.status}`
              : error.reason._tag,
        ),
      ),
      Effect.catchDefect(() => logDeliveryFailure("webhook", "defect")),
    );

  const runCommand = (command: string, text: string) =>
    processRunner
      .run({
        ...shellInvocation(command, platform, comSpec),
        // Passed in the environment, not on stdin: a command that never reads
        // stdin (like slack-send) would make the write fail with EPIPE.
        env: { [SECURITY_ALERT_TEXT_ENV]: text },
        timeout: DELIVERY_TIMEOUT,
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.flatMap((output) =>
          output.code === 0
            ? Effect.void
            : logDeliveryFailure("command", `exit code ${output.code ?? "unknown"}`),
        ),
        Effect.catch((error) => logDeliveryFailure("command", error._tag)),
        Effect.catchDefect(() => logDeliveryFailure("command", "defect")),
      );

  const deliver = (text: string) =>
    Effect.all(
      [
        Option.match(config.webhookUrl, {
          onNone: () => Effect.void,
          onSome: (url) => postWebhook(Redacted.value(url), text),
        }),
        Option.match(config.command, {
          onNone: () => Effect.void,
          onSome: (command) => runCommand(command, text),
        }),
      ],
      { concurrency: "unbounded", discard: true },
    );

  const postNotification = (alert: SecurityAlert) =>
    Option.match(notifications, {
      onNone: () => Effect.void,
      onSome: (service) =>
        Effect.gen(function* () {
          const card = formatSecurityNotification(alert, host);
          yield* service.upsert({
            source: "security",
            sourceId: notificationSourceId(alert, yield* Clock.currentTimeMillis),
            request: { kind: "security", ...card, bodyTrust: "external" },
          });
        }).pipe(
          Effect.catch((error) => logDeliveryFailure("notification", error._tag)),
          Effect.catchDefect(() => logDeliveryFailure("notification", "defect")),
        ),
    });

  const notify: SecurityAlerts["Service"]["notify"] = (alert) => {
    const text = formatSecurityAlert(alert, host);
    return Effect.logWarning(`Security alert: ${text.replace(/\n/g, " ")}`).pipe(
      Effect.andThen(
        Effect.forkIn(
          Effect.all([deliver(text), postNotification(alert)], {
            concurrency: "unbounded",
            discard: true,
          }),
          scope,
        ),
      ),
    );
  };

  return SecurityAlerts.of({ notify });
});

export const layer = Layer.effect(SecurityAlerts, make).pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provide(FetchHttpClient.layer),
);
