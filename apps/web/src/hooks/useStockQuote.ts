import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, StockQuoteResult } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { serverEnvironment } from "../state/server";

// The server caches upstream for 15s, so every poll at this rate sees a fresh quote.
const REFRESH_INTERVAL_MS = 20_000;
// How long each symbol stays on screen before the next one swaps in. Swapping
// never fetches: all symbols are polled on REFRESH_INTERVAL_MS regardless.
const ROTATE_INTERVAL_MS = 5_000;
const MAX_SYMBOLS = 8;

/** "tsla, spy spcx" → ["TSLA", "SPY", "SPCX"]: split on commas/whitespace, uppercase, de-duplicate, cap. */
export function parseStockSymbols(raw: string): string[] {
  const symbols = raw
    .split(/[\s,]+/)
    .map((symbol) => symbol.toUpperCase())
    .filter((symbol) => symbol.length > 0);
  return [...new Set(symbols)].slice(0, MAX_SYMBOLS);
}

const quoteAtoms = new Map<string, Atom.Atom<ReadonlyArray<StockQuoteResult>>>();

// One derived atom per (environment, symbol list) so a hook can read a variable
// number of per-symbol queries without a variable number of hook calls.
function stockQuotesAtom(environmentId: EnvironmentId, symbols: ReadonlyArray<string>) {
  const key = `${environmentId}\n${symbols.join(",")}`;
  let atom = quoteAtoms.get(key);
  if (atom === undefined) {
    atom = Atom.make((get) =>
      symbols.map((symbol) =>
        AsyncResult.getOrElse(
          get(serverEnvironment.stockQuote({ environmentId, input: { symbol } })),
          () => null,
        ),
      ),
    );
    quoteAtoms.set(key, atom);
  }
  return atom;
}

const NO_QUOTES_ATOM = Atom.make<ReadonlyArray<StockQuoteResult>>([]);

/**
 * The header ticker. With several symbols the displayed one rotates every 5s
 * while all of them are polled every 20s and on window focus. `quote` is null
 * while loading or when every source failed. A disabled ticker never fetches.
 */
export function useStockTicker(
  enabled: boolean,
  rawSymbols: string,
): { readonly symbol: string; readonly quote: StockQuoteResult } {
  const environmentId = usePrimaryEnvironmentId();
  const registry = useContext(RegistryContext);
  const symbols = parseStockSymbols(rawSymbols);
  const symbolsKey = symbols.join(",");
  const active = enabled && symbols.length > 0;
  const quotes = useAtomValue(
    active && environmentId !== null ? stockQuotesAtom(environmentId, symbols) : NO_QUOTES_ATOM,
  );

  const [rotation, setRotation] = useState(0);
  const rotates = enabled && symbols.length > 1;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timers are external to React
  useEffect(() => {
    if (!rotates) {
      return;
    }
    const interval = setInterval(() => setRotation((index) => index + 1), ROTATE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [rotates]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polling and window focus are external to React
  useEffect(() => {
    if (!active || environmentId === null) {
      return;
    }
    const refresh = () => {
      for (const symbol of symbolsKey.split(",")) {
        registry.refresh(serverEnvironment.stockQuote({ environmentId, input: { symbol } }));
      }
    };
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [active, environmentId, registry, symbolsKey]);

  const index = symbols.length > 0 ? rotation % symbols.length : 0;
  return { symbol: symbols[index] ?? "", quote: quotes[index] ?? null };
}
