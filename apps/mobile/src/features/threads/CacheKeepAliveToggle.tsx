import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { DEFAULT_CACHE_KEEP_ALIVE_MAX_PINGS, type ServerConfig } from "@t3tools/contracts";
import {
  CACHE_KEEP_ALIVE_MODE_LABELS,
  cacheKeepAliveActive,
  cacheKeepAliveMode,
  cacheKeepAliveSupportsDriver,
  describeCacheKeepAlive,
  effectiveCacheKeepAlive,
  formatCacheExpiry,
  nextCacheKeepAliveChoice,
  promptCacheExpiresAtMs,
} from "@t3tools/shared/cacheKeepAlive";
import { useState } from "react";
import { Modal, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useNowMinuteMs } from "../../lib/clock";
import { useThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

const MODE_ICONS = {
  "warm-then-compact": { name: "hourglass", tint: "accent-violet-500" },
  warm: { name: "flame", tint: "accent-orange-500" },
  compact: { name: "arrow.down.to.line", tint: "accent-blue-500" },
} as const;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function CacheKeepAliveToggle(props: {
  readonly thread: EnvironmentThreadShell;
  readonly serverConfig: ServerConfig | null;
  readonly disabled: boolean;
}) {
  const nowMs = useNowMinuteMs();
  const [detailsAtMs, setDetailsAtMs] = useState<number | null>(null);
  const setKeepAlive = useAtomCommand(threadEnvironment.setCacheKeepAlive, "cache keep-alive");
  const { source: thread, id: threadId, environmentId } = props.thread;
  const capabilities = props.serverConfig?.environment.capabilities;
  const storedKeepAlive = thread.cacheKeepAlive ?? null;
  // A subagent thread follows its parent when the parent is loaded here.
  const parentShell = useThreadShell(
    thread.lineage.relationshipToParent === "subagent" && thread.lineage.parentThreadId !== null
      ? scopeThreadRef(environmentId, thread.lineage.parentThreadId)
      : null,
  );
  if (
    capabilities?.threadCacheKeepAlive !== true ||
    (storedKeepAlive === null &&
      !cacheKeepAliveSupportsDriver(
        props.serverConfig?.providers.find(
          (provider) => provider.instanceId === thread.providerInstanceId,
        )?.driver,
      ))
  ) {
    return null;
  }

  const maxPings =
    props.serverConfig?.settings.cacheKeepAliveMaxPings ?? DEFAULT_CACHE_KEEP_ALIVE_MAX_PINGS;
  const parent = parentShell?.source ?? null;
  const keepAlive =
    parent === null
      ? storedKeepAlive
      : effectiveCacheKeepAlive({ thread, parent, nowMs, maxPings }).keepAlive;
  const active = cacheKeepAliveActive(keepAlive, maxPings);
  const paused = keepAlive !== null && !active;
  const mode = cacheKeepAliveMode(keepAlive);
  const label = CACHE_KEEP_ALIVE_MODE_LABELS[keepAlive === null ? "off" : mode];
  const next = nextCacheKeepAliveChoice(
    storedKeepAlive,
    capabilities.threadCacheKeepAliveCompact === true,
    maxPings,
  );
  const { name, tint } = MODE_ICONS[keepAlive === null && next !== "off" ? next : mode];
  const expiry = promptCacheExpiresAtMs({ thread, nowMs });
  const countdown = expiry === null ? null : formatCacheExpiry(expiry - nowMs);
  const closeDetails = () => setDetailsAtMs(null);
  const status =
    detailsAtMs === null
      ? []
      : describeCacheKeepAlive({
          thread,
          parent,
          nowMs: detailsAtMs,
          maxPings,
          formatTime: (ms) => timeFormat.format(ms),
        });

  return (
    <>
      <Pressable
        accessibilityRole="togglebutton"
        accessibilityLabel={countdown === null ? label : `${label}, cache expires in ${countdown}`}
        accessibilityHint={next === "off" ? "Turn off" : CACHE_KEEP_ALIVE_MODE_LABELS[next]}
        accessibilityState={{ checked: active, disabled: props.disabled }}
        className="h-11 min-w-11 flex-row items-center justify-center gap-1 rounded-xl px-1 active:bg-subtle"
        onLongPress={() => setDetailsAtMs(Date.now())}
        onPress={() => {
          if (props.disabled) return;
          void setKeepAlive({
            environmentId,
            input:
              next === "off"
                ? { threadId, enabled: false }
                : { threadId, enabled: true, mode: next },
          });
        }}
      >
        <SymbolView
          name={paused ? "pause.circle" : name}
          tintColorClassName={active ? tint : "accent-icon-muted"}
          size={18}
          type="monochrome"
        />
        {countdown === null ? null : (
          <Text className="text-xs tabular-nums text-foreground-muted">{countdown}</Text>
        )}
      </Pressable>
      {detailsAtMs === null ? null : (
        <Modal transparent onRequestClose={closeDetails}>
          <Pressable
            accessible={false}
            className="flex-1 items-center justify-center bg-black/25 px-6"
            onPress={closeDetails}
          >
            <View
              className="w-full max-w-sm gap-1 rounded-xl bg-background p-4"
              accessibilityViewIsModal
            >
              <Text className="font-t3-bold">{label}</Text>
              {status.length > 0 ? <Text>{status.join(" · ")}</Text> : null}
              <Text className="text-foreground-muted">
                Click: {next === "off" ? "turn off" : CACHE_KEEP_ALIVE_MODE_LABELS[next]}
              </Text>
            </View>
          </Pressable>
        </Modal>
      )}
    </>
  );
}
