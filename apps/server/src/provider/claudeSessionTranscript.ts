import type { ThreadId } from "@t3tools/contracts";

/**
 * Helpers for reasoning about where Claude Code keeps a session's transcript
 * and for recognising the CLI's "transcript is gone" resume failure.
 *
 * Claude Code persists each session as
 * `~/.claude/projects/<encoded cwd>/<session id>.jsonl`, where the encoding
 * replaces every character outside `[A-Za-z0-9]` with `-`. When T3 resumes a
 * thread it passes `--resume <session id>`; if that file no longer exists on
 * this machine (the thread was imported from elsewhere, the host was
 * reprovisioned, the file was pruned) the CLI answers with a `result` error
 * whose text starts with `No conversation found with session ID:`. Without
 * special handling that message is immediately buried under the generic
 * "Claude runtime stream failed." that follows when the process exits, so the
 * user never learns what actually happened or how to fix it.
 */

export const CLAUDE_PROJECTS_DIR_DISPLAY = "~/.claude/projects";

const MISSING_RESUME_SESSION_PATTERN =
  /No conversation found with session ID:?\s*([0-9a-fA-F-]{36})/;

/**
 * Mirror Claude Code's project-directory encoding of a working directory.
 */
export function encodeClaudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Relative transcript location (`<encoded cwd>/<session id>.jsonl`) beneath a
 * Claude projects root. Callers join it onto the real root for filesystem
 * checks or onto the `~/.claude/projects` display form for messages.
 */
export function claudeTranscriptRelativePath(cwd: string, sessionId: string): string {
  return `${encodeClaudeProjectDirName(cwd)}/${sessionId}.jsonl`;
}

/**
 * Extract the session id from the CLI's missing-transcript resume failure, or
 * `undefined` when the error text is anything else.
 */
export function readMissingResumeSessionId(errorText: string | undefined): string | undefined {
  if (!errorText) return undefined;
  const match = MISSING_RESUME_SESSION_PATTERN.exec(errorText);
  return match?.[1]?.toLowerCase();
}

export interface MissingResumeTranscriptDetail {
  readonly reason: "resume_transcript_missing";
  readonly sessionId: string;
  readonly expectedTranscriptPath: string | undefined;
}

/**
 * Build the user-facing explanation for a resume that failed because the
 * transcript is missing. Deliberately does NOT clear or rewrite the resume
 * cursor: the transcript may still be recoverable from another machine, and
 * discarding the pointer would make that impossible. `t3 session reset` is
 * the explicit opt-in for starting over.
 */
export function describeMissingResumeTranscript(input: {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly cwd: string | undefined;
}): { readonly message: string; readonly detail: MissingResumeTranscriptDetail } {
  const expectedTranscriptPath =
    input.cwd !== undefined
      ? `${CLAUDE_PROJECTS_DIR_DISPLAY}/${claudeTranscriptRelativePath(input.cwd, input.sessionId)}`
      : undefined;
  const location =
    expectedTranscriptPath !== undefined
      ? `expected at ${expectedTranscriptPath}`
      : `expected under ${CLAUDE_PROJECTS_DIR_DISPLAY}`;
  const message =
    `Claude could not resume session ${input.sessionId}: its transcript is missing on this machine (${location}). ` +
    `The thread's history in T3 is intact, but Claude cannot continue it until the transcript is restored. ` +
    `Copy the .jsonl file back from the machine where the conversation ran (then just send again), ` +
    `or run \`t3 session reset ${input.threadId}\` to start a fresh Claude session without the earlier context.`;
  return {
    message,
    detail: {
      reason: "resume_transcript_missing",
      sessionId: input.sessionId,
      expectedTranscriptPath,
    },
  };
}
