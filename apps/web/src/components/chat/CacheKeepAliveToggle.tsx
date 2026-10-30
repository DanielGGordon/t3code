import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES,
  cacheKeepAliveActive,
  cacheKeepAliveMode,
  cacheKeepAliveState,
  cacheKeepAliveSupportsDriver,
  cacheKeptWarmByHeartbeat,
  formatCacheExpiry,
  promptCacheExpiresAtMs,
  type CacheKeepAliveMode,
  type CacheKeepAliveState,
  type CacheKeepAliveThread,
} from "@t3tools/shared/cacheKeepAlive";
import { CirclePauseIcon, FlameIcon, FlameKindlingIcon, FoldVerticalIcon } from "lucide-react";
import { memo, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { formatShortTimestamp } from "../../timestampFormat";
import { toastManager } from "../ui/toast";
import { Toggle } from "../ui/toggle";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const MAX = CACHE_KEEP_ALIVE_MAX_CONSECUTIVE_NUDGES;

// Each mode has its own colour so it reads at a glance: orange keeps the cache
// warm, blue compacts before it lapses, violet does the first and then the second.
const MODES = {
  warm: {
    icon: FlameIcon,
    iconClassName: "text-accent-orange",
    toggleVariant: "outline-warm",
    composerClassName:
      "aria-pressed:border-accent-orange/60 aria-pressed:bg-accent-orange/20 aria-pressed:text-accent-orange aria-pressed:hover:bg-accent-orange/30",
  },
  compact: {
    icon: FoldVerticalIcon,
    iconClassName: "text-accent-blue",
    toggleVariant: "outline-blue",
    composerClassName:
      "aria-pressed:border-accent-blue/60 aria-pressed:bg-accent-blue/20 aria-pressed:text-accent-blue aria-pressed:hover:bg-accent-blue/30",
  },
  "warm-then-compact": {
    icon: FlameKindlingIcon,
    iconClassName: "text-accent-violet",
    toggleVariant: "outline-violet",
    composerClassName:
      "aria-pressed:border-accent-violet/60 aria-pressed:bg-accent-violet/20 aria-pressed:text-accent-violet aria-pressed:hover:bg-accent-violet/30",
  },
} as const satisfies Record<CacheKeepAliveMode, object>;

type ToggleChoice = CacheKeepAliveMode | "off";

/** One click moves along this ring; servers without the compact modes only know off and warm. */
function nextChoice(current: ToggleChoice, compactModes: boolean): ToggleChoice {
  if (!compactModes) return current === "off" ? "warm" : "off";
  switch (current) {
    case "off":
      return "warm";
    case "warm":
      return "compact";
    case "compact":
      return "warm-then-compact";
    case "warm-then-compact":
      return "off";
  }
}

const CLICK_OUTCOME: Record<ToggleChoice, string> = {
  off: "turn it off",
  warm: "keep the cache warm",
  compact: "compact shortly before the cache expires instead",
  "warm-then-compact": `keep it warm, then compact when the ${MAX} pings run out`,
};

function describe(
  state: CacheKeepAliveState,
  mode: CacheKeepAliveMode,
  formatTime: (ms: number) => string,
  next: ToggleChoice,
): string {
  const click = ` Click to ${CLICK_OUTCOME[next]}.`;
  const then =
    mode === "warm-then-compact" ? " Then it compacts before the last cache expires." : "";
  switch (state.kind) {
    case "off":
      return `Keep cache warm: ping this Claude thread shortly before its one-hour prompt cache expires, so your next message stays cheap. Stops after ${MAX} pings with no message from you. Click to ${CLICK_OUTCOME[next]}.`;
    case "paused":
      return `Keep cache warm is paused after ${state.nudgeCount} pings with no message from you. Send a message or click to resume.`;
    case "unsupported":
      return `This is on, but no Claude session on this thread's current provider holds the conversation (for example after switching provider or account), so there is no cache to keep yet.${click}`;
    case "parked":
      return `This is on, but this thread is archived, settled or snoozed, so it is left alone.${click}`;
    case "busy":
      return `Keeping the prompt cache warm. The next step is scheduled once this turn finishes and nothing waits on you.${click}`;
    case "cold":
      return `This is on, but there is no live cache right now; it resumes after the next turn.${click}`;
    case "scheduled":
      return `Keeping the prompt cache warm. Next ping around ${formatTime(state.nudgeAtMs)} (${state.nudgeCount} of ${MAX} sent since your last message).${then}${click}`;
    case "due":
      return `Keeping the prompt cache warm. Sending a ping now.${click}`;
    case "compact-scheduled":
      return `Will compact this conversation around ${formatTime(state.compactAtMs)}, shortly before its prompt cache expires, unless you write first.${click}`;
    case "compact-due":
      return `Compacting now, while the prompt cache is still warm.${click}`;
    case "compacted":
      return `Compacted before the cache expired. Nothing more happens until you write again.${click}`;
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
  readonly compactModes: boolean;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const state = cacheKeepAliveState(props);
  if (props.heartbeat) {
    const alsoOn = state.kind !== "off" && state.kind !== "paused";
    return `Kept warm by the subagent heartbeat. ${HEARTBEAT_EXPLANATION}${alsoOn ? " Keep cache warm is also on and takes over after that." : ""}`;
  }
  const mode = cacheKeepAliveMode(props.thread.cacheKeepAlive);
  const current: ToggleChoice = cacheKeepAliveActive(props.thread.cacheKeepAlive) ? mode : "off";
  const text = describe(
    state,
    mode,
    (ms) => formatShortTimestamp(new Date(ms).toISOString(), timestampFormat),
    nextChoice(current, props.compactModes),
  );
  const expiresAtMs = promptCacheExpiresAtMs(props);
  return expiresAtMs === null
    ? text
    : `Prompt cache expires around ${formatShortTimestamp(new Date(expiresAtMs).toISOString(), timestampFormat)}. ${text}`;
}

/**
 * Fork: the per-thread "Keep cache warm" toggle. The server sends the pings
 * and compactions (with the browser closed too); this only flips the persisted
 * toggle and explains where the thread stands. A click steps through off, keep
 * warm, compact before the cache expires, and keep warm then compact. While the subagent heartbeat is armed the
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
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  const serverConfig = useServerConfigs().get(environmentId);
  const providers = useEnvironmentProviders().get(environmentId);
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const setCacheKeepAlive = useOrchestrationCommand(threadEnvironment.setCacheKeepAlive);
  // The tooltip judges the thread against the clock read when it opens.
  const [openedAtMs, setOpenedAtMs] = useState(0);
  const handleOpenChange = (open: boolean) => {
    if (open) setOpenedAtMs(Date.now());
  };
  const expiryLabel = useCacheExpiryLabel(shell?.source ?? null);
  const heartbeat = shell !== null && cacheKeptWarmByHeartbeat(shell.source);
  const keepAlive = shell?.source.cacheKeepAlive ?? null;
  const keepAliveActive = cacheKeepAliveActive(keepAlive);
  const mode = cacheKeepAliveMode(keepAlive);
  const compactModes = serverConfig?.environment.capabilities.threadCacheKeepAliveCompact === true;
  const handleClick = () => {
    const next = nextChoice(keepAliveActive ? mode : "off", compactModes);
    if (heartbeat && (next === "off" || !keepAliveActive)) {
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
    void setCacheKeepAlive({
      environmentId,
      input:
        next === "off" ? { threadId, enabled: false } : { threadId, enabled: true, mode: next },
    });
  };
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
      providers?.find((provider) => provider.instanceId === thread.providerInstanceId)?.driver,
    )
  ) {
    return null;
  }
  const paused = keepAlive !== null && !keepAliveActive && !heartbeat;
  // Paused reads as not pressed: pressing it resumes with a fresh budget.
  const pressed = heartbeat || keepAliveActive;
  const style = MODES[keepAliveActive ? mode : "warm"];
  const Icon = paused ? CirclePauseIcon : style.icon;
  const modeLabel = !keepAliveActive
    ? "Keep cache warm"
    : mode === "compact"
      ? "Compact before the cache expires"
      : mode === "warm-then-compact"
        ? "Keep cache warm, then compact"
        : "Keep cache warm";
  const label = `${paused ? "Resume keeping the prompt cache warm" : modeLabel}${
    expiryLabel === null ? "" : `, cache expires in ${expiryLabel}`
  }`;
  return (
    <Tooltip onOpenChange={handleOpenChange}>
      <TooltipTrigger
        render={
          placement === "composer" ? (
            <ComposerControl
              size={props.composerSize ?? "sm"}
              className={style.composerClassName}
              aria-pressed={pressed}
              aria-label={label}
              disabled={!canOperateThread}
              onClick={handleClick}
            />
          ) : (
            <Toggle
              className="shrink-0 touch:h-12 touch:min-w-12 max-md:touch:h-10 max-md:touch:min-w-10"
              pressed={pressed}
              onPressedChange={handleClick}
              disabled={!canOperateThread}
              aria-label={label}
              variant={style.toggleVariant}
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
              className={pressed ? style.iconClassName : undefined}
            />
            {expiryLabel !== null ? <span className="tabular-nums">{expiryLabel}</span> : null}
          </>
        ) : (
          // The button grows with the countdown instead of clipping it; the
          // padding lives here because Toggle owns its own.
          <span className="flex items-center gap-1.5 touch:px-1.5">
            <Icon className="size-3 touch:size-5" />
            {expiryLabel !== null ? (
              <span className="text-xs tabular-nums touch:text-sm">{expiryLabel}</span>
            ) : null}
          </span>
        )}
      </TooltipTrigger>
      <TooltipPopup
        side={placement === "composer" ? "top" : "bottom"}
        className="max-w-72 whitespace-normal"
      >
        <CacheKeepAliveTooltipText
          thread={thread}
          heartbeat={heartbeat}
          nowMs={openedAtMs}
          compactModes={compactModes}
        />
      </TooltipPopup>
    </Tooltip>
  );
});
