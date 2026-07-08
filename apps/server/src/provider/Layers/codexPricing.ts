/**
 * Hardcoded Codex model pricing snapshot. The Codex app-server protocol
 * carries no cost fields (openai/codex#16258), so spend is estimated here
 * from token counts at API list prices.
 *
 * USD per 1M tokens; source: developers.openai.com/api/docs/pricing
 * (snapshot 2026-07-08). Needs manual refresh when OpenAI changes list
 * prices or ships new models. Unknown models return `undefined` (never
 * guess), which means they silently contribute $0 to a thread's spend
 * total — a Codex-only thread on an unknown model shows no Spend stat
 * rather than a wrong one. Sessions that accrue such unpriced tokens are
 * flagged via `costUsdIncomplete` on the emitted usage snapshot so the web
 * Spend stat can disclose partial coverage in mixed threads.
 *
 * Known-but-unpriceable models get an explicit `unpriced` row: as of the
 * snapshot date gpt-5.3-codex-spark is a ChatGPT-only research preview with
 * no published API list price, so it is deliberately excluded (not merely
 * unknown) rather than inheriting the gpt-5.3-codex row via prefix matching.
 *
 * Ordered so that longest-prefix matching works with a first-match scan
 * (more specific prefixes before their shorter parents).
 */
const CODEX_MODEL_PRICING: ReadonlyArray<
  | {
      readonly prefix: string;
      readonly input: number;
      readonly cachedInput: number;
      readonly output: number;
    }
  | {
      readonly prefix: string;
      /** Known model with no published API list price — never estimate. */
      readonly unpriced: true;
    }
> = [
  { prefix: "gpt-5.5-pro", input: 30, cachedInput: 30, output: 180 },
  { prefix: "gpt-5.5", input: 5, cachedInput: 0.5, output: 30 },
  { prefix: "gpt-5.4-pro", input: 30, cachedInput: 30, output: 180 },
  { prefix: "gpt-5.4-mini", input: 0.75, cachedInput: 0.075, output: 4.5 },
  { prefix: "gpt-5.4-nano", input: 0.2, cachedInput: 0.02, output: 1.25 },
  { prefix: "gpt-5.4", input: 2.5, cachedInput: 0.25, output: 15 },
  { prefix: "gpt-5.3-codex-spark", unpriced: true },
  { prefix: "gpt-5.3-codex", input: 1.75, cachedInput: 0.175, output: 14 },
];

/**
 * Estimate the API-equivalent USD cost of a Codex token usage breakdown.
 *
 * Returns `undefined` for unknown/unbound/unpriced models.
 * `reasoningOutputTokens` is already included inside `outputTokens` (OpenAI
 * Responses API semantics), so it must not be priced separately.
 */
export function estimateCodexCostUsd(
  model: string | undefined,
  usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
  },
): number | undefined {
  if (!model) {
    return undefined;
  }
  const pricing = CODEX_MODEL_PRICING.find((entry) => model.startsWith(entry.prefix));
  if (!pricing || "unpriced" in pricing) {
    return undefined;
  }
  const cached = Math.max(0, usage.cachedInputTokens);
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  const output = Math.max(0, usage.outputTokens);
  return (
    (uncachedInput * pricing.input + cached * pricing.cachedInput + output * pricing.output) / 1e6
  );
}
