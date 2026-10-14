import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES,
  cacheKeepAliveState,
  cacheKeepAliveSupportsDriver,
  type CacheKeepAliveState,
  type CacheKeepAliveThread,
} from "@t3tools/shared/cacheKeepAlive";
import { CirclePauseIcon, FlameIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { formatShortTimestamp } from "../../timestampFormat";
import { Toggle } from "../ui/toggle";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const MAX = CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES;

function describe(state: CacheKeepAliveState, formatTime: (ms: number) => string): string {
  switch (state.kind) {
    case "off":
      return `Keep cache warm: ping this Claude thread shortly before its one-hour prompt cache expires, so your next message stays cheap. Stops after ${MAX} pings with no message from you.`;
    case "paused":
      return `Keep cache warm is paused after ${state.nudgeCount} pings with no message from you. Send a message or click to resume.`;
    case "unsupported":
      return "Keep cache warm is on, but no Claude session on this thread's current provider holds the conversation (for example after switching provider or account), so there is no cache to keep yet. Click to turn off.";
    case "parked":
      return "Keep cache warm is on, but this thread is archived, settled or snoozed, so it is not pinged. Click to turn off.";
    case "busy":
      return "Keeping the prompt cache warm. The next ping is scheduled once this turn finishes and nothing waits on you. Click to turn off.";
    case "cold":
      return "Keeping the prompt cache warm, but there is no live cache right now; pings resume after the next turn. Click to turn off.";
    case "scheduled":
      return `Keeping the prompt cache warm. Next ping around ${formatTime(state.nudgeAtMs)} (${state.nudgeCount} of ${MAX} sent since your last message). Click to turn off.`;
    case "due":
      return "Keeping the prompt cache warm. Sending a ping now. Click to turn off.";
  }
}

function CacheKeepAliveTooltipText(props: {
  readonly thread: CacheKeepAliveThread;
  readonly nowMs: number;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const state = cacheKeepAliveState(props);
  return describe(state, (ms) => formatShortTimestamp(new Date(ms).toISOString(), timestampFormat));
}

/**
 * Fork: the per-thread "Keep cache warm" toggle. The server sends the pings
 * (with the browser closed too); this only flips the persisted toggle and
 * explains where the thread stands. `placement` picks the chrome: a header
 * toggle button, or a composer-footer control that sits next to the access
 * mode.
 */
export const CacheKeepAliveToggle = memo(function CacheKeepAliveToggle(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly placement: "header" | "composer";
  readonly composerSize?: ComposerControlSize;
}) {
  const { environmentId, threadId, placement } = props;
  const shell = useThreadShell(
    useMemo(() => scopeThreadRef(environmentId, threadId), [environmentId, threadId]),
  );
  const serverConfig = useServerConfigs().get(environmentId);
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const setCacheKeepAlive = useOrchestrationCommand(threadEnvironment.setCacheKeepAlive);
  // The tooltip judges the thread against the clock read when it opens.
  const [openedAtMs, setOpenedAtMs] = useState(0);
  const handleOpenChange = useCallback((open: boolean) => {
    if (open) setOpenedAtMs(Date.now());
  }, []);
  const handlePressedChange = useCallback(
    (enabled: boolean) => {
      void setCacheKeepAlive({ environmentId, input: { threadId, enabled } });
    },
    [setCacheKeepAlive, environmentId, threadId],
  );
  if (shell === null || serverConfig?.environment.capabilities.threadCacheKeepAlive !== true) {
    return null;
  }
  const thread = shell.source;
  const keepAlive = thread.cacheKeepAlive ?? null;
  // Offered while off on threads set to a Claude instance; while on it always
  // shows, so it can be turned off. Where the thread stands comes from the
  // server's cacheKeepAliveContext, the same answer the server pings by.
  if (
    keepAlive === null &&
    !cacheKeepAliveSupportsDriver(
      serverConfig.providers.find((provider) => provider.instanceId === thread.providerInstanceId)
        ?.driver,
    )
  ) {
    return null;
  }
  const paused = keepAlive !== null && keepAlive.pausedAt !== null;
  // Paused reads as not pressed: pressing it resumes with a fresh budget.
  const pressed = keepAlive !== null && !paused;
  const Icon = paused ? CirclePauseIcon : FlameIcon;
  const label = paused ? "Resume keeping the prompt cache warm" : "Keep cache warm";
  return (
    <Tooltip onOpenChange={handleOpenChange}>
      <TooltipTrigger
        render={
          placement === "composer" ? (
            <ComposerControl
              size={props.composerSize ?? "sm"}
              aria-pressed={pressed}
              aria-label={label}
              disabled={!canOperateThread}
              onClick={() => handlePressedChange(!pressed)}
            />
          ) : (
            <Toggle
              className="shrink-0 touch:size-12 touch:min-w-12"
              pressed={pressed}
              onPressedChange={handlePressedChange}
              disabled={!canOperateThread}
              aria-label={label}
              variant="outline"
              size="xs"
            />
          )
        }
      >
        {placement === "composer" ? (
          <ComposerControlIcon icon={Icon} size={props.composerSize ?? "sm"} />
        ) : (
          <Icon className="size-3 touch:size-5" />
        )}
      </TooltipTrigger>
      <TooltipPopup
        side={placement === "composer" ? "top" : "bottom"}
        className="max-w-72 whitespace-normal"
      >
        <CacheKeepAliveTooltipText thread={thread} nowMs={openedAtMs} />
      </TooltipPopup>
    </Tooltip>
  );
});
