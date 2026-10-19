/**
 * Thread "channel" detection.
 *
 * Threads bridged in from an external service (the conversation gateway —
 * Slack first) get `slack-` thread ids, and until a generated title replaces
 * it their title carries a channel prefix such as `Slack: …` or `#channel: …`.
 * The sidebar uses this to decorate the row with a channel symbol so bridged
 * conversations are recognisable at a glance.
 */
export type ThreadChannel = "slack";

const SLACK_THREAD_ID_PREFIX = "slack-";
const SLACK_TITLE_PREFIX = /^\s*slack\s*:/iu;
const CHANNEL_TITLE_PREFIX = /^\s*(?:slack|#[\w-]+)\s*:/iu;

export function getThreadChannel(
  title: string | null | undefined,
  threadId?: string | null,
): ThreadChannel | null {
  if (threadId?.startsWith(SLACK_THREAD_ID_PREFIX)) return "slack";
  if (title && SLACK_TITLE_PREFIX.test(title)) return "slack";
  return null;
}

/** Title with the channel prefix removed (for variants that render the symbol instead of the word). */
export function stripThreadChannelPrefix(title: string): string {
  const stripped = title.replace(CHANNEL_TITLE_PREFIX, "").trimStart();
  return stripped.length > 0 ? stripped : title;
}
