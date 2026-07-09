import type { CodexSettings, CodexUsageResult, CodexUsageWindow } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";

// How many of the newest date directories to scan for rollout files. Rollout
// files are named by session *start* date, so a long-running session begun
// "yesterday" but still being written to has a newer mtime than files under
// "today". Scanning the two most recent non-empty day directories bounds the
// work while still catching that cross-midnight case.
const MAX_DAY_DIRECTORIES_TO_SCAN = 2;

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

// Collect rollout file paths from the newest date directories, descending.
function collectRecentRolloutFiles(
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
    let dayDirsScanned = 0;

    const years = yield* readDirNumericDesc(sessionsDir);
    for (const year of years) {
      if (dayDirsScanned >= MAX_DAY_DIRECTORIES_TO_SCAN) break;
      const months = yield* readDirNumericDesc(path.join(sessionsDir, year));
      for (const month of months) {
        if (dayDirsScanned >= MAX_DAY_DIRECTORIES_TO_SCAN) break;
        const days = yield* readDirNumericDesc(path.join(sessionsDir, year, month));
        for (const day of days) {
          if (dayDirsScanned >= MAX_DAY_DIRECTORIES_TO_SCAN) break;
          const dayDir = path.join(sessionsDir, year, month, day);
          const entries = yield* fileSystem
            .readDirectory(dayDir)
            .pipe(Effect.orElseSucceed(() => [] as string[]));
          const rollouts = entries.filter(
            (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
          );
          if (rollouts.length === 0) continue;
          for (const name of rollouts) {
            files.push(path.join(dayDir, name));
          }
          dayDirsScanned += 1;
        }
      }
    }

    return files;
  });
}

// Return the path with the newest mtime, plus that mtime (epoch seconds).
function newestByMtime(
  fileSystem: FileSystem.FileSystem,
  paths: ReadonlyArray<string>,
): Effect.Effect<{ readonly path: string; readonly mtimeSeconds: number } | null> {
  return Effect.gen(function* () {
    let best: { path: string; mtimeSeconds: number } | null = null;
    for (const filePath of paths) {
      const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      const mtime = info.value.mtime;
      const mtimeSeconds = Option.isSome(mtime) ? Math.floor(mtime.value.getTime() / 1000) : 0;
      if (best === null || mtimeSeconds > best.mtimeSeconds) {
        best = { path: filePath, mtimeSeconds };
      }
    }
    return best;
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
 * Passive only — this never calls the Codex API. It reflects usage as of the
 * last time the `codex` binary ran on this host, so it stays fresh precisely
 * when Codex is active (including out-of-band `codex exec` subprocesses that
 * T3 does not manage). Returns null when no snapshot can be found, and never
 * fails: usage is best-effort telemetry.
 */
export const readCodexUsage = (
  config: CodexSettings,
): Effect.Effect<CodexUsageResult, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layout = yield* resolveCodexHomeLayout(config);
    // Session rollout files live under the shared Codex home, even when a
    // shadow home isolates auth.json.
    const sessionsDir = path.join(layout.sharedHomePath, "sessions");

    const candidatePaths = yield* collectRecentRolloutFiles(fileSystem, path, sessionsDir);
    if (candidatePaths.length === 0) return null;

    const newest = yield* newestByMtime(fileSystem, candidatePaths);
    if (newest === null) return null;

    const text = yield* fileSystem.readFileString(newest.path);
    const rateLimits = parseLatestRateLimits(text);
    if (rateLimits === null) return null;

    return {
      planType: rateLimits.planType,
      primary: parseWindow(rateLimits.primary),
      secondary: parseWindow(rateLimits.secondary),
      capturedAt: newest.mtimeSeconds,
    };
  }).pipe(Effect.orElseSucceed(() => null));
