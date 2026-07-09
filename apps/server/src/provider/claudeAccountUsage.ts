import * as NodeOS from "node:os";

import type { ClaudeAccountUsage, ClaudeAccountUsageLimit } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

// Anthropic's OAuth usage endpoint. Unofficial: it is what the Claude Code
// CLI's /usage command calls, so it is stable in practice, but the response
// shape churns — parse defensively and treat any surprise as "unavailable".
const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";
const USAGE_FETCH_TIMEOUT = "10 seconds";
const USAGE_CACHE_TTL_MS = 60_000;
// On macOS, Claude Code stores credentials in the Keychain instead of the
// plaintext ~/.claude/.credentials.json used on Linux/WSL.
const MACOS_KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_MAX_OUTPUT_BYTES = 1_000_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface ClaudeOAuthCredentials {
  readonly accessToken: string;
  readonly expiresAtMs: number | null;
}

export function parseCredentials(credentialsRaw: string): ClaudeOAuthCredentials | null {
  let credentials: unknown;
  try {
    credentials = JSON.parse(credentialsRaw);
  } catch {
    return null;
  }
  const oauth = asRecord(asRecord(credentials)?.claudeAiOauth);
  const accessToken = oauth?.accessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return null;
  }
  const expiresAt = oauth?.expiresAt;
  return {
    accessToken,
    expiresAtMs: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null,
  };
}

export function parseUsageLimits(body: unknown): ReadonlyArray<ClaudeAccountUsageLimit> {
  const limits = asRecord(body)?.limits;
  if (!Array.isArray(limits)) {
    return [];
  }
  const parsed: ClaudeAccountUsageLimit[] = [];
  for (const entry of limits) {
    const limit = asRecord(entry);
    const kind = limit?.kind;
    const percent = limit?.percent;
    if (typeof kind !== "string" || kind.trim().length === 0) continue;
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    const scopeLabel = asRecord(asRecord(limit?.scope)?.model)?.display_name;
    parsed.push({
      kind: kind.trim(),
      percent,
      ...(typeof limit?.severity === "string" ? { severity: limit.severity } : {}),
      ...(typeof limit?.resets_at === "string" ? { resetsAt: limit.resets_at } : {}),
      ...(typeof scopeLabel === "string" ? { scopeLabel } : {}),
      ...(typeof limit?.is_active === "boolean" ? { isActive: limit.is_active } : {}),
    });
  }
  return parsed;
}

const readKeychainCredentialsRaw: Effect.Effect<
  string | null,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("security", ["find-generic-password", "-s", MACOS_KEYCHAIN_SERVICE, "-w"], {
      shell: false,
    }),
  );
  const [stdout, exitCode] = yield* Effect.all(
    [
      collectUint8StreamText({
        stream: child.stdout,
        maxBytes: KEYCHAIN_MAX_OUTPUT_BYTES,
        truncatedMarker: "",
      }),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  return Number(exitCode) === 0 ? stdout.text.trim() : null;
}).pipe(
  Effect.scoped,
  Effect.orElseSucceed(() => null),
);

const readCredentialsRaw: Effect.Effect<
  string | null,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const credentialsPath = path.join(NodeOS.homedir(), ".claude", ".credentials.json");
  const fromFile = yield* fileSystem.readFileString(credentialsPath).pipe(Effect.option);
  if (Option.isSome(fromFile)) {
    return fromFile.value;
  }
  if (process.platform === "darwin") {
    return yield* readKeychainCredentialsRaw;
  }
  return null;
});

/**
 * Fetch account-level Claude plan usage using the host's Claude Code OAuth
 * credentials. Succeeds with null when usage is genuinely unavailable (no or
 * expired credentials, unrecognized response); fails with a typed error on
 * transient upstream problems so callers can serve stale data instead.
 */
const fetchClaudeAccountUsage = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const credentialsRaw = yield* readCredentialsRaw;
  if (credentialsRaw === null) {
    return null;
  }
  const credentials = parseCredentials(credentialsRaw);
  if (credentials === null) {
    return null;
  }
  const nowMs = yield* Clock.currentTimeMillis;
  if (credentials.expiresAtMs !== null && credentials.expiresAtMs <= nowMs) {
    // Claude Code refreshes the token whenever it runs; until then a request
    // is guaranteed to 401, so skip it.
    yield* Effect.logDebug("claude account usage: OAuth token expired; skipping upstream fetch");
    return null;
  }

  const body = yield* HttpClientRequest.get(CLAUDE_USAGE_ENDPOINT).pipe(
    HttpClientRequest.setHeaders({
      Authorization: `Bearer ${credentials.accessToken}`,
      "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
    }),
    httpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown)),
    Effect.timeout(USAGE_FETCH_TIMEOUT),
  );

  const limits = parseUsageLimits(body);
  if (limits.length === 0) {
    return null;
  }

  const now = yield* DateTime.now;
  return { limits, fetchedAt: DateTime.formatIso(now) } satisfies ClaudeAccountUsage;
});

// Process-wide cache shared by every WebSocket connection, with
// stale-on-error: a transient upstream failure keeps serving the last known
// usage instead of hiding the UI for a cache period.
let lastKnownUsage: ClaudeAccountUsage | null = null;
let cacheFreshUntilMs = 0;

export const getClaudeAccountUsage: Effect.Effect<
  ClaudeAccountUsage | null,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const nowMs = yield* Clock.currentTimeMillis;
  if (nowMs < cacheFreshUntilMs) {
    return lastKnownUsage;
  }
  const fresh = yield* fetchClaudeAccountUsage.pipe(
    Effect.tapCause((cause) =>
      Effect.logDebug("claude account usage fetch failed; serving last known value", { cause }),
    ),
    Effect.option,
  );
  if (Option.isSome(fresh)) {
    lastKnownUsage = fresh.value;
  }
  cacheFreshUntilMs = nowMs + USAGE_CACHE_TTL_MS;
  return lastKnownUsage;
}).pipe(Effect.withSpan("getClaudeAccountUsage"));
