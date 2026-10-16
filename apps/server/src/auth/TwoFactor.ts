// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Crypto does not expose AES-GCM.
import * as NodeCrypto from "node:crypto";
import type { AuthSessionId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { base32, matchingTotpStep } from "./totp.ts";

export const VERIFICATION_TTL_MS = 48 * 60 * 60 * 1000;
const SETUP_TTL_MS = 10 * 60 * 1000;

export class TwoFactorError extends Schema.TaggedError<TwoFactorError>()("TwoFactorError", {
  message: Schema.String,
}) {}

/** Owned by SessionStore, sharing its database and protected secret store. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<void>();
  const pending = new Map<string, { secret: Buffer; expiresAt: number }>();
  const hash = (code: string) => NodeCrypto.createHash("sha256").update(code).digest("hex");
  const read = () =>
    sql<{
      secret: string;
      last_step: number;
    }>`SELECT secret, last_step FROM auth_two_factor WHERE id = 1`;
  const key = secrets.getOrCreateRandom("two-factor-encryption", 32);
  const encrypt = (secret: Buffer) =>
    key.pipe(
      Effect.map((key) => {
        const iv = NodeCrypto.randomBytes(12);
        const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
        const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
      }),
    );
  const decrypt = (encrypted: string) =>
    Effect.gen(function* () {
      // Never silently replace a lost encryption key for an existing enrollment.
      const stored = yield* secrets.get("two-factor-encryption");
      if (Option.isNone(stored))
        return yield* new TwoFactorError({
          message: "Two-factor key unavailable. Restore the server secrets backup.",
        });
      return yield* Effect.try({
        try: () => {
          const bytes = Buffer.from(encrypted, "base64");
          const cipher = NodeCrypto.createDecipheriv(
            "aes-256-gcm",
            stored.value,
            bytes.subarray(0, 12),
          );
          cipher.setAuthTag(bytes.subarray(12, 28));
          return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
        },
        catch: () =>
          new TwoFactorError({
            message: "Two-factor key unavailable. Restore the server secrets backup.",
          }),
      });
    });
  const status = Effect.fn("TwoFactor.status")(function* (sessionId: AuthSessionId) {
    const enabled = (yield* read()).length > 0;
    const rows = yield* sql<{
      verified_at: number;
    }>`SELECT verified_at FROM auth_two_factor_sessions WHERE session_id = ${sessionId}`;
    const expiresAt = enabled && rows[0] ? rows[0].verified_at + VERIFICATION_TTL_MS : null;
    const now = yield* Clock.currentTimeMillis;
    return { enabled, required: enabled && (expiresAt === null || now >= expiresAt), expiresAt };
  });
  const requireVerified = Effect.fn("TwoFactor.requireVerified")(function* (
    sessionId: AuthSessionId,
  ) {
    if ((yield* status(sessionId)).required)
      return yield* new TwoFactorError({ message: "Two-factor verification required." });
  });
  const begin = Effect.fn("TwoFactor.begin")(function* (sessionId: AuthSessionId) {
    if ((yield* read()).length)
      return yield* new TwoFactorError({
        message: "Two-factor authentication is already enabled.",
      });
    const now = yield* Clock.currentTimeMillis;
    for (const [id, setup] of pending) if (setup.expiresAt <= now) pending.delete(id);
    const secret = NodeCrypto.randomBytes(20);
    pending.set(sessionId, { secret, expiresAt: now + SETUP_TTL_MS });
    const encoded = base32(secret);
    return {
      secret: encoded,
      uri: `otpauth://totp/T3%20Code:environment?secret=${encoded}&issuer=T3%20Code&algorithm=SHA1&digits=6&period=30`,
    };
  });
  // Global persistent limit prevents bypass by pairing another session or restarting.
  const attempt = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql<{
      attempts: number;
      window_start: number;
    }>`SELECT attempts, window_start FROM auth_two_factor_attempts WHERE id = 1`;
    const row = rows[0];
    if (row && now < row.window_start + 300_000 && row.attempts >= 10)
      return yield* new TwoFactorError({
        message: "Too many attempts. Try again in five minutes.",
      });
    const fresh = !row || now >= row.window_start + 300_000;
    yield* sql`INSERT INTO auth_two_factor_attempts VALUES (1, ${fresh ? 1 : row.attempts + 1}, ${fresh ? now : row.window_start}) ON CONFLICT(id) DO UPDATE SET attempts = excluded.attempts, window_start = excluded.window_start`;
    return now;
  });
  const markVerified = (sessionId: AuthSessionId, now: number) =>
    sql`INSERT INTO auth_two_factor_sessions VALUES (${sessionId}, ${now}) ON CONFLICT(session_id) DO UPDATE SET verified_at = excluded.verified_at`;
  const confirm = Effect.fn("TwoFactor.confirm")(function* (
    sessionId: AuthSessionId,
    code: string,
  ) {
    const now = yield* attempt;
    const setup = pending.get(sessionId);
    if (!setup || setup.expiresAt <= now)
      return yield* new TwoFactorError({ message: "Setup expired. Start setup again." });
    const step = matchingTotpStep(setup.secret, code, now, -1);
    if (step === null) return yield* new TwoFactorError({ message: "Invalid authenticator code." });
    if ((yield* read()).length)
      return yield* new TwoFactorError({
        message: "Two-factor authentication is already enabled.",
      });
    const encrypted = yield* encrypt(setup.secret);
    const recoveryCodes = Array.from({ length: 10 }, () =>
      NodeCrypto.randomBytes(16).toString("hex"),
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO auth_two_factor VALUES (1, ${encrypted}, ${step})`;
        yield* sql`DELETE FROM auth_two_factor_sessions`;
        yield* sql`DELETE FROM auth_two_factor_recovery`;
        for (const code of recoveryCodes)
          yield* sql`INSERT INTO auth_two_factor_recovery VALUES (${hash(code)})`;
        yield* markVerified(sessionId, now);
      }),
    );
    pending.clear();
    yield* PubSub.publish(changes, undefined);
    return { recoveryCodes };
  }, lock.withPermits(1));
  const verifyCode = Effect.fn("TwoFactor.verifyCode")(function* (
    sessionId: AuthSessionId,
    code: string,
    disable: boolean,
  ) {
    const now = yield* attempt;
    const row = (yield* read())[0];
    if (!row)
      return yield* new TwoFactorError({ message: "Two-factor authentication is not enabled." });
    const step = /^\d{6}$/.test(code)
      ? matchingTotpStep(yield* decrypt(row.secret), code, now, row.last_step)
      : null;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (step === null) {
          const used =
            yield* sql`DELETE FROM auth_two_factor_recovery WHERE hash = ${hash(code)} RETURNING hash`;
          if (!used.length)
            return yield* new TwoFactorError({
              message:
                "Invalid or already used code. Try the next authenticator code or a recovery code.",
            });
        } else {
          const updated =
            yield* sql`UPDATE auth_two_factor SET last_step = ${step} WHERE id = 1 AND last_step < ${step} RETURNING id`;
          if (!updated.length)
            return yield* new TwoFactorError({
              message: "Code already used. Wait for the next code.",
            });
        }
        if (disable) {
          yield* sql`DELETE FROM auth_two_factor`;
          yield* sql`DELETE FROM auth_two_factor_recovery`;
          yield* sql`DELETE FROM auth_two_factor_sessions`;
        } else yield* markVerified(sessionId, now);
      }),
    );
    yield* PubSub.publish(changes, undefined);
    return { verified: true };
  }, lock.withPermits(1));
  const awaitRequired = (sessionId: AuthSessionId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        while (true) {
          const current = yield* status(sessionId);
          if (current.required) return;
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.raceFirst(
            PubSub.take(subscription),
            current.expiresAt === null
              ? Effect.never
              : Effect.sleep(Math.max(0, current.expiresAt - now)),
          );
        }
      }),
    );
  return { status, requireVerified, begin, confirm, verifyCode, awaitRequired };
});
