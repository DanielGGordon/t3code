import type { StockQuoteResult } from "@t3tools/contracts";
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";

// Never poll the server (and thus the upstream) faster than its 15s cache TTL.
const REFRESH_INTERVAL_MS = 15_000;

/**
 * A single delayed stock quote for the header ticker, fetched server-side from
 * a free, keyless source and cached process-wide. Null while loading or when
 * the symbol is unknown / every source failed — render a muted dash then.
 * Gated by `enabled` (the ticker's visibility toggle) so a hidden ticker never
 * triggers server-side fetches. Changing `symbol` transparently swaps to a new
 * query. Refreshes on an interval and when the window regains focus.
 */
export function useStockQuote(enabled: boolean, symbol: string): StockQuoteResult {
  const environmentId = usePrimaryEnvironmentId();
  const trimmedSymbol = symbol.trim();
  const query = useEnvironmentQuery(
    enabled && trimmedSymbol.length > 0 && environmentId !== null
      ? serverEnvironment.stockQuote({ environmentId, input: { symbol: trimmedSymbol } })
      : null,
  );
  const refresh = query.refresh;

  useEffect(() => {
    if (!enabled || trimmedSymbol.length === 0) {
      return;
    }
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [enabled, trimmedSymbol, refresh]);

  return query.data;
}
