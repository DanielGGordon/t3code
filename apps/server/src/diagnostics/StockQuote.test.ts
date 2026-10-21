import { describe, expect, it } from "vite-plus/test";

import {
  normalizeSymbol,
  parseCboe,
  parseRobinhood,
  parseStooqCsv,
  parseYahooChart,
  sessionAt,
} from "./StockQuote.ts";

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

  describe("sessionAt", () => {
    // October is EDT (UTC-4).
    it("classifies Eastern wall-clock time into the four sessions", () => {
      expect(sessionAt(Date.parse("2026-10-20T08:00:00Z"))).toBe("pre"); // 4:00 ET
      expect(sessionAt(Date.parse("2026-10-20T13:30:00Z"))).toBe("regular"); // 9:30 ET
      expect(sessionAt(Date.parse("2026-10-20T20:00:00Z"))).toBe("post"); // 16:00 ET
      expect(sessionAt(Date.parse("2026-10-21T00:00:00Z"))).toBe("overnight"); // 20:00 ET
      expect(sessionAt(Date.parse("2026-10-21T07:59:00Z"))).toBe("overnight"); // 3:59 ET
    });

    it("follows daylight saving (EST in winter)", () => {
      expect(sessionAt(Date.parse("2026-12-15T14:30:00Z"))).toBe("regular"); // 9:30 EST
    });
  });

  describe("parseRobinhood", () => {
    const row = (fields: Record<string, unknown>) => ({
      results: [
        {
          symbol: "TSLA",
          last_trade_price: "373.775000",
          venue_last_trade_time: "2026-10-20T19:59:59.907567936Z",
          previous_close: "368.060000",
          adjusted_previous_close: "368.060000",
          bid_price: "379.690000",
          ask_price: "379.700000",
          ...fields,
        },
      ],
    });

    it("prefers a newer overnight print and measures change against the regular close", () => {
      const quote = parseRobinhood(
        row({
          last_non_reg_trade_price: "379.700000",
          venue_last_non_reg_trade_time: "2026-10-21T03:25:19.494345912Z",
        }),
        CAPTURED_AT,
      );
      expect(quote?.price).toBe(379.7);
      expect(quote?.session).toBe("overnight");
      expect(quote?.referenceClose).toBe(373.775);
      expect(quote?.changePercent).toBeCloseTo(((379.7 - 373.775) / 373.775) * 100, 5);
      expect(quote?.bid).toBe(379.69);
      expect(quote?.ask).toBe(379.7);
      expect(quote?.tradedAt).toBe(Math.floor(Date.parse("2026-10-21T03:25:19.494Z") / 1000));
    });

    it("uses the regular price against the previous close when it is the latest print", () => {
      const quote = parseRobinhood(
        row({
          last_trade_price: "373.775000",
          venue_last_trade_time: "2026-10-20T19:59:59Z",
          last_non_reg_trade_price: "370.000000",
          venue_last_non_reg_trade_time: "2026-10-20T11:00:00Z",
        }),
        CAPTURED_AT,
      );
      expect(quote?.price).toBe(373.775);
      expect(quote?.session).toBe("regular");
      expect(quote?.referenceClose).toBe(368.06);
      expect(quote?.changePercent).toBeCloseTo(((373.775 - 368.06) / 368.06) * 100, 5);
    });

    it("returns null when there is no result or no price", () => {
      expect(parseRobinhood({ results: [null] }, CAPTURED_AT)).toBeNull();
      expect(parseRobinhood({ results: [] }, CAPTURED_AT)).toBeNull();
      expect(parseRobinhood({ results: [{ symbol: "TSLA" }] }, CAPTURED_AT)).toBeNull();
      expect(parseRobinhood("nonsense", CAPTURED_AT)).toBeNull();
    });
  });

  describe("parseCboe", () => {
    const payload = (data: Record<string, unknown>) => ({
      timestamp: "2026-07-10T12:00:00Z",
      data,
    });

    it("reads price, percent change, symbol and USD currency directly", () => {
      const quote = parseCboe(
        payload({
          symbol: "TSLA",
          current_price: 405.18,
          price_change: 12.49,
          price_change_percent: 3.0722,
        }),
        CAPTURED_AT,
      );
      expect(quote?.symbol).toBe("TSLA");
      expect(quote?.price).toBe(405.18);
      expect(quote?.changePercent).toBe(3.0722);
      expect(quote?.currency).toBe("USD");
      expect(quote?.capturedAt).toBe(CAPTURED_AT);
    });

    it("leaves changePercent null when the field is absent or non-numeric", () => {
      const quote = parseCboe(payload({ symbol: "SPY", current_price: 751.71 }), CAPTURED_AT);
      expect(quote?.price).toBe(751.71);
      expect(quote?.changePercent).toBeNull();
    });

    it("returns null when current_price is missing", () => {
      expect(parseCboe(payload({ symbol: "SPY" }), CAPTURED_AT)).toBeNull();
    });

    it("returns null for a malformed payload", () => {
      expect(parseCboe({ data: null }, CAPTURED_AT)).toBeNull();
      expect(parseCboe({}, CAPTURED_AT)).toBeNull();
      expect(parseCboe("nonsense", CAPTURED_AT)).toBeNull();
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
      const quote = parseYahooChart(chart({ symbol: "SPY", regularMarketPrice: 100 }), CAPTURED_AT);
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
      const csv =
        "Symbol,Date,Time,Open,High,Low,Close,Volume\nSPY.US,2026-07-09,22:00:00,611,613,610,612.34,1000000";
      const quote = parseStooqCsv(csv, CAPTURED_AT);
      expect(quote?.symbol).toBe("SPY.US");
      expect(quote?.price).toBe(612.34);
      expect(quote?.changePercent).toBeNull();
      expect(quote?.currency).toBeNull();
    });

    it("returns null when Stooq reports N/D for an unknown symbol", () => {
      const csv =
        "Symbol,Date,Time,Open,High,Low,Close,Volume\nZZZZ.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D";
      expect(parseStooqCsv(csv, CAPTURED_AT)).toBeNull();
    });

    it("returns null for a header-only response", () => {
      expect(parseStooqCsv("Symbol,Date,Time,Open,High,Low,Close,Volume", CAPTURED_AT)).toBeNull();
    });
  });
});
