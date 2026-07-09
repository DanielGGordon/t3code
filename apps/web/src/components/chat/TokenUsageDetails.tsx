import {
  type ContextWindowSnapshot,
  formatContextWindowTokens,
  formatPercentage,
} from "~/lib/contextWindow";

function lastTurnSummary(usage: ContextWindowSnapshot): string | null {
  const lastInputTokens = usage.lastInputTokens ?? null;
  const lastCachedInputTokens = usage.lastCachedInputTokens ?? null;
  const lastOutputTokens = usage.lastOutputTokens ?? null;
  const parts: string[] = [];
  if (lastInputTokens !== null) {
    const cached =
      lastCachedInputTokens !== null && lastCachedInputTokens > 0
        ? ` (${formatContextWindowTokens(lastCachedInputTokens)} cached)`
        : "";
    parts.push(`${formatContextWindowTokens(lastInputTokens)} in${cached}`);
  }
  if (lastOutputTokens !== null) {
    parts.push(`${formatContextWindowTokens(lastOutputTokens)} out`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function TokenUsageDetails(props: { usage: ContextWindowSnapshot; heading: string }) {
  const { usage, heading } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const maxTokens = usage.maxTokens ?? null;
  const totalTokens = usage.threadTotalTokens;
  const lastTurn = lastTurnSummary(usage);

  return (
    <div className="space-y-1.5 leading-tight">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {heading}
      </div>
      {maxTokens !== null && usedPercentage ? (
        <div className="whitespace-nowrap text-xs font-medium text-foreground">
          <span>{usedPercentage}</span>
          <span className="mx-1">⋅</span>
          <span>{formatContextWindowTokens(usage.usedTokens)}</span>
          <span>/</span>
          <span>{formatContextWindowTokens(maxTokens)} context used</span>
        </div>
      ) : (
        <div className="text-xs font-medium text-foreground">
          {formatContextWindowTokens(usage.usedTokens)} tokens in context
        </div>
      )}
      {totalTokens > usage.usedTokens ? (
        <div className="text-xs text-muted-foreground">
          Total processed: {formatContextWindowTokens(totalTokens)} tokens
        </div>
      ) : null}
      {lastTurn ? <div className="text-xs text-muted-foreground">Last turn: {lastTurn}</div> : null}
      {usage.compactsAutomatically ? (
        <div className="text-xs text-muted-foreground">
          Automatically compacts its context when needed.
        </div>
      ) : null}
    </div>
  );
}
