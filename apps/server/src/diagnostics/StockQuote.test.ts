import { describe, expect, it } from "vite-plus/test";

import { normalizeSymbol, parseStooqCsv, parseYahooChart } from "./StockQuote.ts";

const CAPTURED_AT = 1_783_610_399;

describe("StockQuote", () => {
  describe("normalizeSymbol", () => {
    it("trims and uppercases", () => {
      expect(normalizeSymbol("  spy  ")).toBe("SPY");
    });

    it("accepts real ticker shapes (indices, classes, crypto, FX)", () => {
      expect(normalizeSymbol("brk-b")).toBe("BRK-B");
      expect(normalizeSymbol("^gspc")).toBe("^GSPC");
      expect(normalizeSymbol("btc-usd")).toBe("BTC-USD");
      expect(normalizeSymbol("eurusd=x")).toBe("EURUSD=X");
    });

    it("returns null for an empty/whitespace symbol", () => {
      expect(normalizeSymbol("   ")).toBeNull();
      expect(normalizeSymbol("")).toBeNull();
    });

    it("rejects malformed or oversized symbols", () => {
      expect(normalizeSymbol("A B")).toBeNull();
      expect(normalizeSymbol("drop/table")).toBeNull();
      expect(normalizeSymbol("A".repeat(16))).toBeNull();
    });
  });

  describe("parseYahooChart", () => {
    const chart = (meta: Record<string, unknown>) => ({ chart: { result: [{ meta }] } });

    it("derives price and percent change from the previous close", () => {
      const quote = parseYahooChart(
        chart({
          symbol: "SPY",
          regularMarketPrice: 612.34,
          previousClose: 609.78,
          currency: "USD",
        }),
        CAPTURED_AT,
      );
      expect(quote?.symbol).toBe("SPY");
      expect(quote?.price).toBe(612.34);
      expect(quote?.currency).toBe("USD");
      expect(quote?.changePercent).toBeCloseTo(0.4198, 3);
      expect(quote?.capturedAt).toBe(CAPTURED_AT);
    });

    it("falls back to chartPreviousClose when previousClose is absent", () => {
      const quote = parseYahooChart(
        chart({ symbol: "AAPL", regularMarketPrice: 100, chartPreviousClose: 200 }),
        CAPTURED_AT,
      );
      expect(quote?.changePercent).toBeCloseTo(-50, 5);
    });

    it("returns a null change when no previous close is available", () => {
      const quote = parseYahooChart(
        chart({ symbol: "SPY", regularMarketPrice: 100 }),
        CAPTURED_AT,
      );
      expect(quote?.changePercent).toBeNull();
    });

    it("returns null for a missing price or malformed payload", () => {
      expect(parseYahooChart(chart({ symbol: "SPY" }), CAPTURED_AT)).toBeNull();
      expect(parseYahooChart({ chart: { result: [] } }, CAPTURED_AT)).toBeNull();
      expect(parseYahooChart({ chart: { error: "Not Found" } }, CAPTURED_AT)).toBeNull();
      expect(parseYahooChart("nonsense", CAPTURED_AT)).toBeNull();
    });
  });

  describe("parseStooqCsv", () => {
    it("reads the close price from the data row (no percent change)", () => {
      const csv = "Symbol,Date,Time,Open,High,Low,Close,Volume\nSPY.US,2026-07-09,22:00:00,611,613,610,612.34,1000000";
      const quote = parseStooqCsv(csv, CAPTURED_AT);
      expect(quote?.symbol).toBe("SPY.US");
      expect(quote?.price).toBe(612.34);
      expect(quote?.changePercent).toBeNull();
      expect(quote?.currency).toBeNull();
    });

    it("returns null when Stooq reports N/D for an unknown symbol", () => {
      const csv = "Symbol,Date,Time,Open,High,Low,Close,Volume\nZZZZ.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D";
      expect(parseStooqCsv(csv, CAPTURED_AT)).toBeNull();
    });

    it("returns null for a header-only response", () => {
      expect(parseStooqCsv("Symbol,Date,Time,Open,High,Low,Close,Volume", CAPTURED_AT)).toBeNull();
    });
  });
});
