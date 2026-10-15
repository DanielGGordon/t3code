import { describe, expect, it } from "vite-plus/test";

import { makeLogThrottle } from "./logThrottle.ts";

describe("makeLogThrottle", () => {
  it("logs a key once per window and reports the repeats it dropped", () => {
    const shouldLog = makeLogThrottle({ windowMs: 60_000, maxKeys: 10 });

    expect(shouldLog("revoked:a", 0)).toEqual({ log: true, suppressed: 0 });
    for (let attempt = 1; attempt <= 500; attempt += 1) {
      expect(shouldLog("revoked:a", attempt * 100)).toEqual({ log: false });
    }
    expect(shouldLog("revoked:a", 60_000)).toEqual({ log: true, suppressed: 500 });
    expect(shouldLog("revoked:a", 60_001)).toEqual({ log: false });
  });

  it("throttles each key independently", () => {
    const shouldLog = makeLogThrottle({ windowMs: 60_000, maxKeys: 10 });

    expect(shouldLog("revoked:a", 0)).toEqual({ log: true, suppressed: 0 });
    expect(shouldLog("revoked:b", 1)).toEqual({ log: true, suppressed: 0 });
    expect(shouldLog("revoked:a", 2)).toEqual({ log: false });
  });

  it("stays bounded under a flood of distinct keys and recovers once they age out", () => {
    const shouldLog = makeLogThrottle({ windowMs: 60_000, maxKeys: 2 });

    expect(shouldLog("a", 0).log).toBe(true);
    expect(shouldLog("b", 0).log).toBe(true);
    expect(shouldLog("c", 1).log).toBe(false);
    expect(shouldLog("c", 60_000).log).toBe(true);
  });
});
