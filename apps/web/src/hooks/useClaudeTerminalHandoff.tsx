import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useCopyToClipboard } from "./useCopyToClipboard";

const describe = (error: unknown) =>
  error instanceof Error ? error.message : "An error occurred.";

/** Fork: hand a Claude thread to the Claude Code CLI and bring the CLI's turns back. */
export function useClaudeTerminalHandoff() {
  const handOff = useAtomCommand(threadEnvironment.claudeTerminalHandoff, {
    reportFailure: false,
  });
  const pull = useAtomCommand(threadEnvironment.claudeTerminalPull, { reportFailure: false });
  const { copyToClipboard } = useCopyToClipboard<{ command: string }>({
    target: "command",
    onCopy: ({ command }) => {
      toastManager.add({ type: "success", title: "Command copied", description: command });
    },
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy the command",
          description: error.message,
        }),
      ),
  });

  const continueInTerminal = async (threadRef: ScopedThreadRef) => {
    const result = await handOff({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not continue in Claude Code",
          description: describe(squashAtomCommandFailure(result)),
        }),
      );
      return;
    }
    const { command, keepAliveStopped } = result.value;
    // The click's activation is spent by now, so copying waits for the button.
    const toastId = toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "Continue in Claude Code",
        description: (
          <span className="whitespace-pre-line">
            {[
              command,
              "Run it where T3 runs. Your terminal turns come back here with the Claude Code hook, or with Sync terminal turns.",
              ...(keepAliveStopped ? ["Cache keep-alive is now off for this thread."] : []),
            ].join("\n\n")}
          </span>
        ),
        timeout: 0,
        actionProps: {
          children: "Copy command",
          onClick: () => {
            toastManager.close(toastId);
            copyToClipboard(command, { command });
          },
        },
      }),
    );
  };

  const syncTerminalTurns = async (threadRef: ScopedThreadRef) => {
    const result = await pull({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not sync from Claude Code",
          description: describe(squashAtomCommandFailure(result)),
        }),
      );
      return;
    }
    const { appended } = result.value;
    toastManager.add({
      type: "success",
      title:
        appended === 0
          ? "No new terminal turns"
          : `Synced ${appended} message${appended === 1 ? "" : "s"} from Claude Code`,
    });
  };

  return { continueInTerminal, syncTerminalTurns };
}
