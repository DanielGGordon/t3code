import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { memo, useCallback, useMemo, useState } from "react";
import { RotateCcwIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { useThreadShell, useThreadShellsForProjectRefs } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

const DISMISSAL_STORAGE_KEY = "t3:restart-banner-dismissals";

// Per-device dismissal of the "a sibling is asking for a restart" banner. Keyed
// by the requesting thread id so a fresh request from a different chat still
// shows. Best-effort — storage failures never block the banner.
function readDismissals(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(DISMISSAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function persistDismissal(threadId: string): void {
  try {
    const next = Array.from(new Set([...readDismissals(), threadId]));
    globalThis.localStorage?.setItem(DISMISSAL_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort UI state
  }
}

const describeService = (reason: string | null): string =>
  reason && reason.trim().length > 0 ? reason.trim() : "the service";

/**
 * Top-of-conversation banner surfacing "an AI agent is requesting a restart" for
 * the active chat and its project siblings (rung 2 of the restart-alert feature).
 * Never blocks sending — it only informs and offers manual clear/dismiss.
 */
export const RestartRequestBanner = memo(function RestartRequestBanner({
  environmentId,
  threadId,
  projectId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
}) {
  const currentShell = useThreadShell(useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  ));
  const siblingShells = useThreadShellsForProjectRefs(useMemo(
    () => [scopeProjectRef(environmentId, projectId)],
    [environmentId, projectId],
  ));
  const requestingSibling = siblingShells.find(
    (sibling) => sibling.id !== threadId && sibling.requestingRestart,
  );

  const currentRequesting = currentShell?.requestingRestart ?? false;
  const currentReason = currentShell?.restartRequestReason ?? null;
  const siblingReason = requestingSibling?.restartRequestReason ?? null;
  const siblingThreadId = requestingSibling?.id ?? null;

  const [dismissedThreadIds, setDismissedThreadIds] = useState<readonly string[]>(readDismissals);

  const handleDismissSibling = useCallback(() => {
    if (!siblingThreadId) return;
    persistDismissal(siblingThreadId);
    setDismissedThreadIds((current) =>
      current.includes(siblingThreadId) ? current : [...current, siblingThreadId],
    );
  }, [siblingThreadId]);

  const setRestartRequest = useAtomCommand(threadEnvironment.setRestartRequest, {
    reportFailure: false,
  });
  const handleMarkResolved = useCallback(() => {
    void setRestartRequest({
      environmentId,
      input: { threadId, requesting: false, source: "manual", reason: null },
    });
  }, [setRestartRequest, environmentId, threadId]);

  // The chat that raised the request gets a clear-it affordance.
  if (currentRequesting) {
    return (
      <div className="pt-3 mx-auto w-full max-w-3xl">
        <Alert variant="warning">
          <RotateCcwIcon />
          <AlertTitle>This chat asked you to restart {describeService(currentReason)}</AlertTitle>
          <AlertDescription>
            Other chats in this project are being warned to hold. Clear this once the restart is
            done.
          </AlertDescription>
          <AlertAction>
            <button
              type="button"
              className="inline-flex h-7 items-center rounded-md border border-warning/40 px-2 text-xs font-medium text-warning transition-colors hover:bg-warning/10"
              onClick={handleMarkResolved}
            >
              Mark resolved
            </button>
          </AlertAction>
        </Alert>
      </div>
    );
  }

  const siblingDismissed = siblingThreadId !== null && dismissedThreadIds.includes(siblingThreadId);
  if (siblingThreadId !== null && !siblingDismissed) {
    return (
      <div className="pt-3 mx-auto w-full max-w-3xl">
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>
            Another AI agent is requesting a restart of {describeService(siblingReason)}
          </AlertTitle>
          <AlertDescription>
            Hold if you can — a sibling chat in this project is waiting on a service restart.
          </AlertDescription>
          <AlertAction>
            <button
              type="button"
              aria-label="Dismiss restart warning"
              className="inline-flex size-6 items-center justify-center rounded-md text-warning/60 transition-colors hover:text-warning"
              onClick={handleDismissSibling}
            >
              <XIcon className="size-3.5" />
            </button>
          </AlertAction>
        </Alert>
      </div>
    );
  }

  return null;
});
