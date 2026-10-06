/**
 * Fork (thread spend): prices one provider turn's token usage against the
 * LiteLLM rate table `UsageService` already maintains for the usage page.
 *
 * Claude reports its own cost (`total_cost_usd`, see ClaudeAdapterV2), so this
 * only fills turns that arrive without `costUsd` — Codex and the other
 * token-reporting drivers. The result is an API-equivalent estimate, not a
 * bill.
 *
 * Exposed as a `Context.Reference` whose default prices nothing, so every
 * layer that builds the provider event ingestor (tests, CLI runtimes) keeps
 * working unchanged; the server provides `layer` for real pricing.
 *
 * @module TurnCostEstimator
 */
import type { ModelSelection, ProviderDriverKind, TurnTokenUsage } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import * as UsageService from "./UsageService.ts";
import { priceUsage, type RateTable } from "./usagePricing.ts";
import { codexSpeed, type UsageSpeed } from "./usageTranscripts.ts";

export interface TurnCostEstimate {
  /** Undefined when nothing could be priced. */
  readonly costUsd: number | undefined;
  /** True when some of the turn's tokens are unpriced or unknown. */
  readonly incomplete: boolean;
}

export interface TurnCostEstimateInput {
  readonly driver: ProviderDriverKind;
  readonly modelSelection: ModelSelection;
  readonly turnTokenUsage: TurnTokenUsage;
}

/** Pure pricing of one turn. Exported for tests. */
export function estimateTurnCost(input: {
  readonly rates: RateTable;
  readonly overrides?: RateTable;
  readonly model: string;
  readonly speed: UsageSpeed;
  readonly turnTokenUsage: TurnTokenUsage;
}): TurnCostEstimate {
  const usage = input.turnTokenUsage;
  if (
    usage.usageStatus === "unavailable" ||
    usage.inputTokens === undefined ||
    usage.outputTokens === undefined
  ) {
    return { costUsd: undefined, incomplete: true };
  }
  // TurnTokenUsage input includes cache reads and writes; split them back out.
  const cachedInputTokens = Math.min(usage.inputTokens, usage.cachedInputTokens ?? 0);
  const cacheCreationTokens = Math.min(
    usage.inputTokens - cachedInputTokens,
    usage.cacheCreationTokens ?? 0,
  );
  const priced = priceUsage(
    input.rates,
    {
      model: input.model,
      speed: input.speed,
      reportedCostUsd: null,
      totals: {
        uncachedInputTokens: usage.inputTokens - cachedInputTokens - cacheCreationTokens,
        cachedInputTokens,
        cacheCreationTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens ?? 0,
      },
    },
    input.overrides,
  );
  if (priced.costSource === "unpriced") return { costUsd: undefined, incomplete: true };
  return { costUsd: priced.costUsd, incomplete: usage.usageStatus !== "complete" };
}

function speedFor(driver: ProviderDriverKind, modelSelection: ModelSelection): UsageSpeed {
  return driver === "codex"
    ? codexSpeed(getCodexServiceTierOptionValue(modelSelection))
    : "standard";
}

export interface TurnCostEstimatorShape {
  /** Undefined when this estimator does not price turns at all. */
  readonly estimate: (input: TurnCostEstimateInput) => Effect.Effect<TurnCostEstimate | undefined>;
}

export class TurnCostEstimator extends Context.Reference<TurnCostEstimatorShape>(
  "t3/usage/TurnCostEstimator",
  { defaultValue: () => ({ estimate: () => Effect.succeed(undefined) }) },
) {}

/** Prices nothing; turns keep whatever cost their adapter reported. */
export const layerNoop = Layer.succeed(TurnCostEstimator, {
  estimate: () => Effect.succeed(undefined),
});

export const layer = Layer.effect(
  TurnCostEstimator,
  Effect.gen(function* () {
    const usage = yield* UsageService.UsageService;
    return {
      estimate: (input) =>
        usage.pricingTables.pipe(
          Effect.map(({ rates, overrides }) =>
            estimateTurnCost({
              rates,
              overrides,
              model: input.modelSelection.model,
              speed: speedFor(input.driver, input.modelSelection),
              turnTokenUsage: input.turnTokenUsage,
            }),
          ),
          Effect.withSpan("TurnCostEstimator.estimate"),
        ),
    } satisfies TurnCostEstimatorShape;
  }),
);
