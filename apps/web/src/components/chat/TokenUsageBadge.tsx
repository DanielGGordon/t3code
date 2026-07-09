import { CoinsIcon } from "lucide-react";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { HeaderStatBadge } from "./HeaderStatBadge";
import { TokenUsageDetails } from "./TokenUsageDetails";

export function TokenUsageBadge(props: { usage: ContextWindowSnapshot }) {
  const { usage } = props;

  return (
    <HeaderStatBadge
      ariaLabel={`Thread token usage ${formatContextWindowTokens(usage.threadTotalTokens)} tokens`}
      trigger={
        <>
          <CoinsIcon className="size-3" />
          <span>{formatContextWindowTokens(usage.threadTotalTokens)}</span>
        </>
      }
    >
      <TokenUsageDetails usage={usage} heading="Token usage" />
    </HeaderStatBadge>
  );
}
