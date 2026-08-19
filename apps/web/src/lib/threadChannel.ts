/**
 * Thread "channel" detection.
 *
 * Threads bridged in from an external service (the conversation gateway —
 * Slack first) are titled with a channel prefix such as `Slack: …`. The
 * sidebar uses this to decorate the row with a channel symbol so bridged
 * conversations are recognisable at a glance.
 */
export type ThreadChannel = "slack";

const SLACK_TITLE_PREFIX = /^\s*slack\s*:/iu;

export function getThreadChannel(title: string | null | undefined): ThreadChannel | null {
  if (!title) return null;
  if (SLACK_TITLE_PREFIX.test(title)) return "slack";
  return null;
}

/** Title with the channel prefix removed (for variants that render the symbol instead of the word). */
export function stripThreadChannelPrefix(title: string): string {
  const stripped = title.replace(SLACK_TITLE_PREFIX, "").trimStart();
  return stripped.length > 0 ? stripped : title;
}
