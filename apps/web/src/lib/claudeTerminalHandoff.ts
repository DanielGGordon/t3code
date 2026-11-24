import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

/** Fork: the thread's conversation is a Claude session the Claude Code CLI can resume. */
export function isClaudeSessionThread(thread: EnvironmentThreadShell): boolean {
  return (
    thread.activeProviderThreadId !== null &&
    thread.source.cacheKeepAliveContext?.driver === "claudeAgent"
  );
}
