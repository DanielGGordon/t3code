import { TextGenerationError } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const isTextGenerationError = Schema.is(TextGenerationError);
const decodeJsonThreadTitle = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String })),
);

/** Convert an Effect Schema to a flat JSON Schema object, inlining `$defs` when present. */
export function toJsonSchemaObject(schema: Schema.Top): unknown {
  // The type side, so decoding defaults do not turn required fields into
  // optional ones, and closed objects (`additionalProperties: false`):
  // structured-output modes require both, and closed was the generator
  // default before effect rc.113.
  const document = Schema.toJsonSchemaDocument(Schema.toType(schema), {
    onExcessProperty: "error",
  });
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

/** Truncate a text section to `maxChars`, appending a `[truncated]` marker when needed. */
export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

/** Normalise a raw commit subject to imperative-mood, ≤72 chars, no trailing period. */
export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

/** Normalise a raw PR title to a single line with a sensible fallback. */
export function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

// The sidebar shows roughly 35 characters. Prompts ask for at most 36; this cap
// is what makes the limit real, cutting at a word boundary instead of
// appending "..." (an ellipsis spends three of the few visible characters).
export const MAX_THREAD_TITLE_CHARS = 40;

/** Shorten to `max` characters at the last word boundary that keeps most of the text. */
function truncateAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const boundary = cut.lastIndexOf(" ");
  const shortened = boundary >= Math.floor(max / 2) ? cut.slice(0, boundary) : text.slice(0, max);
  return shortened.replace(/[\s,;:\-–—/&]+$/u, "");
}

/** Normalise a raw thread title to a single line of at most 40 characters. */
export function sanitizeThreadTitle(raw: string): string {
  // Unwrap a JSON-formatted title before truncation can cut off the closing brace.
  const decoded = decodeJsonThreadTitle(raw);
  const title = Option.isSome(decoded) ? decoded.value.title : raw;
  const normalized = title
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/u, "");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }
  return truncateAtWordBoundary(normalized, MAX_THREAD_TITLE_CHARS);
}

/**
 * Whether a generated title is fit to show. Rejects structural garbage the
 * model sometimes copies out of the message: slash commands, Slack mentions
 * and channel prefixes, the untrusted-content wrapper, and the placeholder.
 */
export function isUsableThreadTitle(title: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed === "New thread") return false;
  if (/^[$/]/u.test(trimmed)) return false;
  if (/^(?:#[\w-]+|slack)\s*:/iu.test(trimmed)) return false;
  if (/<@[A-Z0-9]+>|<<<|>>>|&(?:lt|gt|amp);/u.test(trimmed)) return false;
  return true;
}

/**
 * The placeholder shown until a generated title lands: the opening message
 * without bridge markup (the untrusted-content wrapper, `#channel:` prefixes,
 * Slack mentions, HTML entities), shortened like a generated title.
 */
export function cleanThreadTitleSeed(raw: string): string {
  const text = raw
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&")
    .replace(/<<<[^<>]*>>>/gu, " ")
    .replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(?:#[\w-]+|slack)\s*:\s*/iu, "");
  return truncateAtWordBoundary(text, MAX_THREAD_TITLE_CHARS) || "New thread";
}

/** CLI name to human-readable label, e.g. "codex" → "Codex CLI (`codex`)" */
function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

/**
 * Normalize an unknown error from a CLI text generation process into a
 * typed `TextGenerationError`. Parameterized by CLI name so both Codex
 * and Claude (and future providers) can share the same logic.
 */
export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (isTextGenerationError(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: fallback,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}
