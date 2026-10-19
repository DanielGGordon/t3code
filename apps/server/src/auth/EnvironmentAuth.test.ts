import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  authScopeResponse,
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { totp } from "./totp.ts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PersistenceErrors from "../persistence/Errors.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

/** Pinned so dev-mode cookie tests can assert the port-scoped name. */
const TEST_SERVER_PORT = 13_773;
const isPairingCredentialIssueError = Schema.is(PairingGrantStore.PairingCredentialIssueError);
const isPersistenceSqlError = Schema.is(PersistenceErrors.PersistenceSqlError);

const layerServerConfig = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
        // Keep the test server deterministic even when the default test layer
        // changes its development port.
        port: TEST_SERVER_PORT,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-server-test-" })));

const layerEnvironmentAuth = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerServerConfig(overrides)),
  );

const makeCookieRequest = (
  cookieName: string,
  sessionToken: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {
      [cookieName]: sessionToken,
    },
    headers: {},
  }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

const makeBearerRequest = (
  token: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {},
    headers: {
      authorization: `Bearer ${token}`,
    },
  }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

/** A device paired remotely: a pairing code exchanged for a bearer token. */
const pairBearer = (auth: EnvironmentAuth.EnvironmentAuth["Service"]) =>
  Effect.gen(function* () {
    const pairing = yield* auth.issuePairingCredential({ scopes: AuthAdministrativeScopes });
    const exchanged = yield* auth.exchangeBootstrapCredentialForAccessToken(
      pairing.credential,
      undefined,
      requestMetadata,
    );
    return { token: exchanged.access_token };
  });

/** Enrolls the environment's authenticator from `sessionId`; returns the recovery codes. */
const enrollTwoFactor = (
  sessions: SessionStore.SessionStore["Service"],
  sessionId: Parameters<SessionStore.SessionStore["Service"]["twoFactor"]["begin"]>[0],
) =>
  Effect.gen(function* () {
    const setup = yield* sessions.twoFactor.begin(sessionId);
    const bits = [...setup.secret]
      .map((c) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0"))
      .join("");
    const secret = Buffer.from(bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2)));
    const code = totp(secret, Math.floor((yield* Clock.currentTimeMillis) / 30_000));
    return (yield* sessions.twoFactor.confirm(sessionId, code)).recoveryCodes;
  });

it.layer(NodeServices.layer)("EnvironmentAuth.layer", (it) => {
  it.effect("uses the reusable dev cookie without overriding a normal scoped cookie", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const devExchange = yield* serverAuth.createBrowserSession(token, requestMetadata);
      const pairing = yield* serverAuth.issuePairingCredential({ scopes: ["orchestration:read"] });
      const scopedExchange = yield* serverAuth.createBrowserSession(
        pairing.credential,
        requestMetadata,
      );
      const request = {
        cookies: {
          [sessions.cookieName]: scopedExchange.sessionToken,
          [devExchange.cookieName ?? "missing"]: devExchange.sessionToken,
        },
        headers: {},
      } as unknown as Parameters<
        EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
      >[0];

      const authenticated = yield* serverAuth.authenticateHttpRequest(request);
      expect(devExchange.cookieName).toMatch(/^t3_dev_session_/);
      expect(devExchange.expireNormalCookie).toBe(true);
      expect(devExchange.response).toMatchObject(authScopeResponse(AuthAdministrativeScopes));
      expect(authenticated.scopes).toEqual(["orchestration:read"]);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("does not fall back to the dev cookie after a normal cookie is rejected", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const devExchange = yield* serverAuth.createBrowserSession(token, requestMetadata);
      const pairing = yield* serverAuth.issuePairingCredential({ scopes: ["orchestration:read"] });
      const scopedExchange = yield* serverAuth.createBrowserSession(
        pairing.credential,
        requestMetadata,
      );
      const scoped = yield* sessions.verify(scopedExchange.sessionToken);
      yield* sessions.revoke(scoped.sessionId);
      const request = {
        cookies: {
          [sessions.cookieName]: scopedExchange.sessionToken,
          [devExchange.cookieName ?? "missing"]: devExchange.sessionToken,
        },
        headers: {},
      } as unknown as Parameters<
        EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
      >[0];

      const error = yield* Effect.flip(serverAuth.authenticateHttpRequest(request));
      expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("does not use the dev cookie when Authorization is invalid or empty", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const devExchange = yield* serverAuth.createBrowserSession(token, requestMetadata);
      for (const authorization of ["Bearer invalid", ""] as const) {
        const request = {
          cookies: { [devExchange.cookieName ?? "missing"]: devExchange.sessionToken },
          headers: { authorization },
        } as unknown as Parameters<
          EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
        >[0];
        const error = yield* Effect.flip(serverAuth.authenticateHttpRequest(request));
        expect(EnvironmentAuth.isServerAuthCredentialError(error)).toBe(true);
      }
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("exchanges the reusable dev token for a local scoped OAuth session", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const exchanged = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        token,
        ["orchestration:read"],
        requestMetadata,
      );

      expect(exchanged.access_token).not.toBe(token);
      expect(exchanged.scope).toBe("orchestration:read");
      const dpop = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        token,
        ["orchestration:read"],
        requestMetadata,
        { proofKeyThumbprint: "test-proof-key" },
      );
      expect(dpop.access_token).not.toBe(token);
      expect(dpop.access_token).not.toBe(exchanged.access_token);
      expect(dpop.token_type).toBe("DPoP");
      expect(dpop.scope).toBe("orchestration:read");

      const secondBearer = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        token,
        ["orchestration:read"],
        requestMetadata,
      );
      const firstSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(exchanged.access_token),
      );
      const secondSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(secondBearer.access_token),
      );
      expect(firstSession.subject).toBe("reusable-dev-token-child");
      expect(secondSession.subject).toBe("reusable-dev-token-child");
      expect((yield* sessions.verify(token)).subject).toBe("reusable-dev-token");
      const before = yield* serverAuth.listClientSessions(firstSession.sessionId);
      const denied = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(token, ["review:write"], requestMetadata)
        .pipe(Effect.flip);
      expect(denied._tag).toBe("ServerAuthScopeNotGrantedError");
      const empty = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(token, [], requestMetadata)
        .pipe(Effect.flip);
      expect(empty._tag).toBe("ServerAuthScopeNotGrantedError");
      expect(yield* serverAuth.listClientSessions(firstSession.sessionId)).toEqual(before);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("uses a one-time startup credential after local dev token revocation", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const initial = yield* serverAuth.issueStartupPairingCredential();
      const seeded = yield* sessions.verify(token);

      yield* sessions.revoke(seeded.sessionId);
      const recovery = yield* serverAuth.issueStartupPairingCredential();

      expect(initial.credential).toBe(token);
      expect(recovery.credential).not.toBe(token);
      expect((yield* Effect.flip(sessions.verify(token)))._tag).toBe("SessionTokenRevokedError");
      expect(
        (yield* serverAuth.createBrowserSession(recovery.credential, requestMetadata)).response,
      ).toMatchObject({ authenticated: true, ...authScopeResponse(AuthAdministrativeScopes) });
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("keeps the pairing issue error as the immediate recovery failure", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* SqlClient.SqlClient;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const seeded = yield* sessions.verify(token);

      yield* sessions.revoke(seeded.sessionId);
      yield* sql`
        CREATE TRIGGER reject_startup_pairing_link
        BEFORE INSERT ON auth_pairing_links
        BEGIN
          SELECT RAISE(ABORT, 'startup pairing insert rejected');
        END
      `;

      const error = yield* Effect.flip(serverAuth.issueStartupPairingCredential());

      expect(error._tag).toBe("ServerAuthPairingLinkCreationError");
      expect(isPairingCredentialIssueError(error.cause)).toBe(true);
      if (isPairingCredentialIssueError(error.cause)) {
        expect(isPersistenceSqlError(error.cause.cause)).toBe(true);
      }
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
        }),
      ),
    ),
  );

  it.effect("classifies invalid bootstrap credential failures for the HTTP boundary", () =>
    Effect.sync(() => {
      const error = EnvironmentAuth.toBootstrapExchangeError(
        new PairingGrantStore.UnknownBootstrapCredentialError({}),
      );

      expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    }),
  );

  it.effect("maps unexpected bootstrap failures to 500", () =>
    Effect.sync(() => {
      const cause = new PairingGrantStore.BootstrapCredentialConsumeError({
        cause: new Error("sqlite is unavailable"),
      });
      const error = EnvironmentAuth.toBootstrapExchangeError(cause);

      expect(error._tag).toBe("ServerAuthBootstrapCredentialValidationError");
      expect(error.message).toBe("Failed to validate bootstrap credential.");
      if (error._tag === "ServerAuthBootstrapCredentialValidationError") {
        expect(error.cause).toBe(cause);
      }
    }),
  );

  it.effect("issues standard pairing credentials by default", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;

      const pairingCredential = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.createBrowserSession(
        pairingCredential.credential,
        requestMetadata,
      );
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(sessions.cookieName, exchanged.sessionToken),
      );

      expect(verified.sessionId.length).toBeGreaterThan(0);
      expect(verified.scopes).toEqual(AuthStandardClientScopes);
      expect(verified.subject).toBe("one-time-token");
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("prefers a bearer token over a stale legacy cookie", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const bearer = yield* serverAuth.issueSession();
      const verified = yield* serverAuth.authenticateHttpRequest({
        cookies: { [sessions.legacyCookieName ?? "t3_session"]: "stale" },
        headers: { authorization: `Bearer ${bearer.token}` },
      } as never);

      expect(verified.sessionId).toBe(bearer.sessionId);
    }).pipe(Effect.provide(layerEnvironmentAuth({ mode: "web", host: "192.168.1.50" }))),
  );

  it.effect("logs a revoked credential's retries once per window with its client address", () => {
    const warnings: Array<string> = [];
    const logger = Logger.make(({ logLevel, message }) => {
      const line = Array.isArray(message) ? message[0] : message;
      if (logLevel === "Warn" && typeof line === "string") warnings.push(line);
    });
    return Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const bearer = yield* serverAuth.issueSession();
      yield* serverAuth.revokeSession(bearer.sessionId);
      const request = {
        cookies: {},
        headers: { authorization: `Bearer ${bearer.token}`, "x-real-ip": "203.0.113.7" },
        source: { socket: { remoteAddress: "127.0.0.1" } },
      } as never;
      const retry = Effect.exit(serverAuth.authenticateHttpRequest(request));

      for (let attempt = 0; attempt < 50; attempt += 1) {
        expect(Exit.isFailure(yield* retry)).toBe(true);
      }
      yield* TestClock.adjust(Duration.minutes(10));
      expect(Exit.isFailure(yield* retry)).toBe(true);

      const sessionPrefix = bearer.sessionId.slice(0, 8);
      expect(warnings).toEqual([
        `Rejected authenticated session credential. reason="Session token revoked." session=${sessionPrefix} ip=203.0.113.7`,
        `Rejected authenticated session credential. reason="Session token revoked." session=${sessionPrefix} ip=203.0.113.7 repeats_suppressed=49`,
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerEnvironmentAuth({ mode: "web", host: "127.0.0.1" }),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("raises a security alert for each device paired, but not for CLI sessions", () => {
    const alerts: Array<string> = [];
    const logger = Logger.make(({ logLevel, message }) => {
      const line = Array.isArray(message) ? message[0] : message;
      if (logLevel === "Warn" && typeof line === "string" && line.startsWith("Security alert:")) {
        alerts.push(line);
      }
    });
    return Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const browserLink = yield* serverAuth.issuePairingCredential({ label: "Dan's laptop" });
      yield* serverAuth.createBrowserSession(browserLink.credential, {
        ...requestMetadata,
        ipAddress: "203.0.113.7",
        userAgent: "Mozilla/5.0 <!channel>",
      });
      const phoneLink = yield* serverAuth.issuePairingCredential({ label: "Dan's phone" });
      yield* serverAuth.exchangeBootstrapCredentialForAccessToken(phoneLink.credential, undefined, {
        deviceType: "mobile",
        os: "Android",
        ipAddress: "198.51.100.4",
      });
      yield* serverAuth.issueSession({ label: "t3 project cli" });

      expect(alerts).toHaveLength(2);
      expect(alerts[0]).toContain("a new device paired.");
      expect(alerts[0]).toContain('Device: "Dan\'s laptop" — desktop, macOS, Chrome');
      expect(alerts[0]).toContain("IP: 203.0.113.7");
      expect(alerts[0]).toContain("(browser-session-cookie)");
      expect(alerts[0]).toContain("User agent: Mozilla/5.0 &lt;!channel&gt;");
      expect(alerts[1]).toContain('Device: "Dan\'s phone" — mobile, Android');
      expect(alerts[1]).toContain("IP: 198.51.100.4");
      expect(alerts[1]).toContain("(bearer-access-token)");
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerEnvironmentAuth({ mode: "web", host: "127.0.0.1" }),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("preserves pairing grants after rejecting scopes they do not grant", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential();

      const error = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(
          pairingCredential.credential,
          ["access:write"],
          requestMetadata,
        )
        .pipe(Effect.flip);

      expect(error._tag).toBe("ServerAuthScopeNotGrantedError");
      expect((yield* serverAuth.listPairingLinks()).map((link) => link.id)).toContain(
        pairingCredential.id,
      );
      expect(yield* serverAuth.listSessions()).toEqual([]);

      const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairingCredential.credential,
        ["orchestration:read"],
        requestMetadata,
      );
      const session = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(token.access_token),
      );

      expect(token.scope).toBe("orchestration:read");
      expect(session.scopes).toEqual(["orchestration:read"]);
      expect((yield* serverAuth.listPairingLinks()).map((link) => link.id)).not.toContain(
        pairingCredential.id,
      );
      const reused = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(
          pairingCredential.credential,
          ["orchestration:read"],
          requestMetadata,
        )
        .pipe(Effect.flip);
      expect(reused._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect.each([
    { label: "omits scope", requestedScopes: undefined },
    {
      label: "requests unsupported permissions alongside a granted one",
      requestedScopes: ["orchestration:read", "access:write"] as const,
    },
  ])("inherits a constrained pairing grant when token exchange $label", ({ requestedScopes }) =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        scopes: ["orchestration:read"],
      });

      const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairingCredential.credential,
        requestedScopes,
        requestMetadata,
      );

      expect(token.scope).toBe("orchestration:read");
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("narrows seeded desktop grants to the requested scopes", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        ["orchestration:read"],
        requestMetadata,
      );
      const session = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(token.access_token),
      );

      expect(token.scope).toBe("orchestration:read");
      expect(session.scopes).toEqual(["orchestration:read"]);
    }).pipe(
      Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: "desktop-bootstrap-token" })),
    ),
  );

  it.effect("rotates desktop bearer sessions without accumulating authorized clients", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const browser = yield* serverAuth.createBrowserSession(
        "desktop-bootstrap-token",
        requestMetadata,
      );
      const browserSession = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(sessions.cookieName, browser.sessionToken),
      );
      const staleSessions = yield* Effect.forEach([1, 2, 3], () =>
        sessions.issue({ subject: "desktop-bootstrap", method: "bearer-access-token" }),
      );
      const pairing = yield* serverAuth.issuePairingCredential();
      const paired = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairing.credential,
        undefined,
        { ...requestMetadata, label: "T3 Code Desktop" },
      );
      const first = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        undefined,
        requestMetadata,
      );
      const firstSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(first.access_token),
      );
      const second = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        undefined,
        requestMetadata,
      );

      const active = yield* serverAuth.listSessions();
      const firstError = yield* serverAuth
        .authenticateHttpRequest(makeBearerRequest(first.access_token))
        .pipe(Effect.flip);
      const secondSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(second.access_token),
      );

      expect(active).toHaveLength(3);
      expect(active.map((entry) => entry.sessionId)).toContain(browserSession.sessionId);
      expect(active.map((entry) => entry.sessionId)).toContain(secondSession.sessionId);
      expect(active.map((entry) => entry.sessionId)).not.toContain(firstSession.sessionId);
      expect(firstError._tag).toBe("ServerAuthInvalidCredentialError");
      for (const stale of staleSessions) {
        const error = yield* sessions.verify(stale.token).pipe(Effect.flip);
        expect(error._tag).toBe("SessionTokenRevokedError");
      }
      const pairedSession = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(paired.access_token),
      );
      expect(pairedSession.subject).toBe("one-time-token");
      expect(active.map((entry) => entry.sessionId)).toContain(pairedSession.sessionId);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          desktopBootstrapToken: "desktop-bootstrap-token",
        }),
      ),
    ),
  );

  it.effect("keeps user-issued administrative pairing links manageable", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        scopes: AuthAdministrativeScopes,
      });
      const listedPairingLinks = yield* serverAuth.listPairingLinks();

      expect(
        listedPairingLinks.find((pairingLink) => pairingLink.id === pairingCredential.id)?.subject,
      ).toBe("one-time-token");
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("issues startup pairing URLs that bootstrap administrative sessions", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;

      const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
      const token = new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token");
      const listedPairingLinks = yield* serverAuth.listPairingLinks();
      expect(token).toBeTruthy();
      expect(
        listedPairingLinks.some(
          (pairingLink) => pairingLink.subject === "administrative-bootstrap",
        ),
      ).toBe(false);

      const exchanged = yield* serverAuth.createBrowserSession(token ?? "", requestMetadata);
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(sessions.cookieName, exchanged.sessionToken),
      );

      expect(verified.scopes).toEqual(AuthAdministrativeScopes);
      expect(verified.subject).toBe("administrative-bootstrap");
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect(
    "lists pairing links and revokes other sessions while keeping the administrative session",
    () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;

        const administrativeExchange = yield* serverAuth.createBrowserSession(
          "desktop-bootstrap-token",
          requestMetadata,
        );
        const administrativeSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(sessions.cookieName, administrativeExchange.sessionToken),
        );
        const pairingCredential = yield* serverAuth.issuePairingCredential({
          label: "Julius iPhone",
        });
        const listedPairingLinks = yield* serverAuth.listPairingLinks();
        const clientExchange = yield* serverAuth.createBrowserSession(
          pairingCredential.credential,
          {
            ...requestMetadata,
            deviceType: "mobile",
            os: "iOS",
            browser: "Safari",
            ipAddress: "192.168.1.88",
          },
        );
        const clientSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(sessions.cookieName, clientExchange.sessionToken),
        );
        const clientsBeforeRevoke = yield* serverAuth.listClientSessions(
          administrativeSession.sessionId,
        );
        const revokedCount = yield* serverAuth.revokeOtherClientSessions(
          administrativeSession.sessionId,
        );
        const clientsAfterRevoke = yield* serverAuth.listClientSessions(
          administrativeSession.sessionId,
        );

        expect(listedPairingLinks.map((entry) => entry.id)).toContain(pairingCredential.id);
        expect(listedPairingLinks.find((entry) => entry.id === pairingCredential.id)?.label).toBe(
          "Julius iPhone",
        );
        expect(clientsBeforeRevoke).toHaveLength(2);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === administrativeSession.sessionId)
            ?.current,
        ).toBe(true);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.current,
        ).toBe(false);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
            .label,
        ).toBe("Julius iPhone");
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
            .deviceType,
        ).toBe("mobile");
        expect(revokedCount).toBe(1);
        expect(clientsAfterRevoke).toHaveLength(1);
        expect(clientsAfterRevoke[0]?.sessionId).toBe(administrativeSession.sessionId);
      }).pipe(
        Effect.provide(
          layerEnvironmentAuth({
            desktopBootstrapToken: "desktop-bootstrap-token",
          }),
        ),
      ),
  );

  // Fork (#65): Caddy-shaped forward on the IP host, apps separated by port.
  it.effect("accepts cookie WebSocket upgrades only from the page's own origin", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const pairingCredential = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.createBrowserSession(
        pairingCredential.credential,
        requestMetadata,
      );
      // Shaped like Caddy's forward: Host loses the port, X-Forwarded-Host keeps it.
      const upgrade = (origin: string | undefined, url = "/ws") =>
        ({
          url,
          cookies: { [sessions.cookieName]: exchanged.sessionToken },
          headers: {
            host: "203.0.113.7",
            "x-forwarded-host": "203.0.113.7:7443",
            "x-forwarded-proto": "https",
            ...(origin ? { origin } : {}),
          },
        }) as unknown as Parameters<
          EnvironmentAuth.EnvironmentAuth["Service"]["authenticateWebSocketUpgrade"]
        >[0];

      const sameOrigin = yield* serverAuth.authenticateWebSocketUpgrade(
        upgrade("https://203.0.113.7:7443"),
      );
      const noOrigin = yield* serverAuth.authenticateWebSocketUpgrade(upgrade(undefined));
      const otherPort = yield* Effect.flip(
        serverAuth.authenticateWebSocketUpgrade(upgrade("https://203.0.113.7:8443")),
      );
      // Sibling subdomains share the cookie's site but are other apps.
      const siblingSubdomain = yield* Effect.flip(
        serverAuth.authenticateWebSocketUpgrade({
          url: "/ws",
          cookies: { [sessions.cookieName]: exchanged.sessionToken },
          headers: {
            host: "t3.example.dev",
            "x-forwarded-proto": "https",
            origin: "https://alfred.example.dev",
          },
        } as never),
      );
      const ticket = yield* serverAuth.issueWebSocketTicket(sameOrigin);
      const ticketFromOtherOrigin = yield* serverAuth.authenticateWebSocketUpgrade(
        upgrade("https://app.example.test", `/ws?wsTicket=${ticket.ticket}`),
      );

      expect(sameOrigin.sessionId.length).toBeGreaterThan(0);
      expect(noOrigin.sessionId).toBe(sameOrigin.sessionId);
      expect(otherPort._tag).toBe("ServerAuthInvalidCredentialError");
      expect(siblingSubdomain._tag).toBe("ServerAuthInvalidCredentialError");
      expect(ticketFromOtherOrigin.sessionId).toBe(sameOrigin.sessionId);
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("accepts cookie sessions on socket upgrades only from the app's own origins", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const pairing = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.createBrowserSession(pairing.credential, requestMetadata);
      const upgrade = (headers: Record<string, string>) =>
        serverAuth.authenticateWebSocketUpgrade({
          url: "/ws",
          cookies: { [sessions.cookieName]: exchanged.sessionToken },
          headers: { host: "192.168.1.50:3773", ...headers },
        } as never);

      // Same host, a proxy-reported host, a trusted app origin, or no browser at all.
      yield* upgrade({ origin: "http://192.168.1.50:3773" });
      yield* upgrade({
        origin: "https://box.tail1234.ts.net",
        "x-forwarded-host": "box.tail1234.ts.net",
      });
      yield* upgrade({ origin: "t3code://app" });
      yield* upgrade({ origin: "http://localhost:5733" });
      yield* upgrade({});

      // Another port on the same machine is the same site but not the app.
      const otherPort = yield* Effect.flip(upgrade({ origin: "http://192.168.1.50:8080" }));
      expect(otherPort._tag).toBe("ServerAuthInvalidCredentialError");
      const opaque = yield* Effect.flip(upgrade({ origin: "null" }));
      expect(opaque._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          host: "192.168.1.50",
          devUrl: new URL("http://localhost:5733"),
        }),
      ),
    ),
  );

  it.effect("accepts cookie sessions on HTTP requests only from the app's own origins", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const pairing = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.createBrowserSession(pairing.credential, requestMetadata);
      const post = (headers: Record<string, string>) =>
        serverAuth.authenticateHttpRequest({
          cookies: { [sessions.cookieName]: exchanged.sessionToken },
          headers: { host: "localhost:13773", ...headers },
        } as never);

      // The dev proxy rewrites Host, so a LAN page relies on the browser's own verdict.
      yield* post({ origin: "http://192.168.1.50:5733", "sec-fetch-site": "same-origin" });
      yield* post({ origin: "http://localhost:13773" });

      const otherPort = yield* Effect.flip(
        post({ origin: "http://localhost:3000", "sec-fetch-site": "same-site" }),
      );
      expect(otherPort._tag).toBe("ServerAuthInvalidCredentialError");
      const state = yield* serverAuth.getSessionState({
        cookies: { [sessions.cookieName]: exchanged.sessionToken },
        headers: { host: "localhost:13773", origin: "http://localhost:3000" },
      } as never);
      expect(state.authenticated).toBe(false);
    }).pipe(Effect.provide(layerEnvironmentAuth({ mode: "web" }))),
  );

  it.effect("keeps bearer socket upgrades independent of the page origin", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const bearer = yield* serverAuth.issueSession();
      const verified = yield* serverAuth.authenticateWebSocketUpgrade({
        url: "/ws",
        cookies: {},
        headers: {
          host: "192.168.1.50:3773",
          origin: "http://192.168.1.50:8080",
          authorization: `Bearer ${bearer.token}`,
        },
      } as never);
      expect(verified.sessionId).toBe(bearer.sessionId);
    }).pipe(Effect.provide(layerEnvironmentAuth({ mode: "web", host: "192.168.1.50" }))),
  );
  it.effect("gates HTTP and pre-issued websocket tickets until this session verifies", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const first = yield* pairBearer(auth);
      const second = yield* pairBearer(auth);
      const ticket = yield* auth.issueWebSocketTicket(
        yield* auth.authenticateHttpRequest(makeBearerRequest(second.token)),
      );
      const recoveryCodes = yield* enrollTwoFactor(
        sessions,
        (yield* auth.authenticateHttpRequest(makeBearerRequest(first.token))).sessionId,
      );
      yield* auth.authenticateHttpRequest(makeBearerRequest(first.token));
      const mcp = yield* auth.issueMcpClientSession({
        label: "External agent",
        access: "read-only",
        client: { deviceType: "unknown" },
      });
      yield* Effect.flip(auth.authenticateMcpClient(makeBearerRequest(mcp.token)));
      const mcpSession = yield* auth.authenticateFactorRequest(makeBearerRequest(mcp.token));
      yield* sessions.twoFactor.verifyCode(mcpSession.sessionId, recoveryCodes[2]!, false);
      yield* auth.authenticateMcpClient(makeBearerRequest(mcp.token));
      // MFA does not widen the MCP token's audience to the normal API.
      yield* Effect.flip(auth.authenticateHttpRequest(makeBearerRequest(mcp.token)));

      const rejected = yield* Effect.flip(
        auth.authenticateHttpRequest(makeBearerRequest(second.token)),
      );
      expect(rejected).toMatchObject({ twoFactorRequired: true });
      const state = yield* auth.getSessionState(makeBearerRequest(second.token));
      expect(state.authenticated).toBe(true);
      expect(state.twoFactor?.required).toBe(true);
      const secondSession = yield* auth.authenticateFactorRequest(makeBearerRequest(second.token));
      const socketRequest = {
        url: `/ws?wsTicket=${ticket.ticket}`,
        cookies: {},
        headers: { host: "localhost" },
      } as never;
      yield* Effect.flip(auth.authenticateWebSocketUpgrade(socketRequest));
      yield* sessions.twoFactor.verifyCode(secondSession.sessionId, recoveryCodes[0]!, false);
      yield* auth.authenticateHttpRequest(makeBearerRequest(second.token));
      yield* auth.authenticateWebSocketUpgrade(socketRequest);
      yield* TestClock.adjust("48 hours");
      const expired = yield* Effect.flip(
        auth.authenticateHttpRequest(makeBearerRequest(second.token)),
      );
      expect(expired).toMatchObject({ twoFactorRequired: true });
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("keeps CLI-issued service sessions usable after two-factor enrollment", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const owner = yield* pairBearer(auth);
      // What `t3 auth session issue --subject alfred-brain-actions` mints.
      const service = yield* auth.issueSession({
        subject: "alfred-brain-actions",
        label: "alfred-brain-actions",
      });
      yield* enrollTwoFactor(
        sessions,
        (yield* auth.authenticateHttpRequest(makeBearerRequest(owner.token))).sessionId,
      );

      const authenticated = yield* auth.authenticateHttpRequest(makeBearerRequest(service.token));
      expect(authenticated.sessionId).toBe(service.sessionId);
      const state = yield* auth.getSessionState(makeBearerRequest(service.token));
      expect(state.twoFactor).toMatchObject({ enabled: true, required: false });
      const ticket = yield* auth.issueWebSocketTicket(authenticated);
      const socket = yield* auth.authenticateWebSocketUpgrade({
        url: `/ws?wsTicket=${ticket.ticket}`,
        cookies: {},
        headers: { host: "localhost" },
      } as never);
      // The WebSocket RPC middleware re-checks every call against this session.
      yield* sessions.twoFactor.requireVerified(socket);
      yield* TestClock.adjust("72 hours");
      yield* auth.authenticateHttpRequest(makeBearerRequest(service.token));
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("never extends the CLI exemption to remotely issued or forged sessions", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const owner = yield* pairBearer(auth);
      const paired = yield* pairBearer(auth);
      const browser = yield* auth.createBrowserSession(
        (yield* auth.issuePairingCredential()).credential,
        requestMetadata,
      );
      yield* enrollTwoFactor(
        sessions,
        (yield* auth.authenticateHttpRequest(makeBearerRequest(owner.token))).sessionId,
      );

      // A verified session can still pair new devices, but they start gated.
      const pairedAfter = yield* pairBearer(auth);
      for (const token of [paired.token, pairedAfter.token]) {
        expect(
          yield* Effect.flip(auth.authenticateHttpRequest(makeBearerRequest(token))),
        ).toMatchObject({ twoFactorRequired: true });
      }
      expect(
        yield* Effect.flip(
          auth.authenticateHttpRequest(
            makeCookieRequest(sessions.cookieName, browser.sessionToken),
          ),
        ),
      ).toMatchObject({ twoFactorRequired: true });

      // The marker lives in the signed token: adding it to a paired token breaks the signature.
      const [payload] = paired.token.split(".");
      const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
      const forgedPayload = Buffer.from(
        JSON.stringify({ ...claims, local: true, sub: "cli-issued-session" }),
      ).toString("base64url");
      const forged = yield* Effect.flip(
        auth.authenticateHttpRequest(
          makeBearerRequest(`${forgedPayload}.${paired.token.split(".")[1]}`),
        ),
      );
      expect(forged).toMatchObject({ _tag: "ServerAuthInvalidCredentialError" });
      expect(forged).not.toMatchObject({ twoFactorRequired: true });
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );
});
