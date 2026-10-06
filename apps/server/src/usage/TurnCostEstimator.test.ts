import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type TurnTokenUsage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as TurnCostEstimator from "./TurnCostEstimator.ts";
import * as UsageService from "./UsageService.ts";
import { createOverrideRateTable, parseRateTable } from "./usagePricing.ts";

// $1/M input, $0.1/M cache read, $1.25/M cache write, $10/M output; priority 2x.
const rates = parseRateTable({
  "gpt-test": {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6,
    input_cost_per_token_priority: 2e-6,
    output_cost_per_token_priority: 2e-5,
  },
});

const usage: TurnTokenUsage = {
  usageStatus: "complete",
  usageScope: "main_agent",
  hasSubagents: false,
  // 1M input of which 600k cache reads and 100k cache writes.
  inputTokens: 1_000_000,
  cachedInputTokens: 600_000,
  cacheCreationTokens: 100_000,
  outputTokens: 100_000,
};

describe("estimateTurnCost", () => {
  it("splits cache reads and writes out of input before pricing", () => {
    const estimate = TurnCostEstimator.estimateTurnCost({
      rates,
      model: "gpt-test",
      speed: "standard",
      turnTokenUsage: usage,
    });
    // 0.3 uncached + 0.06 cache read + 0.125 cache write + 1.0 output
    assert.closeTo(estimate.costUsd ?? -1, 1.485, 1e-9);
    assert.isFalse(estimate.incomplete);
  });

  it("flags unknown models, unavailable usage and partial usage", () => {
    assert.deepEqual(
      TurnCostEstimator.estimateTurnCost({
        rates,
        model: "unknown-model",
        speed: "standard",
        turnTokenUsage: usage,
      }),
      { costUsd: undefined, incomplete: true },
    );
    assert.deepEqual(
      TurnCostEstimator.estimateTurnCost({
        rates,
        model: "gpt-test",
        speed: "standard",
        turnTokenUsage: {
          usageStatus: "unavailable",
          usageScope: "main_agent",
          hasSubagents: false,
        },
      }),
      { costUsd: undefined, incomplete: true },
    );
    const partial = TurnCostEstimator.estimateTurnCost({
      rates,
      model: "gpt-test",
      speed: "standard",
      turnTokenUsage: { ...usage, usageStatus: "partial" },
    });
    assert.isDefined(partial.costUsd);
    assert.isTrue(partial.incomplete);
  });

  it("prefers the user's price override", () => {
    const estimate = TurnCostEstimator.estimateTurnCost({
      rates: new Map(),
      overrides: createOverrideRateTable({
        "gpt-test": { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 1 },
      }),
      model: "gpt-test",
      speed: "standard",
      turnTokenUsage: usage,
    });
    assert.closeTo(estimate.costUsd ?? -1, 1.1, 1e-9);
  });
});

describe("TurnCostEstimator.layer", () => {
  const layerUsage = Layer.succeed(UsageService.UsageService, {
    readSummary: () => Effect.die("unused"),
    refreshRates: Effect.die("unused"),
    pricingTables: Effect.succeed({ rates, overrides: new Map() }),
  });

  it.effect("prices Codex fast mode at the priority tier", () =>
    Effect.gen(function* () {
      const estimator = yield* TurnCostEstimator.TurnCostEstimator;
      const fast = yield* estimator.estimate({
        driver: ProviderDriverKind.make("codex"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-test",
          options: [{ id: "fastMode", value: true }],
        },
        turnTokenUsage: { ...usage, cachedInputTokens: 0, cacheCreationTokens: 0 },
      });
      // 1M input at $2/M + 100k output at $20/M
      assert.closeTo(fast?.costUsd ?? -1, 4, 1e-9);
    }).pipe(Effect.provide(TurnCostEstimator.layer.pipe(Layer.provide(layerUsage)))),
  );

  it.effect("prices nothing by default", () =>
    Effect.gen(function* () {
      const estimator = yield* TurnCostEstimator.TurnCostEstimator;
      const estimate = yield* estimator.estimate({
        driver: ProviderDriverKind.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
        turnTokenUsage: usage,
      });
      assert.isUndefined(estimate);
    }),
  );
});
