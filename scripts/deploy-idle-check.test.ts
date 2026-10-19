import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vitest";

import { findActiveRuns } from "./deploy-idle-check.ts";

function makeDb() {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE orchestration_v2_projection_runs (
      run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, status TEXT NOT NULL,
      requested_at TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, title TEXT NOT NULL, payload_json TEXT NOT NULL);`);
  const addThread = (id: string, title: string, worktreePath: string | null) =>
    db
      .prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?)")
      .run(id, title, JSON.stringify({ worktreePath }));
  let n = 0;
  const addRun = (threadId: string, status: string) =>
    db
      .prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?)")
      .run(`run-${++n}`, threadId, status, `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`);
  return { db, addThread, addRun };
}

it("counts only queued and running runs, once per thread", () => {
  const { db, addThread, addRun } = makeDb();
  addThread("a", "Alpha", null);
  addThread("b", "Beta", null);
  addThread("c", "Gamma", null);
  addRun("a", "running");
  addRun("a", "pending");
  addRun("b", "waiting");
  addRun("c", "completed");
  expect(findActiveRuns(db)).toEqual([{ threadId: "a", status: "running", title: "Alpha" }]);
});

it("skips ignored threads and the worktree of the chat running the deploy", () => {
  const { db, addThread, addRun } = makeDb();
  addThread("deployer", "Redeploy", "/wt/t3-1");
  addThread("other", "Other", "/wt/t3-2");
  addThread("pinned", "Pinned", null);
  addRun("deployer", "running");
  addRun("other", "running");
  addRun("pinned", "running");
  const busy = findActiveRuns(db, { ignoreWorktrees: ["/wt/t3-1"], ignoreThreads: ["pinned"] });
  expect(busy.map((run) => run.threadId)).toEqual(["other"]);
  expect(findActiveRuns(db, { ignoreThreads: ["deployer", "other", "pinned"] })).toEqual([]);
});
