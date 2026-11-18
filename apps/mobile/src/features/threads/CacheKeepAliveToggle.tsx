import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { DEFAULT_CACHE_KEEP_ALIVE_MAX_PINGS, type ServerConfig } from "@t3tools/contracts";
import {
  CACHE_KEEP_ALIVE_MODE_LABELS,
  cacheKeepAliveActive,
  cacheKeepAliveMode,
  cacheKeepAliveSupportsDriver,
  cacheKeptWarmByHeartbeat,
  describeCacheKeepAlive,
  formatCacheExpiry,
  nextCacheKeepAliveChoice,
  promptCacheExpiresAtMs,
} from "@t3tools/shared/cacheKeepAlive";
import { useState } from "react";
import { Modal, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useNowMinuteMs } from "../../lib/clock";
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
  const keepAlive = thread.cacheKeepAlive ?? null;
  if (
    capabilities?.threadCacheKeepAlive !== true ||
    (keepAlive === null &&
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
  const active = cacheKeepAliveActive(keepAlive, maxPings);
  const heartbeat = cacheKeptWarmByHeartbeat(thread);
  const paused = keepAlive !== null && !active && !heartbeat;
  const mode = cacheKeepAliveMode(keepAlive);
  const { name, tint } = MODE_ICONS[mode];
  const label = CACHE_KEEP_ALIVE_MODE_LABELS[keepAlive === null ? "off" : mode];
  const next = nextCacheKeepAliveChoice(
    keepAlive,
    capabilities.threadCacheKeepAliveCompact === true,
    maxPings,
  );
  const expiry = promptCacheExpiresAtMs({ thread, nowMs });
  const countdown = expiry === null ? null : formatCacheExpiry(expiry - nowMs);
  const closeDetails = () => setDetailsAtMs(null);

  return (
    <>
      <Pressable
        accessibilityRole="togglebutton"
        accessibilityLabel={countdown === null ? label : `${label}, cache expires in ${countdown}`}
        accessibilityHint={next === "off" ? "Turn off" : CACHE_KEEP_ALIVE_MODE_LABELS[next]}
        accessibilityState={{ checked: active || heartbeat, disabled: props.disabled }}
        className="h-11 min-w-11 flex-row items-center justify-center gap-1 rounded-xl px-1 active:bg-subtle"
        onLongPress={() => setDetailsAtMs(Date.now())}
        onPress={() => {
          if (props.disabled) return;
          void setKeepAlive({
            environmentId,
            input:
              next === "off"
                ? { threadId, enabled: false }
                : { threadId, enabled: true, mode: next, maxPings },
          });
        }}
      >
        <SymbolView
          name={paused ? "pause.circle" : name}
          tintColorClassName={active || heartbeat ? tint : "accent-icon-muted"}
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
              <Text>
                {describeCacheKeepAlive({
                  thread,
                  nowMs: detailsAtMs,
                  maxPings,
                  formatTime: (ms) => timeFormat.format(ms),
                })}
              </Text>
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
