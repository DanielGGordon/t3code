import { useEffect, useState } from "react";
import type { CodexUsageResult } from "@t3tools/contracts";
import { ensureLocalApi } from "~/localApi";

// Passive poll cadence. The underlying number only changes when `codex`
// actually runs, and `used_percent` is coarse, so polling faster wastes work
// without surfacing anything new.
const POLL_INTERVAL_MS = 45_000;

/**
 * Poll the server for the latest Codex subscription usage snapshot.
 *
 * Best-effort: transient RPC failures keep the last known value rather than
 * flashing empty. When `enabled` is false the hook stays idle and never polls,
 * so the meter's setting toggle also gates the network traffic.
 */
export function useCodexUsage(enabled: boolean): CodexUsageResult {
  const [snapshot, setSnapshot] = useState<CodexUsageResult>(null);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const result = await ensureLocalApi().server.getCodexUsage();
        if (!cancelled) {
          setSnapshot(result);
        }
      } catch {
        // Keep the last value; usage is non-critical telemetry.
      } finally {
        if (!cancelled) {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [enabled]);

  return snapshot;
}
