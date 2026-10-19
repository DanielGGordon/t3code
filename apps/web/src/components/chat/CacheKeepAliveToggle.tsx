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
  cacheKeptWarmByHeartbeat,
  formatCacheExpiry,
  promptCacheExpiresAtMs,
  type CacheKeepAliveState,
  type CacheKeepAliveThread,
} from "@t3tools/shared/cacheKeepAlive";
import { CirclePauseIcon, FlameIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { formatShortTimestamp } from "../../timestampFormat";
import { toastManager } from "../ui/toast";
import { Toggle } from "../ui/toggle";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const MAX = CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES;

// On reads as orange so it is obvious at a glance, not just a subtle highlight.
const ON_COMPOSER_CLASS_NAME =
  "aria-pressed:border-accent-orange/60 aria-pressed:bg-accent-orange/20 aria-pressed:text-accent-orange aria-pressed:hover:bg-accent-orange/30";

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

const HEARTBEAT_EXPLANATION =
  "The agent is babysitting background subagents and checks in on them every 15 minutes. Each check-in refreshes the prompt cache, and they stop on their own once the subagents finish.";

/** "55m" until the thread's prompt cache lapses, or null with no live cache. Ticks each minute. */
function useCacheExpiryLabel(thread: CacheKeepAliveThread | null): string | null {
  const nowMinute = useNowMinute();
  if (thread === null) return null;
  const nowMs = Date.parse(`${nowMinute}:00Z`);
  const expiresAtMs = promptCacheExpiresAtMs({ thread, nowMs });
  return expiresAtMs === null ? null : formatCacheExpiry(expiresAtMs - nowMs);
}

function CacheKeepAliveTooltipText(props: {
  readonly thread: CacheKeepAliveThread;
  readonly heartbeat: boolean;
  readonly nowMs: number;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const state = cacheKeepAliveState(props);
  if (props.heartbeat) {
    const alsoOn = state.kind !== "off" && state.kind !== "paused";
    return `Kept warm by the subagent heartbeat. ${HEARTBEAT_EXPLANATION}${alsoOn ? " Keep cache warm is also on and takes over after that." : ""}`;
  }
  const text = describe(state, (ms) =>
    formatShortTimestamp(new Date(ms).toISOString(), timestampFormat),
  );
  const expiresAtMs = promptCacheExpiresAtMs(props);
  return expiresAtMs === null
    ? text
    : `Prompt cache expires around ${formatShortTimestamp(new Date(expiresAtMs).toISOString(), timestampFormat)}. ${text}`;
}

/**
 * Fork: the per-thread "Keep cache warm" toggle. The server sends the pings
 * (with the browser closed too); this only flips the persisted toggle and
 * explains where the thread stands. While the subagent heartbeat is armed the
 * cache stays warm regardless, so the control reads as on and a click explains
 * why instead. `placement` picks the chrome: a header toggle button, or a
 * composer-footer control that sits next to the access mode.
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
  const expiryLabel = useCacheExpiryLabel(shell?.source ?? null);
  const heartbeat = shell !== null && cacheKeptWarmByHeartbeat(shell.source);
  const keepAlive = shell?.source.cacheKeepAlive ?? null;
  const keepAliveActive = keepAlive !== null && keepAlive.pausedAt === null;
  const handlePressedChange = useCallback(
    (enabled: boolean) => {
      if (heartbeat && !enabled) {
        // The heartbeat is the agent's own doing; only the toggle can go off.
        if (keepAliveActive) {
          void setCacheKeepAlive({ environmentId, input: { threadId, enabled: false } });
        }
        toastManager.add({
          type: "info",
          title: "Cache is being kept warm by the subagent heartbeat",
          description: `${HEARTBEAT_EXPLANATION}${keepAliveActive ? " Keep cache warm is now off, so pings won't continue after that." : ""}`,
        });
        return;
      }
      void setCacheKeepAlive({ environmentId, input: { threadId, enabled } });
    },
    [heartbeat, keepAliveActive, setCacheKeepAlive, environmentId, threadId],
  );
  if (shell === null || serverConfig?.environment.capabilities.threadCacheKeepAlive !== true) {
    return null;
  }
  const thread = shell.source;
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
  const paused = keepAlive !== null && keepAlive.pausedAt !== null && !heartbeat;
  // Paused reads as not pressed: pressing it resumes with a fresh budget.
  const pressed = heartbeat || keepAliveActive;
  const Icon = paused ? CirclePauseIcon : FlameIcon;
  const label = `${paused ? "Resume keeping the prompt cache warm" : "Keep cache warm"}${
    expiryLabel === null ? "" : `, cache expires in ${expiryLabel}`
  }`;
  return (
    <Tooltip onOpenChange={handleOpenChange}>
      <TooltipTrigger
        render={
          placement === "composer" ? (
            <ComposerControl
              size={props.composerSize ?? "sm"}
              className={ON_COMPOSER_CLASS_NAME}
              aria-pressed={pressed}
              aria-label={label}
              disabled={!canOperateThread}
              onClick={() => handlePressedChange(!pressed)}
            />
          ) : (
            <Toggle
              className="shrink-0 touch:size-12 touch:min-w-12 max-md:touch:size-10 max-md:touch:min-w-10"
              pressed={pressed}
              onPressedChange={handlePressedChange}
              disabled={!canOperateThread}
              aria-label={label}
              variant="outline-warm"
              size="xs"
            />
          )
        }
      >
        {placement === "composer" ? (
          <>
            <ComposerControlIcon
              icon={Icon}
              size={props.composerSize ?? "sm"}
              className={pressed ? "text-accent-orange" : undefined}
            />
            {expiryLabel !== null ? <span className="tabular-nums">{expiryLabel}</span> : null}
          </>
        ) : (
          <>
            <Icon className="size-3 touch:size-5" />
            {expiryLabel !== null ? (
              <span className="text-xs tabular-nums touch:text-sm">{expiryLabel}</span>
            ) : null}
          </>
        )}
      </TooltipTrigger>
      <TooltipPopup
        side={placement === "composer" ? "top" : "bottom"}
        className="max-w-72 whitespace-normal"
      >
        <CacheKeepAliveTooltipText thread={thread} heartbeat={heartbeat} nowMs={openedAtMs} />
      </TooltipPopup>
    </Tooltip>
  );
});
