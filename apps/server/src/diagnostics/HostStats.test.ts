import { describe, expect, it } from "@effect/vitest";

import * as HostStats from "./HostStats.ts";

describe("HostStats", () => {
  describe("parseMeminfo", () => {
    it("reads MemTotal and MemAvailable in kB", () => {
      const text = [
        "MemTotal:       16384000 kB",
        "MemFree:         1024000 kB",
        "MemAvailable:   12288000 kB",
        "Buffers:          512000 kB",
      ].join("\n");
      expect(HostStats.parseMeminfo(text)).toEqual({
        totalBytes: 16_384_000 * 1024,
        availableBytes: 12_288_000 * 1024,
      });
    });

    it("returns null when MemAvailable is missing (old kernels)", () => {
      const text = ["MemTotal:       16384000 kB", "MemFree:         1024000 kB"].join("\n");
      expect(HostStats.parseMeminfo(text)).toBeNull();
    });

    it("returns null for non-meminfo content", () => {
      expect(HostStats.parseMeminfo("")).toBeNull();
      expect(HostStats.parseMeminfo("not meminfo at all")).toBeNull();
    });
  });

  describe("computeCpuPercent", () => {
    const sample = (busyMs: number, totalMs: number, atMs: number): HostStats.CpuSample => ({
      busyMs,
      totalMs,
      atMs,
    });

    it("reports the busy share of the sampled window", () => {
      const previous = sample(1_000, 10_000, 0);
      const current = sample(1_500, 12_000, 2_000);
      // 500ms busy over a 2000ms window of CPU time.
      expect(HostStats.computeCpuPercent(previous, current)).toBe(25);
    });

    it("clamps to the 0-100 range", () => {
      const previous = sample(1_000, 10_000, 0);
      expect(HostStats.computeCpuPercent(previous, sample(3_500, 12_000, 2_000))).toBe(100);
      expect(HostStats.computeCpuPercent(previous, sample(500, 12_000, 2_000))).toBe(0);
    });

    it("returns null for a degenerate window", () => {
      const previous = sample(1_000, 10_000, 0);
      expect(HostStats.computeCpuPercent(previous, previous)).toBeNull();
      expect(HostStats.computeCpuPercent(previous, sample(900, 9_000, 0))).toBeNull();
    });
  });

  describe("readCpuTimes", () => {
    it("returns monotone non-negative counters", () => {
      const first = HostStats.readCpuTimes();
      expect(first.busyMs).toBeGreaterThanOrEqual(0);
      expect(first.totalMs).toBeGreaterThanOrEqual(first.busyMs);
      const second = HostStats.readCpuTimes();
      expect(second.totalMs).toBeGreaterThanOrEqual(first.totalMs);
      expect(second.busyMs).toBeGreaterThanOrEqual(first.busyMs);
    });
  });
});
