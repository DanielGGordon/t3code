import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as TwoFactor from "./TwoFactor.ts";
import { base32, matchingTotpStep, totp } from "./totp.ts";
const layer = Layer.mergeAll(SqlitePersistence.layerMemory, ServerSecretStore.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-two-factor-" })),
  Layer.provideMerge(NodeServices.layer),
);
const a = AuthSessionId.make("session-a");
const b = AuthSessionId.make("session-b");
export function decodeBase32(value: string) {
  const bits = [...value]
    .map((c) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0"))
    .join("");
  return Buffer.from(bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2)));
}
const enroll = Effect.gen(function* () {
  const factor = yield* TwoFactor.make;
  const setup = yield* factor.begin(a);
  const secret = decodeBase32(setup.secret);
  const now = yield* Clock.currentTimeMillis;
  const codes = yield* factor.confirm(a, totp(secret, Math.floor(now / 30_000)));
  return { factor, secret, ...codes };
});
it("matches RFC 6238 SHA-1 vectors", () => {
  const secret = Buffer.from("12345678901234567890");
  for (const [seconds, expected] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ] as const)
    expect(totp(secret, Math.floor(seconds / 30), 8)).toBe(expected);
  expect(base32(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  expect(matchingTotpStep(secret, "00000x", 59_000, -1)).toBeNull();
});
it.effect(
  "independent session deadlines expire at exactly 48h and survive service recreation",
  () =>
    Effect.gen(function* () {
      const { factor, recoveryCodes } = yield* enroll;
      expect((yield* factor.status(a)).required).toBe(false);
      expect((yield* factor.status(b)).required).toBe(true);
      yield* TestClock.adjust("24 hours");
      yield* factor.verifyCode(b, recoveryCodes[0]!, false);
      yield* TestClock.adjust("24 hours");
      expect((yield* factor.status(a)).required).toBe(true);
      expect((yield* factor.status(b)).required).toBe(false);
      const restarted = yield* TwoFactor.make;
      expect(yield* restarted.status(a)).toEqual(yield* factor.status(a));
      expect(yield* restarted.status(b)).toEqual(yield* factor.status(b));
      yield* restarted.verifyCode(a, recoveryCodes[1]!, false);
      expect((yield* restarted.status(a)).expiresAt).toBe(
        (yield* Clock.currentTimeMillis) + TwoFactor.VERIFICATION_TTL_MS,
      );
    }).pipe(Effect.provide(layer)),
);
it.effect("rejects reused TOTP and recovery codes; disable requires a fresh code", () =>
  Effect.gen(function* () {
    const { factor, secret, recoveryCodes } = yield* enroll;
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.flip(factor.verifyCode(b, totp(secret, Math.floor(now / 30_000)), false));
    yield* factor.verifyCode(b, recoveryCodes[0]!, false);
    yield* Effect.flip(factor.verifyCode(a, recoveryCodes[0]!, true));
    expect((yield* factor.status(a)).enabled).toBe(true);
    yield* factor.verifyCode(a, recoveryCodes[1]!, true);
    expect(yield* factor.status(b)).toEqual({ enabled: false, required: false, expiresAt: null });
    const sql = yield* SqlClient.SqlClient;
    expect(yield* sql`SELECT * FROM auth_two_factor_recovery`).toHaveLength(0);
  }).pipe(Effect.provide(layer)),
);
it.effect("limits attempts across sessions and restarts", () =>
  Effect.gen(function* () {
    const { factor, recoveryCodes } = yield* enroll;
    for (let i = 0; i < 9; i++) yield* Effect.flip(factor.verifyCode(b, "wrong", false));
    const restarted = yield* TwoFactor.make;
    expect(
      (yield* Effect.flip(restarted.verifyCode(a, recoveryCodes[0]!, false))).message,
    ).toContain("Too many attempts");
    yield* TestClock.adjust("5 minutes");
    yield* restarted.verifyCode(a, recoveryCodes[0]!, false);
  }).pipe(Effect.provide(layer)),
);
it.effect("requires confirmed setup owned by the session, with ten-minute expiry", () =>
  Effect.gen(function* () {
    const factor = yield* TwoFactor.make;
    const setup = yield* factor.begin(a);
    expect((yield* factor.status(a)).enabled).toBe(false);
    const code = totp(
      decodeBase32(setup.secret),
      Math.floor((yield* Clock.currentTimeMillis) / 30_000),
    );
    yield* Effect.flip(factor.confirm(b, code));
    yield* TestClock.adjust("10 minutes");
    yield* Effect.flip(factor.confirm(a, code));
    expect((yield* factor.status(a)).enabled).toBe(false);
  }).pipe(Effect.provide(layer)),
);
it.effect("invalidates open connections at the deadline without a new request", () =>
  Effect.gen(function* () {
    const { factor } = yield* enroll;
    const waiter = yield* Effect.forkChild(factor.awaitRequired(a));
    yield* TestClock.adjust("48 hours");
    yield* Fiber.join(waiter);
    expect((yield* factor.status(a)).required).toBe(true);
  }).pipe(Effect.provide(layer)),
);
