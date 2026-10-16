// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Crypto does not expose HMAC or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

export function base32(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits > 0) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}

/** RFC 6238 with SHA-1, a 30-second period and six digits. */
export function totp(secret: Uint8Array, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = NodeCrypto.createHmac("sha1", secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits)
    .toString()
    .padStart(digits, "0");
}

export function matchingTotpStep(secret: Uint8Array, code: string, now: number, lastStep: number) {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30_000);
  for (const candidate of [step, step - 1, step + 1]) {
    if (candidate < 0 || candidate <= lastStep) continue;
    if (NodeCrypto.timingSafeEqual(Buffer.from(code), Buffer.from(totp(secret, candidate)))) return candidate;
  }
  return null;
}
