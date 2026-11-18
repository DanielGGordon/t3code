import {
  AuthOrchestrationOperateScope,
  DEFAULT_CACHE_KEEP_ALIVE_MAX_PINGS,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  CACHE_KEEP_ALIVE_MODE_LABELS,
  cacheKeepAliveActive,
  cacheKeepAliveMode,
  describeCacheKeepAlive,
  cacheKeepAliveSupportsDriver,
  formatCacheExpiry,
  nextCacheKeepAliveChoice,
  promptCacheExpiresAtMs,
  type CacheKeepAliveMode,
  type CacheKeepAliveThread,
} from "@t3tools/shared/cacheKeepAlive";
import { CirclePauseIcon, FlameIcon, HourglassIcon, FoldVerticalIcon } from "lucide-react";
import { memo, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { formatShortTimestamp } from "../../timestampFormat";
import { Toggle } from "../ui/toggle";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
    icon: HourglassIcon,
    iconClassName: "text-accent-violet",
    toggleVariant: "outline-violet",
    composerClassName:
      "aria-pressed:border-accent-violet/60 aria-pressed:bg-accent-violet/20 aria-pressed:text-accent-violet aria-pressed:hover:bg-accent-violet/30",
  },
} as const satisfies Record<CacheKeepAliveMode, object>;

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
  readonly nowMs: number;
  readonly maxPings: number;
  readonly modeLabel: string;
  readonly next: CacheKeepAliveMode | "off";
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const status = describeCacheKeepAlive({
    ...props,
    formatTime: (ms) => formatShortTimestamp(new Date(ms).toISOString(), timestampFormat),
  });
  return (
    <div className="flex flex-col gap-1">
      <p className="font-semibold">{props.modeLabel}</p>
      {status.length > 0 ? (
        <p>
          {status.map((part, index) => (
            <span key={part}>
              {index > 0 ? " · " : null}
              <span className="whitespace-nowrap">{part}</span>
            </span>
          ))}
        </p>
      ) : null}
      <p className="opacity-70">
        Click: {props.next === "off" ? "turn off" : CACHE_KEEP_ALIVE_MODE_LABELS[props.next]}
      </p>
    </div>
  );
}

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
  const keepAlive = shell?.source.cacheKeepAlive ?? null;
  const maxPings =
    serverConfig?.settings.cacheKeepAliveMaxPings ?? DEFAULT_CACHE_KEEP_ALIVE_MAX_PINGS;
  const keepAliveActive = cacheKeepAliveActive(keepAlive, maxPings);
  const mode = cacheKeepAliveMode(keepAlive);
  const compactModes = serverConfig?.environment.capabilities.threadCacheKeepAliveCompact === true;
  const next = nextCacheKeepAliveChoice(keepAlive, compactModes, maxPings);
  const handleClick = () =>
    void setCacheKeepAlive({
      environmentId,
      input:
        next === "off" ? { threadId, enabled: false } : { threadId, enabled: true, mode: next },
    });
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
  const paused = keepAlive !== null && !keepAliveActive;
  const style = MODES[keepAlive === null && next !== "off" ? next : mode];
  const Icon = paused ? CirclePauseIcon : style.icon;
  const modeLabel = CACHE_KEEP_ALIVE_MODE_LABELS[keepAlive === null ? "off" : mode];
  const label = `${modeLabel}${expiryLabel === null ? "" : `, cache expires in ${expiryLabel}`}`;
  return (
    <Tooltip onOpenChange={handleOpenChange}>
      <TooltipTrigger
        render={
          placement === "composer" ? (
            <ComposerControl
              size={props.composerSize ?? "sm"}
              className={style.composerClassName}
              aria-pressed={keepAliveActive}
              aria-label={label}
              disabled={!canOperateThread}
              onClick={handleClick}
            />
          ) : (
            <Toggle
              className="shrink-0 touch:h-12 touch:min-w-12 max-md:touch:h-10 max-md:touch:min-w-10"
              pressed={keepAliveActive}
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
              className={keepAliveActive ? style.iconClassName : undefined}
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
        className="max-w-80 whitespace-normal"
      >
        <CacheKeepAliveTooltipText
          thread={thread}
          nowMs={openedAtMs}
          maxPings={maxPings}
          modeLabel={modeLabel}
          next={next}
        />
      </TooltipPopup>
    </Tooltip>
  );
});
