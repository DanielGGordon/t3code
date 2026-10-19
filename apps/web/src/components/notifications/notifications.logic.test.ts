import type { Notification } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  detectArrivals,
  formatBellCount,
  resolveNotificationBellVisible,
  safeHttpUrl,
} from "./notifications.logic";

const card = (id: string) => ({ id }) as Notification;

describe("detectArrivals", () => {
  it("treats the first snapshot as a baseline, not arrivals", () => {
    const first = detectArrivals(null, [card("a:1"), card("a:2")]);
    expect(first.arrivals).toEqual([]);
    expect([...first.seen]).toEqual(["a:1", "a:2"]);
  });

  it("reports only ids that were not seen, and forgets removed ones", () => {
    const step = detectArrivals(new Set(["a:1", "a:2"]), [card("a:3"), card("a:1")]);
    expect(step.arrivals.map((n) => n.id)).toEqual(["a:3"]);
    expect([...step.seen].toSorted()).toEqual(["a:1", "a:3"]);
    expect(detectArrivals(step.seen, [card("a:2")]).arrivals.map((n) => n.id)).toEqual(["a:2"]);
  });
});

describe("resolveNotificationBellVisible", () => {
  it("auto follows the open count", () => {
    expect(resolveNotificationBellVisible("auto", 0)).toBe(false);
    expect(resolveNotificationBellVisible("auto", 2)).toBe(true);
    expect(resolveNotificationBellVisible("show", 0)).toBe(true);
    expect(resolveNotificationBellVisible("hide", 2)).toBe(false);
  });
});

describe("safeHttpUrl", () => {
  it("only passes http(s)", () => {
    expect(safeHttpUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});

describe("formatBellCount", () => {
  it("caps at 9+", () => {
    expect(formatBellCount(3)).toBe("3");
    expect(formatBellCount(12)).toBe("9+");
  });
});
