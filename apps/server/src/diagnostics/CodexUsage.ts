import type { CodexSettings, CodexUsageResult, CodexUsageWindow } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// Directory names under sessions/ are zero-padded numeric (YYYY, MM, DD).
// Sort descending so the newest is first.
function sortNumericDesc(names: ReadonlyArray<string>): string[] {
  return names.filter((name) => /^\d+$/.test(name)).sort((a, b) => b.localeCompare(a));
}

// Collect all rollout file paths across every date directory. Rollout files
// live under sessions/YYYY/MM/DD/rollout-*.jsonl. Long-running sessions keep
// writing under their original start-date directory, so the globally freshest
// file by mtime can reside in an arbitrarily old day folder. Directory listing
// is cheap; the expensive file-content reads are bounded later by trying
// candidates in mtime order and stopping at the first valid snapshot.
function collectRolloutFiles(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  sessionsDir: string,
): Effect.Effect<ReadonlyArray<string>> {
  return Effect.gen(function* () {
    const readDirNumericDesc = (dir: string) =>
      fileSystem.readDirectory(dir).pipe(
        Effect.map(sortNumericDesc),
        Effect.orElseSucceed(() => [] as string[]),
      );

    const files: string[] = [];

    const years = yield* readDirNumericDesc(sessionsDir);
    for (const year of years) {
      const months = yield* readDirNumericDesc(path.join(sessionsDir, year));
      for (const month of months) {
        const days = yield* readDirNumericDesc(path.join(sessionsDir, year, month));
        for (const day of days) {
          const dayDir = path.join(sessionsDir, year, month, day);
          const entries = yield* fileSystem
            .readDirectory(dayDir)
            .pipe(Effect.orElseSucceed(() => [] as string[]));
          const rollouts = entries.filter(
            (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
          );
          for (const name of rollouts) {
            files.push(path.join(dayDir, name));
          }
        }
      }
    }

    return files;
  });
}

// Stat every path and return them sorted by mtime descending (newest first).
function sortByMtimeDesc(
  fileSystem: FileSystem.FileSystem,
  paths: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<{ readonly path: string; readonly mtimeSeconds: number }>> {
  return Effect.gen(function* () {
    const entries: Array<{ path: string; mtimeSeconds: number }> = [];
    for (const filePath of paths) {
      const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      const mtime = info.value.mtime;
      const mtimeSeconds = Option.isSome(mtime) ? Math.floor(mtime.value.getTime() / 1000) : 0;
      entries.push({ path: filePath, mtimeSeconds });
    }
    return entries.sort((a, b) => b.mtimeSeconds - a.mtimeSeconds);
  });
}

function parseWindow(value: unknown): CodexUsageWindow | null {
  const record = asRecord(value);
  if (record === null) return null;
  const usedPercent = asFiniteNumber(record.used_percent);
  if (usedPercent === null) return null;
  return {
    usedPercent,
    resetsAt: asFiniteNumber(record.resets_at),
    windowMinutes: asFiniteNumber(record.window_minutes),
  };
}

// Scan a rollout file's lines from the end for the most recent `token_count`
// event carrying a `rate_limits` snapshot.
function parseLatestRateLimits(text: string): {
  readonly planType: string | null;
  readonly primary: unknown;
  readonly secondary: unknown;
} | null {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const outer = asRecord(parsed);
    const payload = asRecord(outer?.payload);
    if (payload?.type !== "token_count") continue;
    const rateLimits = asRecord(payload.rate_limits);
    if (rateLimits === null) continue;
    return {
      planType: asString(rateLimits.plan_type),
      primary: rateLimits.primary,
      secondary: rateLimits.secondary,
    };
  }
  return null;
}

/**
 * Read the Codex CLI's latest subscription rate-limit snapshot from disk.
 *
 * Accepts one or more `CodexSettings` configs so callers can supply every
 * configured Codex instance (legacy `providers.codex` plus any explicit
 * `providerInstances` entries with driver "codex"). Rollout files from all
 * homes are merged, sorted by mtime, and tried newest-first until a valid
 * `rate_limits` snapshot is found.
 *
 * Passive only — this never calls the Codex API. It reflects usage as of the
 * last time the `codex` binary ran on this host, so it stays fresh precisely
 * when Codex is active (including out-of-band `codex exec` subprocesses that
 * T3 does not manage). Returns null when no snapshot can be found, and never
 * fails: usage is best-effort telemetry.
 */
export const readCodexUsage = (
  configs: ReadonlyArray<CodexSettings>,
): Effect.Effect<CodexUsageResult, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // Collect rollout files from every configured Codex home.
    const allCandidatePaths: string[] = [];
    for (const config of configs) {
      const layout = yield* resolveCodexHomeLayout(config);
      const sessionsDir = path.join(layout.sharedHomePath, "sessions");
      const candidates = yield* collectRolloutFiles(fileSystem, path, sessionsDir);
      for (const candidate of candidates) {
        allCandidatePaths.push(candidate);
      }
    }

    if (allCandidatePaths.length === 0) return null;

    // Try candidates newest-first; stop at the first file with a valid
    // rate_limits snapshot so we don't needlessly read older files.
    const sorted = yield* sortByMtimeDesc(fileSystem, allCandidatePaths);
    for (const entry of sorted) {
      const text = yield* fileSystem.readFileString(entry.path).pipe(Effect.option);
      if (Option.isNone(text)) continue;
      const rateLimits = parseLatestRateLimits(text.value);
      if (rateLimits === null) continue;
      return {
        planType: rateLimits.planType,
        primary: parseWindow(rateLimits.primary),
        secondary: parseWindow(rateLimits.secondary),
        capturedAt: entry.mtimeSeconds,
      };
    }
    return null;
  }).pipe(Effect.orElseSucceed(() => null));
