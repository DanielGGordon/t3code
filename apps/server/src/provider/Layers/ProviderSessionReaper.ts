import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_LIVE_TASK_IDLE_MS = 24 * 60 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  /**
   * How long a session may stay idle before it becomes reap-eligible.
   * Values <= 0 disable the reaper entirely.
   */
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  /**
   * Safety cap for sessions with live background tasks: an idle session is
   * spared while it has live tasks, but only up to this idle duration.
   * Prevents leaked task bookkeeping from protecting a session forever.
   *
   * Note: `liveTaskCount` is currently fed only by the Claude adapter's
   * `task.started`/`task.completed` mapping. Sessions for other providers
   * always report zero live tasks and fall back to the plain
   * inactivity/active-turn checks.
   */
  readonly maxLiveTaskIdleMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const inactivityThresholdMs = options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS;
    const sweepIntervalMs = Math.max(1000, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const maxLiveTaskIdleMs = options?.maxLiveTaskIdleMs ?? DEFAULT_MAX_LIVE_TASK_IDLE_MS;
    const reaperEnabled = inactivityThresholdMs > 0;

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        // Runtime activity (canonical runtime events observed in-process) can
        // be fresher than the persisted binding's lastSeenAt — e.g. background
        // tasks emitting progress between user turns.
        const activity = yield* providerService.getSessionActivity(binding.threadId);
        const effectiveLastSeenMs = Math.max(lastSeenMs, activity.lastActivityAtMs ?? 0);
        const idleDurationMs = now - effectiveLastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          const persistedIdleMs = now - lastSeenMs;
          if (persistedIdleMs >= inactivityThresholdMs) {
            // The persisted binding alone would have been reaped; in-memory
            // runtime activity rescued it. Log so operators can see the
            // reaper honoring runtime activity instead of silently skipping.
            yield* Effect.logDebug("provider.session.reaper.spared-runtime-activity", {
              threadId: binding.threadId,
              provider: binding.provider,
              persistedIdleMs,
              runtimeLastActivityAtMs: activity.lastActivityAtMs,
              liveTaskCount: activity.liveTaskCount,
            });
          }
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        // Agent-spawned background work (task.started without task.completed)
        // keeps the session alive across idle periods, up to a hard cap so a
        // leaked task entry cannot protect a session forever.
        if (activity.liveTaskCount > 0 && idleDurationMs < maxLiveTaskIdleMs) {
          yield* Effect.logDebug("provider.session.reaper.skipped-live-tasks", {
            threadId: binding.threadId,
            provider: binding.provider,
            liveTaskCount: activity.liveTaskCount,
            idleDurationMs,
          });
          continue;
        }

        // Re-check activity right before stopping: the projection query above
        // yields, so a turn/task may have started since the snapshot at the
        // top of this iteration. `recordSessionActivity` bumps the in-memory
        // map before the projection is updated, so this fresh read catches
        // activity the stale snapshot (and a lagging projection) would miss.
        const latestActivity = yield* providerService.getSessionActivity(binding.threadId);
        const latestNow = yield* Clock.currentTimeMillis;
        const latestIdleDurationMs =
          latestNow - Math.max(lastSeenMs, latestActivity.lastActivityAtMs ?? 0);
        if (
          latestIdleDurationMs < inactivityThresholdMs ||
          (latestActivity.liveTaskCount > 0 && latestIdleDurationMs < maxLiveTaskIdleMs)
        ) {
          yield* Effect.logDebug("provider.session.reaper.skipped-late-activity", {
            threadId: binding.threadId,
            provider: binding.provider,
            idleDurationMs: latestIdleDurationMs,
            liveTaskCount: latestActivity.liveTaskCount,
          });
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs: latestIdleDurationMs,
              reason: "inactivity_threshold",
              lastSeenSource:
                latestActivity.lastActivityAtMs !== undefined &&
                latestActivity.lastActivityAtMs > lastSeenMs
                  ? "runtime-activity"
                  : "persisted-binding",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        if (!reaperEnabled) {
          yield* Effect.logInfo("provider.session.reaper.disabled", {
            inactivityThresholdMs,
          });
          return;
        }

        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
          maxLiveTaskIdleMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
