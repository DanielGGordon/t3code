import * as NodeOS from "node:os";

import type { ServerHostStatsResult } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

// CPU usage is a rate, so it needs two `NodeOS.cpus()` samples. Deltas shorter
// than this are too noisy to report; rapid re-polls inside the window get the
// previously computed reading instead of a fresh (garbage) one.
const MIN_CPU_SAMPLE_WINDOW_MS = 500;
// On the very first read there is no previous sample, so block briefly for a
// second one rather than reporting nothing.
const FIRST_SAMPLE_DELAY = "250 millis";

export interface CpuTimes {
  // Milliseconds of CPU time spent non-idle, summed across all cores.
  readonly busyMs: number;
  // Total milliseconds of CPU time (busy + idle), summed across all cores.
  readonly totalMs: number;
}

export interface CpuSample extends CpuTimes {
  readonly atMs: number;
}

export function readCpuTimes(): CpuTimes {
  let busyMs = 0;
  let totalMs = 0;
  for (const cpu of NodeOS.cpus()) {
    const { user, nice, sys, idle, irq } = cpu.times;
    busyMs += user + nice + sys + irq;
    totalMs += user + nice + sys + irq + idle;
  }
  return { busyMs, totalMs };
}

const readCpuSample: Effect.Effect<CpuSample> = Effect.map(Clock.currentTimeMillis, (atMs) => ({
  ...readCpuTimes(),
  atMs,
}));

// Percent (0–100) of total CPU capacity used between two samples, or null
// when the window is degenerate (no elapsed CPU time, e.g. identical samples).
export function computeCpuPercent(previous: CpuSample, current: CpuSample): number | null {
  const totalDelta = current.totalMs - previous.totalMs;
  if (totalDelta <= 0) return null;
  const busyDelta = current.busyMs - previous.busyMs;
  return Math.min(100, Math.max(0, (busyDelta / totalDelta) * 100));
}

// Parse MemTotal/MemAvailable out of Linux /proc/meminfo (values are in kB).
// MemAvailable is the kernel's estimate of memory usable without swapping,
// which treats reclaimable page cache as free — unlike `NodeOS.freemem()`.
export function parseMeminfo(
  text: string,
): { readonly totalBytes: number; readonly availableBytes: number } | null {
  let totalKb: number | null = null;
  let availableKb: number | null = null;
  for (const line of text.split("\n")) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s*kB/.exec(line);
    if (match === null) continue;
    const value = Number(match[2]);
    if (match[1] === "MemTotal") totalKb = value;
    else availableKb = value;
    if (totalKb !== null && availableKb !== null) break;
  }
  if (totalKb === null || availableKb === null) return null;
  return { totalBytes: totalKb * 1024, availableBytes: availableKb * 1024 };
}

const readMemory: Effect.Effect<
  { readonly usedBytes: number; readonly totalBytes: number },
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const meminfo = yield* fileSystem.readFileString("/proc/meminfo").pipe(
    Effect.map(parseMeminfo),
    Effect.orElseSucceed(() => null),
  );
  if (meminfo !== null) {
    return {
      usedBytes: Math.max(0, meminfo.totalBytes - meminfo.availableBytes),
      totalBytes: meminfo.totalBytes,
    };
  }
  // Portable fallback (macOS, or /proc unavailable). `NodeOS.freemem()` ignores
  // reclaimable caches, so "used" reads higher here than on the Linux path.
  const totalBytes = NodeOS.totalmem();
  return { usedBytes: Math.max(0, totalBytes - NodeOS.freemem()), totalBytes };
});

/**
 * Whole-host CPU/memory usage of the machine the server runs on. Purely
 * on-demand: no background sampling fiber, so it costs nothing while no
 * client has the readout enabled. CPU state (the previous `NodeOS.cpus()`
 * snapshot) persists between reads, so steady polling measures usage across
 * the full interval between polls.
 */
export class HostStats extends Context.Service<
  HostStats,
  {
    readonly read: Effect.Effect<ServerHostStatsResult>;
  }
>()("t3/diagnostics/HostStats") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const previousSampleRef = yield* Ref.make<CpuSample | null>(null);
  const lastCpuPercentRef = yield* Ref.make<number | null>(null);

  const read: Effect.Effect<ServerHostStatsResult> = Effect.gen(function* () {
    const memory = yield* readMemory;

    const stored = yield* Ref.get(previousSampleRef);
    let previous = stored;
    if (previous === null) {
      previous = yield* readCpuSample;
      yield* Effect.sleep(FIRST_SAMPLE_DELAY);
    }
    const current = yield* readCpuSample;

    let cpuPercent: number | null;
    if (stored !== null && current.atMs - previous.atMs < MIN_CPU_SAMPLE_WINDOW_MS) {
      // Too soon for a meaningful delta — reuse the last reading and keep the
      // stored baseline so the next poll measures a fuller window.
      const last = yield* Ref.get(lastCpuPercentRef);
      cpuPercent = last ?? computeCpuPercent(previous, current);
    } else {
      // Normal poll (or very first read, which accepts the short bootstrap
      // window because there is nothing better).
      cpuPercent = computeCpuPercent(previous, current);
      yield* Ref.set(previousSampleRef, current);
    }
    if (cpuPercent === null) return null;
    yield* Ref.set(lastCpuPercentRef, cpuPercent);

    return {
      cpuPercent,
      cpuCount: NodeOS.cpus().length,
      memUsedBytes: memory.usedBytes,
      memTotalBytes: memory.totalBytes,
    };
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.orElseSucceed(() => null),
  );

  return HostStats.of({ read });
});

export const layer = Layer.effect(HostStats, make);
