/**
 * restartRequestClassifier - Heuristic detection of "please restart the
 * server/service" asks in assistant messages.
 *
 * The orchestration RestartRequestReactor runs this over completed assistant
 * messages to raise a non-blocking "restart requested" flag on the chat. Because
 * the resulting UI (sidebar pill + sibling banner) never blocks anyone, we
 * optimize for recall with a few negative guards rather than perfect precision;
 * a human can always dismiss a false positive.
 */

export interface RestartRequestClassification {
  /** True when the message reads as the agent asking the human to restart. */
  readonly matched: boolean;
  /** Best-effort service/target the agent referred to, if we could extract one. */
  readonly reason: string | null;
}

const NO_MATCH: RestartRequestClassification = { matched: false, reason: null };

const RESTART_VERB = "(?:restart|reboot|bounce|relaunch)";
const TARGET =
  "(?:server|service|dev\\s+server|backend|api|app|application|process|daemon|container|machine|box|system|worker|database|db)";

// Phrasings that read as a request/instruction directed at the human.
const REQUEST_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(`\\bplease\\s+${RESTART_VERB}\\b`, "i"),
  new RegExp(`\\b(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?${RESTART_VERB}\\b`, "i"),
  new RegExp(
    `\\byou(?:'ll|'d| will| would| may need to| might need to| need to| should| have to)\\s+(?:to\\s+)?(?:manually\\s+)?${RESTART_VERB}\\b`,
    "i",
  ),
  new RegExp(`\\b(?:need|needs|requires?)\\s+(?:a\\s+|to\\s+be\\s+|to\\s+|manual\\s+)?${RESTART_VERB}`, "i"),
  new RegExp(`\\b(?:go ahead and|you can now|now)\\s+${RESTART_VERB}\\s+(?:the\\s+|your\\s+)?${TARGET}\\b`, "i"),
  new RegExp(`\\b${RESTART_VERB}\\s+(?:the\\s+|your\\s+|this\\s+)?${TARGET}\\b`, "i"),
];

// Guards against past-tense ("I restarted it") and negated ("no need to
// restart") mentions that should not raise the flag.
const NEGATION_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(`\\b(?:no|not|don'?t|doesn'?t|didn'?t|without|never|avoid|skip)\\b[^.?!\\n]*\\b${RESTART_VERB}`, "i"),
  new RegExp(`\\b(?:i|we|i've|we've|already|just|have|has|having)\\s+(?:already\\s+)?(?:restarted|rebooted|bounced|relaunched)\\b`, "i"),
];

const REASON_PATTERN = new RegExp(
  `\\b${RESTART_VERB}\\s+(?:the\\s+|your\\s+|this\\s+)?([a-z0-9][a-z0-9 ._/-]{1,48}?)(?=\\s+(?:so|to|for|because|and|then|now|in order|manually|before|after|once|which)\\b|[.?!,;:)]|$)`,
  "i",
);

const cleanReason = (raw: string): string | null => {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
};

/**
 * Classify a completed assistant message. Returns `matched: true` with an
 * optional extracted target when the text reads as an ask to restart something.
 */
export const classifyRestartRequest = (text: string): RestartRequestClassification => {
  if (text.trim().length === 0) {
    return NO_MATCH;
  }

  const matched = REQUEST_PATTERNS.some((pattern) => pattern.test(text));
  if (!matched) {
    return NO_MATCH;
  }

  if (NEGATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return NO_MATCH;
  }

  const reasonMatch = text.match(REASON_PATTERN);
  const reason = reasonMatch?.[1] ? cleanReason(reasonMatch[1]) : null;
  return { matched: true, reason };
};
