// Is any T3 conversation doing work right now? Used by the redeploy skill's
// `--when-idle` mode to hold a restart until the server is quiet.
//
//   node scripts/deploy-idle-check.ts [--base-dir ~/.t3] \
//     [--ignore-thread <id>]... [--ignore-worktree <path>]...
//
// Exit 0: idle. Exit 1: busy (one `busy ...` line per active thread on stdout).
// Exit 2: could not read the state database.
//
// Read-only SQL over statev2.sqlite (safe while the server runs), so it works
// against any server version, including one that predates this script. A run
// that is `waiting` is parked on a person (approval or question) and survives a
// restart, so it does not count; `pending` (queued) and `running` do.

import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

export interface ActiveRun {
  readonly threadId: string;
  readonly status: string;
  readonly title: string;
}

export interface IdleFilter {
  /** Threads that never count, e.g. the chat that is running the deploy. */
  readonly ignoreThreads?: ReadonlyArray<string>;
  /** Threads whose git worktree is one of these paths never count. */
  readonly ignoreWorktrees?: ReadonlyArray<string>;
}

const ACTIVE_RUNS_SQL = `
  SELECT r.thread_id AS threadId, r.status AS status,
         COALESCE(t.title, '') AS title, t.payload_json AS payload
  FROM orchestration_v2_projection_runs r
  LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
  WHERE r.status IN ('pending', 'running')
  ORDER BY r.requested_at`;

function worktreePathOf(payload: unknown): string | null {
  if (typeof payload !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    const path = (parsed as { worktreePath?: unknown } | null)?.worktreePath;
    return typeof path === "string" ? path : null;
  } catch {
    return null;
  }
}

/** Distinct threads with a queued or running run, minus the ignored ones. */
export function findActiveRuns(db: NodeSqlite.DatabaseSync, filter: IdleFilter = {}): ActiveRun[] {
  const ignoreThreads = new Set(filter.ignoreThreads ?? []);
  const ignoreWorktrees = new Set(filter.ignoreWorktrees ?? []);
  const active = new Map<string, ActiveRun>();
  for (const row of db.prepare(ACTIVE_RUNS_SQL).all()) {
    const threadId = String(row.threadId);
    const worktree = worktreePathOf(row.payload);
    if (ignoreThreads.has(threadId)) continue;
    if (worktree !== null && ignoreWorktrees.has(worktree)) continue;
    if (!active.has(threadId)) {
      active.set(threadId, { threadId, status: String(row.status), title: String(row.title) });
    }
  }
  return [...active.values()];
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      "base-dir": { type: "string", default: NodePath.join(NodeOS.homedir(), ".t3") },
      "ignore-thread": { type: "string", multiple: true, default: [] },
      "ignore-worktree": { type: "string", multiple: true, default: [] },
    },
  });
  try {
    const db = new NodeSqlite.DatabaseSync(
      NodePath.join(values["base-dir"], "userdata", "statev2.sqlite"),
      {
        readOnly: true,
      },
    );
    const busy = findActiveRuns(db, {
      ignoreThreads: values["ignore-thread"],
      ignoreWorktrees: values["ignore-worktree"],
    });
    db.close();
    for (const run of busy) {
      console.log(`busy ${run.threadId} ${run.status} ${JSON.stringify(run.title)}`);
    }
    process.exit(busy.length > 0 ? 1 : 0);
  } catch (error) {
    console.error(`deploy-idle-check: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
