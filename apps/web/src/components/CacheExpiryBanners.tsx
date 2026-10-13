import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { TimerIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import {
  dueCacheExpiryBanners,
  formatContextTokens,
  type CacheExpiryBanner,
} from "../cacheExpiryBanners.logic";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useClientSettings } from "../hooks/useSettings";
import { useServerConfigs, useThreadShells } from "../state/entities";
import { formatShortTimestamp } from "../timestampFormat";
import { stackedThreadToast, toastManager } from "./ui/toast";

// Fork: a persistent banner when a big idle conversation's prompt cache is about
// to expire, so the user can go back and keep it warm. Banners stay until their
// X is clicked, across reloads, so this device's open and dismissed banners live
// in local storage. Settings → Behavior turns it off or sets the size.
const STORAGE_KEY = "t3code:cache-expiry-banners:v1";
const RECHECK_MS = 30_000;
const KEEP_DISMISSED_MS = 2 * 24 * 60 * 60_000;

const BannerStore = Schema.Struct({
  open: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      environmentId: EnvironmentId,
      threadId: ThreadId,
      title: Schema.String,
      tokens: Schema.Number,
      expiresAt: Schema.String,
    }),
  ),
  dismissed: Schema.Array(Schema.Struct({ key: Schema.String, at: Schema.Number })),
});
type BannerStore = typeof BannerStore.Type;
const EMPTY_STORE: BannerStore = { open: [], dismissed: [] };

type ToastId = ReturnType<typeof toastManager.add>;

export function CacheExpiryBanners() {
  const enabled = useClientSettings((settings) => settings.cacheExpiryBannerEnabled);
  const minTokens = useClientSettings((settings) => settings.cacheExpiryBannerMinTokens);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const threads = useThreadShells(enabled);
  const serverConfigs = useServerConfigs();
  const navigate = useNavigate();
  const [store, setStore] = useLocalStorage(STORAGE_KEY, EMPTY_STORE, BannerStore);
  const toasts = useRef(new Map<string, ToastId>());

  // A due banner opens once; after that only its X (here or in another tab) closes
  // it. Each check reads the clock afresh, on new shell data and every 30 s.
  useEffect(() => {
    if (!enabled) return;
    const openDue = () => {
      const due = dueCacheExpiryBanners({
        threads,
        nowMs: Date.now(),
        minTokens,
        driverOf: (thread) =>
          serverConfigs
            .get(thread.environmentId)
            ?.providers.find((provider) => provider.instanceId === thread.providerInstanceId)
            ?.driver,
      });
      if (due.length === 0) return;
      setStore((current) => {
        const known = new Set([
          ...current.open.map((banner) => banner.key),
          ...current.dismissed.map((entry) => entry.key),
        ]);
        const fresh = due.filter((banner) => !known.has(banner.key));
        return fresh.length === 0 ? current : { ...current, open: [...current.open, ...fresh] };
      });
    };
    openDue();
    const timer = setInterval(openDue, RECHECK_MS);
    return () => clearInterval(timer);
  }, [enabled, threads, minTokens, serverConfigs, setStore]);

  const dismiss = useCallback(
    (key: string) => {
      toasts.current.delete(key);
      const now = Date.now();
      setStore((current) => ({
        open: current.open.filter((banner) => banner.key !== key),
        dismissed: [
          ...current.dismissed.filter((entry) => now - entry.at < KEEP_DISMISSED_MS),
          { key, at: now },
        ],
      }));
    },
    [setStore],
  );

  // Turning the setting off drops the open banners rather than parking them.
  useEffect(() => {
    if (!enabled && store.open.length > 0) setStore((current) => ({ ...current, open: [] }));
  }, [enabled, store.open.length, setStore]);

  useEffect(() => {
    const openKeys = new Set(store.open.map((banner) => banner.key));
    for (const [key, toastId] of toasts.current) {
      if (!openKeys.has(key)) {
        toastManager.close(toastId);
        toasts.current.delete(key);
      }
    }
    for (const banner of store.open) {
      if (toasts.current.has(banner.key)) continue;
      toasts.current.set(
        banner.key,
        toastManager.add(
          bannerToast(banner, {
            expiresAtLabel: formatShortTimestamp(banner.expiresAt, timestampFormat),
            open: () =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: banner.environmentId, threadId: banner.threadId },
              }),
            dismiss: () => dismiss(banner.key),
          }),
        ),
      );
    }
  }, [store.open, timestampFormat, navigate, dismiss]);

  useEffect(
    () => () => {
      for (const toastId of toasts.current.values()) toastManager.close(toastId);
      toasts.current.clear();
    },
    [],
  );

  return null;
}

function bannerToast(
  banner: CacheExpiryBanner,
  actions: { expiresAtLabel: string; open: () => void; dismiss: () => void },
) {
  return stackedThreadToast({
    type: "warning",
    title: "Prompt cache expiring",
    description: `“${banner.title}” has ${formatContextTokens(banner.tokens)} tokens of context. Its cache expires at ${actions.expiresAtLabel}; send a message before then to keep it warm.`,
    timeout: 0,
    actionProps: { children: "Open conversation", onClick: actions.open },
    actionVariant: "outline",
    data: {
      hideCopyButton: true,
      leadingIcon: <TimerIcon aria-hidden="true" className="size-4 text-warning" />,
      onClose: actions.dismiss,
    },
  });
}
