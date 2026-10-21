import type { StockQuote, StockQuoteResult } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

// Free, keyless quote sources, tried in order. Robinhood leads for its overnight
// coverage (below); after it, Cboe's delayed-quotes endpoint is preferred because Yahoo and Stooq are IP-blocked from datacenter ranges: from
// the deployed VPS (an OVH datacenter IP) Yahoo returns HTTP 429 on every
// request (query1/query2 and the crumb flow) and Stooq returns HTTP 404 for
// every symbol variant, so both always degraded to "—" in production. Cboe
// answers HTTP 200 from the same IP and returns the price AND percent change
// directly. Yahoo (price + derived change) and Stooq (price only) remain as
// fallbacks — they still work from residential/desktop IPs and cover indices,
// crypto and FX symbols that Cboe (US equities/ETFs) does not.
// Robinhood's own quote endpoint answers without auth and, with `bounds=24_5`,
// includes the 8pm-4am ET overnight (Blue Ocean) session — the one stretch
// every exchange-fed source above goes blind for. It is undocumented, so it is
// tried first but any failure just falls through to the sources below.
const ROBINHOOD_QUOTE_BASE = "https://api.robinhood.com/marketdata/quotes/";
const CBOE_QUOTE_BASE = "https://cdn.cboe.com/api/global/delayed_quotes/quotes/";
const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";
const STOOQ_CSV_BASE = "https://stooq.com/q/l/";
const QUOTE_FETCH_TIMEOUT = "8 seconds";
// Never hit an upstream more than once per symbol inside this window, no matter
// how many WebSocket clients poll — this is the server-side rate limit.
const QUOTE_CACHE_TTL_MS = 15_000;
// Yahoo/Stooq reject requests with no (or a bot-shaped) User-Agent.
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// Real tickers are short and use a small alphabet: letters/digits plus the few
// punctuation marks Yahoo uses for indices (^GSPC), classes (BRK-B), crypto
// (BTC-USD), FX (EURUSD=X) and futures (ES=F). Anything else is rejected so a
// client can't push arbitrary/huge strings into the upstream URL or the cache.
const SYMBOL_PATTERN = /^[A-Z0-9.^=-]{1,15}$/;

/**
 * Uppercase + trim so cache keys and requests are stable, then validate the
 * shape. Returns null for an empty or malformed symbol (rendered as a muted
 * dash) — this also bounds cache-key cardinality and upstream request variety.
 */
export function normalizeSymbol(symbol: string): string | null {
  const trimmed = symbol.trim().toUpperCase();
  return SYMBOL_PATTERN.test(trimmed) ? trimmed : null;
}

type QuoteSession = NonNullable<StockQuote["session"]>;

const NEW_YORK_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  hour: "numeric",
  minute: "numeric",
});

/** Which US session an instant falls in, by Eastern wall-clock time. */
export function sessionAt(epochMs: number): QuoteSession {
  const parts = NEW_YORK_CLOCK.formatToParts(epochMs);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const minutes = read("hour") * 60 + read("minute");
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "pre";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "post";
  return "overnight";
}

function asNumericString(value: unknown): number | null {
  return typeof value === "string" ? asFiniteNumber(Number(value)) : null;
}

function percentChange(price: number, reference: number | null): number | null {
  return reference !== null && reference !== 0 ? ((price - reference) / reference) * 100 : null;
}

/**
 * Parse Robinhood's `marketdata/quotes` payload (string-typed numbers). The
 * latest print wins: when the newest non-regular trade is more recent than the
 * last regular-session trade the price is that extended/overnight print and
 * the change is measured against the regular close (as Robinhood shows it);
 * otherwise it is the regular price against the previous close. Returns null
 * on anything unexpected.
 */
export function parseRobinhood(body: unknown, capturedAt: number): StockQuote | null {
  const results = asRecord(body)?.results;
  const quote = Array.isArray(results) ? asRecord(results[0]) : null;
  if (quote === null) {
    return null;
  }
  const regularPrice = asNumericString(quote.last_trade_price);
  const regularTime = Date.parse(asString(quote.venue_last_trade_time) ?? "");
  const extendedPrice =
    asNumericString(quote.last_non_reg_trade_price) ??
    asNumericString(quote.last_extended_hours_trade_price);
  const extendedTime = Date.parse(asString(quote.venue_last_non_reg_trade_time) ?? "");

  const extendedIsNewer =
    extendedPrice !== null &&
    Number.isFinite(extendedTime) &&
    (!Number.isFinite(regularTime) || extendedTime > regularTime);
  const price = extendedIsNewer ? extendedPrice : regularPrice;
  const tradeTime = extendedIsNewer ? extendedTime : regularTime;
  if (price === null) {
    return null;
  }
  const referenceClose = extendedIsNewer
    ? regularPrice
    : (asNumericString(quote.adjusted_previous_close) ?? asNumericString(quote.previous_close));
  return {
    symbol: asString(quote.symbol) ?? "",
    price,
    changePercent: percentChange(price, referenceClose),
    currency: "USD",
    capturedAt,
    session: Number.isFinite(tradeTime) ? sessionAt(tradeTime) : "regular",
    referenceClose,
    bid: asNumericString(quote.bid_price),
    ask: asNumericString(quote.ask_price),
    tradedAt: Number.isFinite(tradeTime) ? Math.floor(tradeTime / 1000) : null,
  };
}

/**
 * Parse Cboe's delayed-quotes payload into a quote. The shape is
 * `{ timestamp, data: { symbol, current_price, price_change,
 * price_change_percent, open, high, low, close } }`. It gives both the price
 * and the percent change directly. Returns null on anything unexpected so a
 * churned response degrades to "unavailable" rather than throwing. Cboe covers
 * US equities/ETFs; quotes are USD.
 */
export function parseCboe(body: unknown, capturedAt: number): StockQuote | null {
  const data = asRecord(asRecord(body)?.data);
  if (data === null) {
    return null;
  }
  const price = asFiniteNumber(data.current_price);
  if (price === null) {
    return null;
  }
  return {
    symbol: asString(data.symbol) ?? "",
    price,
    changePercent: asFiniteNumber(data.price_change_percent),
    currency: "USD",
    capturedAt,
  };
}

/**
 * Parse Yahoo's `v8/finance/chart` payload into a quote. The shape is
 * `{ chart: { result: [{ meta: { regularMarketPrice, previousClose,
 * chartPreviousClose, currency, symbol } }] } }`. Returns null on anything
 * unexpected so a churned response degrades to "unavailable" rather than
 * throwing.
 */
export function parseYahooChart(body: unknown, capturedAt: number): StockQuote | null {
  const chart = asRecord(asRecord(body)?.chart);
  const result = chart?.result;
  const first = Array.isArray(result) ? asRecord(result[0]) : null;
  const meta = asRecord(first?.meta);
  if (meta === null) {
    return null;
  }
  const price = asFiniteNumber(meta.regularMarketPrice);
  if (price === null) {
    return null;
  }
  const previousClose =
    asFiniteNumber(meta.previousClose) ?? asFiniteNumber(meta.chartPreviousClose);
  const changePercent =
    previousClose !== null && previousClose !== 0
      ? ((price - previousClose) / previousClose) * 100
      : null;
  return {
    symbol: asString(meta.symbol) ?? "",
    price,
    changePercent,
    currency: asString(meta.currency),
    capturedAt,
  };
}

/**
 * Parse Stooq's light CSV (`f=sd2t2ohlcv`): one data row of
 * `Symbol,Date,Time,Open,High,Low,Close,Volume`. Stooq marks unknown symbols
 * with `N/D` fields, which parse to null → treated as unavailable. No percent
 * change is available from this endpoint.
 */
export function parseStooqCsv(csv: string, capturedAt: number): StockQuote | null {
  const lines = csv.trim().split("\n");
  const row = lines[lines.length - 1]?.trim();
  if (!row) {
    return null;
  }
  const fields = row.split(",");
  // [symbol, date, time, open, high, low, close, volume]
  const symbol = fields[0]?.trim();
  const closeRaw = fields[6]?.trim();
  if (!symbol || symbol.toUpperCase() === "SYMBOL" || !closeRaw) {
    return null;
  }
  const price = asFiniteNumber(Number(closeRaw));
  if (price === null) {
    return null;
  }
  return {
    symbol: symbol.toUpperCase(),
    price,
    changePercent: null,
    currency: null,
    capturedAt,
  };
}

/** Yahoo already returns a bare-symbol quote; Stooq wants a market suffix. */
function toStooqSymbol(symbol: string): string {
  return symbol.includes(".") ? symbol.toLowerCase() : `${symbol.toLowerCase()}.us`;
}

const fetchFromRobinhood = (
  symbol: string,
  capturedAt: number,
): Effect.Effect<StockQuote | null, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const body = yield* HttpClientRequest.get(
      `${ROBINHOOD_QUOTE_BASE}?symbols=${encodeURIComponent(symbol)}&bounds=24_5`,
    ).pipe(
      HttpClientRequest.setHeaders({ "User-Agent": USER_AGENT, Accept: "application/json" }),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown)),
      Effect.timeout(QUOTE_FETCH_TIMEOUT),
    );
    const quote = parseRobinhood(body, capturedAt);
    return quote === null ? null : { ...quote, symbol: quote.symbol || symbol };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logDebug("stock quote fetch failed", { symbol, source: "robinhood", cause }).pipe(
        Effect.as(null),
      ),
    ),
  );

const fetchFromCboe = (
  symbol: string,
  capturedAt: number,
): Effect.Effect<StockQuote | null, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const body = yield* HttpClientRequest.get(
      `${CBOE_QUOTE_BASE}${encodeURIComponent(symbol)}.json`,
    ).pipe(
      HttpClientRequest.setHeaders({ "User-Agent": USER_AGENT, Accept: "application/json" }),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown)),
      Effect.timeout(QUOTE_FETCH_TIMEOUT),
    );
    const quote = parseCboe(body, capturedAt);
    // Prefer the requested symbol when Cboe echoes an empty/odd data.symbol.
    return quote === null ? null : { ...quote, symbol: quote.symbol || symbol };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logDebug("stock quote fetch failed", { symbol, source: "cboe", cause }).pipe(
        Effect.as(null),
      ),
    ),
  );

const fetchFromYahoo = (
  symbol: string,
  capturedAt: number,
): Effect.Effect<StockQuote | null, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const body = yield* HttpClientRequest.get(
      `${YAHOO_CHART_BASE}${encodeURIComponent(symbol)}?interval=1d&range=1d`,
    ).pipe(
      HttpClientRequest.setHeaders({ "User-Agent": USER_AGENT, Accept: "application/json" }),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown)),
      Effect.timeout(QUOTE_FETCH_TIMEOUT),
    );
    const quote = parseYahooChart(body, capturedAt);
    // Prefer the requested symbol when Yahoo echoes an empty/odd meta.symbol.
    return quote === null ? null : { ...quote, symbol: quote.symbol || symbol };
  }).pipe(
    // Any HTTP/timeout/parse failure degrades to null so the caller can try the
    // next source (or serve the last known value) — a quote is best-effort.
    Effect.catchCause((cause) =>
      Effect.logDebug("stock quote fetch failed", { symbol, source: "yahoo", cause }).pipe(
        Effect.as(null),
      ),
    ),
  );

const fetchFromStooq = (
  symbol: string,
  capturedAt: number,
): Effect.Effect<StockQuote | null, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const csv = yield* HttpClientRequest.get(
      `${STOOQ_CSV_BASE}?s=${encodeURIComponent(toStooqSymbol(symbol))}&f=sd2t2ohlcv&e=csv`,
    ).pipe(
      HttpClientRequest.setHeaders({ "User-Agent": USER_AGENT }),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.timeout(QUOTE_FETCH_TIMEOUT),
    );
    const quote = parseStooqCsv(csv, capturedAt);
    return quote === null ? null : { ...quote, symbol };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logDebug("stock quote fetch failed", { symbol, source: "stooq", cause }).pipe(
        Effect.as(null),
      ),
    ),
  );

// Process-wide, per-symbol cache shared by every WebSocket connection. Mirrors
// the stale-on-error cache in `getClaudeAccountUsage`: a transient upstream
// failure keeps serving the last known price rather than blanking the ticker,
// and the TTL bounds upstream requests to once per symbol per window.
interface CacheEntry {
  value: StockQuote | null;
  freshUntilMs: number;
}
const cache = new Map<string, CacheEntry>();
// Cap distinct symbols so a client cycling through many tickers can't grow the
// cache without bound; Map preserves insertion order, so the first key is the
// least-recently-added and is evicted first.
const MAX_CACHE_ENTRIES = 128;

function writeCache(symbol: string, entry: CacheEntry): void {
  if (!cache.has(symbol) && cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(symbol, entry);
}

/**
 * Fetch a delayed quote for `symbol`, cached process-wide for
 * {@link QUOTE_CACHE_TTL_MS}. Tries Robinhood, Cboe, Yahoo, then Stooq. Never fails:
 * returns null (rendered as a muted dash) when the symbol is empty/malformed or
 * every source is unavailable. The read is best-effort telemetry.
 *
 * Upstream is polled at most once per symbol per TTL, even under concurrent
 * callers: the freshness window is reserved synchronously (no `yield` between
 * the cache read and the reservation write) before the fetch begins, so any
 * other fiber arriving in the same window sees a fresh entry and returns the
 * last known value instead of issuing its own request.
 */
export const readStockQuote = (
  symbol: string,
): Effect.Effect<StockQuoteResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const normalized = normalizeSymbol(symbol);
    if (normalized === null) {
      return null;
    }
    const nowMs = yield* Clock.currentTimeMillis;

    // ── Synchronous check-and-reserve (no `yield*` in this block) ──
    const cached = cache.get(normalized);
    if (cached !== undefined && nowMs < cached.freshUntilMs) {
      return cached.value;
    }
    const previousValue = cached?.value ?? null;
    const freshUntilMs = nowMs + QUOTE_CACHE_TTL_MS;
    // Reserve the window up front so concurrent callers coalesce onto this
    // single fetch and serve `previousValue` (stale, possibly null) meanwhile.
    writeCache(normalized, { value: previousValue, freshUntilMs });
    // ──────────────────────────────────────────────────────────────

    const capturedAt = Math.floor(nowMs / 1000);
    // Robinhood first (the only source with overnight prices); then Cboe (works
    // from datacenter IPs, price + percent change), Yahoo (price + derived
    // change), then Stooq (price only). Each source
    // self-recovers errors/empty parses to null, so a failing source always
    // falls through to the next one.
    const freshQuote = yield* fetchFromRobinhood(normalized, capturedAt).pipe(
      Effect.flatMap((quote) =>
        quote !== null
          ? Effect.succeed<StockQuote | null>(quote)
          : fetchFromCboe(normalized, capturedAt),
      ),
      Effect.flatMap((quote) =>
        quote !== null
          ? Effect.succeed<StockQuote | null>(quote)
          : fetchFromYahoo(normalized, capturedAt),
      ),
      Effect.flatMap((quote) =>
        quote !== null
          ? Effect.succeed<StockQuote | null>(quote)
          : fetchFromStooq(normalized, capturedAt),
      ),
    );

    // Keep the last known value on a total failure; only overwrite on success.
    const value = freshQuote ?? previousValue;
    writeCache(normalized, { value, freshUntilMs });
    return value;
  }).pipe(
    Effect.withSpan("readStockQuote"),
    Effect.orElseSucceed(() => null),
  );

/** Test-only: drop the process-wide cache so cases start clean. */
export function clearStockQuoteCacheForTests(): void {
  cache.clear();
}
