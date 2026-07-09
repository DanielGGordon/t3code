import { describe, expect, it } from "vite-plus/test";

import { parseCredentials, parseUsageLimits } from "./claudeAccountUsage.ts";

describe("claudeAccountUsage", () => {
  describe("parseCredentials", () => {
    it("extracts the OAuth access token and expiry", () => {
      const raw = JSON.stringify({
        claudeAiOauth: { accessToken: "sk-ant-oat01-abc", expiresAt: 1_780_000_000_000 },
      });
      expect(parseCredentials(raw)).toEqual({
        accessToken: "sk-ant-oat01-abc",
        expiresAtMs: 1_780_000_000_000,
      });
    });

    it("tolerates a missing or malformed expiry", () => {
      const raw = JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: "soon" } });
      expect(parseCredentials(raw)).toEqual({ accessToken: "tok", expiresAtMs: null });
    });

    it("returns null for malformed JSON, missing fields, or empty tokens", () => {
      expect(parseCredentials("not json")).toBeNull();
      expect(parseCredentials("{}")).toBeNull();
      expect(parseCredentials(JSON.stringify({ claudeAiOauth: {} }))).toBeNull();
      expect(parseCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "" } }))).toBeNull();
      expect(parseCredentials(JSON.stringify({ claudeAiOauth: { accessToken: 42 } }))).toBeNull();
    });
  });

  describe("parseUsageLimits", () => {
    it("parses the upstream limits array", () => {
      const limits = parseUsageLimits({
        limits: [
          {
            kind: "session",
            percent: 39,
            severity: "normal",
            resets_at: "2026-07-08T10:10:00Z",
            scope: null,
            is_active: false,
          },
          {
            kind: "weekly_scoped",
            percent: 54,
            severity: "normal",
            resets_at: "2026-07-08T07:00:00Z",
            scope: { model: { id: null, display_name: "Fable" }, surface: null },
            is_active: true,
          },
        ],
      });

      expect(limits).toEqual([
        {
          kind: "session",
          percent: 39,
          severity: "normal",
          resetsAt: "2026-07-08T10:10:00Z",
          isActive: false,
        },
        {
          kind: "weekly_scoped",
          percent: 54,
          severity: "normal",
          resetsAt: "2026-07-08T07:00:00Z",
          scopeLabel: "Fable",
          isActive: true,
        },
      ]);
    });

    it("drops malformed entries and tolerates shape churn", () => {
      const limits = parseUsageLimits({
        limits: [
          { kind: "session", percent: Number.NaN },
          { kind: "", percent: 10 },
          { kind: "weekly_all", percent: "34" },
          { percent: 12 },
          { kind: "weekly_all", percent: 34, unknown_future_field: { nested: true } },
          null,
        ],
      });

      expect(limits).toEqual([{ kind: "weekly_all", percent: 34 }]);
    });

    it("returns an empty array when limits are absent", () => {
      expect(parseUsageLimits(null)).toEqual([]);
      expect(parseUsageLimits({})).toEqual([]);
      expect(parseUsageLimits({ limits: "nope" })).toEqual([]);
    });
  });
});
