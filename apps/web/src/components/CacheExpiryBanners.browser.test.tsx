import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const testState = vi.hoisted(() => ({
  open: new Map<string, { title?: string; actionProps?: { onClick: () => void } }>(),
  nextId: 0,
  providers: new Map(),
}));

vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((select: (settings: object) => unknown) =>
    select({
      cacheExpiryBannerEnabled: true,
      cacheExpiryBannerMinTokens: 0,
      timestampFormat: "locale",
    })) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useThreadShells: (() => []) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: (() => testState.providers) as never,
}));
vi.mock(import("./ui/toast"), async (original) => ({
  ...(await original()),
  toastManager: {
    add: (options: { title?: string; actionProps?: { onClick: () => void } }) => {
      const id = `toast-${testState.nextId++}`;
      testState.open.set(id, options);
      return id;
    },
    close: (id: string) => void testState.open.delete(id),
  } as never,
}));

import { CacheExpiryBanners } from "./CacheExpiryBanners";

const banner = (n: number) => ({
  key: `env:thread-${n}@2026-11-06T00:00:00.000Z`,
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make(`thread-${n}`),
  title: `Thread ${n}`,
  tokens: 200_000,
  expiresAt: "2026-11-06T01:00:00.000Z",
});

describe("CacheExpiryBanners", () => {
  it("Dismiss all closes every banner tile as well as the summary", async () => {
    localStorage.setItem(
      "t3code:cache-expiry-banners:v1",
      JSON.stringify({ open: [banner(1), banner(2), banner(3)], dismissed: [] }),
    );
    await using _screen = await render(<CacheExpiryBanners />);
    const titles = () => [...testState.open.values()].map((toast) => toast.title);
    expect(titles()).toEqual([
      "Prompt cache expiring",
      "Prompt cache expiring",
      "Prompt cache expiring",
      "3 prompt caches expiring",
    ]);

    const summary = [...testState.open.values()].find((toast) =>
      toast.title?.endsWith("prompt caches expiring"),
    );
    await act(async () => summary?.actionProps?.onClick());

    expect(titles()).toEqual([]);
    expect(JSON.parse(localStorage.getItem("t3code:cache-expiry-banners:v1") ?? "{}").open).toEqual(
      [],
    );
  });
});
