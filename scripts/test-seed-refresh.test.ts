import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import {
  attachmentFileThreadSegment,
  COPYOF_PREFIX,
  readSeedManifest,
  registryPaths,
  resolveSeedTemplate,
  toSafeThreadAttachmentSegment,
} from "./test-deploy-lib.ts";

import {
  curatedSandboxDir,
  gcSeedVersions,
  neutralizeWorkspacePaths,
  parseRefreshArgs,
  pruneCuratedDb,
  renameCuratedTitles,
  rewriteCuratedEventPayloads,
  runRefresh,
  selectKeptSets,
  verifyCuratedDb,
  type RefreshOptions,
} from "./test-seed-refresh.ts";

// ---------------------------------------------------------------------------
// Synthetic fixture: a fake-prod userdata with a faithful (subset) schema. This
// NEVER touches real prod — the whole suite runs under throwaway temp dirs.
// ---------------------------------------------------------------------------

const UUID = (n: number): string =>
  `${n.toString(16).padStart(8, "0")}-1111-2222-3333-444455556666`;

interface FixtureSpec {
  /** migration_id written to effect_sql_migrations (DB schema version). */
  readonly schemaVersion: number;
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, created_at TEXT, name TEXT);
    CREATE TABLE projection_state (projector TEXT PRIMARY KEY, last_applied_sequence INTEGER, updated_at TEXT);
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT NOT NULL, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, worktree_path TEXT,
      updated_at TEXT, deleted_at TEXT, archived_at TEXT
    );
    CREATE TABLE projection_thread_messages (message_id TEXT PRIMARY KEY, thread_id TEXT, text TEXT);
    CREATE TABLE projection_thread_activities (activity_id TEXT PRIMARY KEY, thread_id TEXT, sequence INTEGER);
    CREATE TABLE projection_turns (row_id INTEGER PRIMARY KEY, thread_id TEXT, turn_id TEXT);
    CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE projection_thread_proposed_plans (plan_id TEXT PRIMARY KEY, thread_id TEXT);
    CREATE TABLE projection_pending_approvals (request_id TEXT PRIMARY KEY, thread_id TEXT);
    CREATE TABLE checkpoint_diff_blobs (thread_id TEXT, from_turn_count INTEGER, diff TEXT);
    CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, resume_cursor_json TEXT);
    CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, stream_id TEXT, event_type TEXT, payload_json TEXT);
    CREATE TABLE orchestration_command_receipts (command_id TEXT PRIMARY KEY, aggregate_id TEXT, status TEXT);
    CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY, subject TEXT, expires_at TEXT);
    CREATE TABLE auth_pairing_links (id TEXT PRIMARY KEY, credential TEXT, expires_at TEXT);
  `);
}

/**
 * 4 projects (p1..p4), each with 3 threads. Project recency descends p1>p2>p3>p4
 * (so --projects 3 keeps p1,p2,p3). Within a project, thread updated_at descends
 * t*a > t*b > t*c. One thread is a `claude-import-*` id to exercise id handling.
 */
let seq = 0;
function nextSeq(): number {
  seq += 1;
  return seq;
}

function seedData(db: DatabaseSync, spec: FixtureSpec): void {
  seq = 0;
  db.prepare(
    "INSERT INTO effect_sql_migrations(migration_id, created_at, name) VALUES (?,?,?)",
  ).run(spec.schemaVersion, "2026-01-01T00:00:00.000Z", `m${spec.schemaVersion}`);

  const insProject = db.prepare(
    "INSERT INTO projection_projects(project_id, title, workspace_root, updated_at, deleted_at) VALUES (?,?,?,?,NULL)",
  );
  const insThread = db.prepare(
    "INSERT INTO projection_threads(thread_id, project_id, title, worktree_path, updated_at, deleted_at, archived_at) VALUES (?,?,?,?,?,NULL,NULL)",
  );
  const insMsg = db.prepare(
    "INSERT INTO projection_thread_messages(message_id, thread_id, text) VALUES (?,?,?)",
  );
  const insAct = db.prepare(
    "INSERT INTO projection_thread_activities(activity_id, thread_id, sequence) VALUES (?,?,?)",
  );
  const insTurn = db.prepare("INSERT INTO projection_turns(thread_id, turn_id) VALUES (?,?)");
  const insSess = db.prepare(
    "INSERT INTO projection_thread_sessions(thread_id, status) VALUES (?,?)",
  );
  const insRuntime = db.prepare(
    "INSERT INTO provider_session_runtime(thread_id, resume_cursor_json) VALUES (?,?)",
  );
  const insEvent = db.prepare(
    "INSERT INTO orchestration_events(sequence, stream_id, event_type, payload_json) VALUES (?,?,?,?)",
  );
  const insReceipt = db.prepare(
    "INSERT INTO orchestration_command_receipts(command_id, aggregate_id, status) VALUES (?,?,?)",
  );

  const projectCount = 4;
  const threadsPer = 3;
  let projectorMax = 0;
  for (let p = 1; p <= projectCount; p += 1) {
    const projectId = `proj-${p}`;
    // Higher p == older; encode recency into updated_at via descending prefix.
    const projRecency = `2026-07-0${9 - p}`;
    // Prod-like absolute workspace path (into the user's REAL repos) that curation
    // must redirect to the inert sandbox.
    const workspaceRoot = `/home/prod/repos/proj-${p}`;
    insProject.run(projectId, `project-${p}`, workspaceRoot, `${projRecency}T00:00:00.000Z`);
    insEvent.run(
      nextSeq(),
      projectId,
      "project.created",
      JSON.stringify({ projectId, title: `project-${p}`, workspaceRoot }),
    );
    projectorMax = seq;

    for (let t = 0; t < threadsPer; t += 1) {
      const isImport = p === 1 && t === 0; // one imported chat in the top project
      const threadId = isImport ? `claude-import-${UUID(p * 10 + t)}` : `thread-${p}-${t}`;
      // Within a project, t=0 newest.
      const threadRecency = `${projRecency}T${(23 - t).toString().padStart(2, "0")}:00:00.000Z`;
      // Even threads carry a prod worktree override; odd threads inherit the
      // project workspace (worktree_path NULL). Curation must clear both.
      const worktreePath = t % 2 === 0 ? `${workspaceRoot}/wt-${t}` : null;
      insThread.run(threadId, projectId, `thread-${p}-${t}`, worktreePath, threadRecency);
      insEvent.run(
        nextSeq(),
        threadId,
        "thread.created",
        JSON.stringify({ threadId, projectId, title: `thread-${p}-${t}`, worktreePath }),
      );

      // Give thread-1-2 (the 3rd, non-kept-at-M2 thread of p1) MANY events to
      // exercise --max-events-per-thread.
      const eventCount = p === 1 && t === 2 ? 12 : 2;
      for (let e = 0; e < eventCount; e += 1) {
        insEvent.run(nextSeq(), threadId, "thread.activity", JSON.stringify({ threadId, e }));
      }
      projectorMax = seq;

      insMsg.run(`msg-${threadId}`, threadId, "hello");
      insAct.run(`act-${threadId}`, threadId, nextSeq());
      insTurn.run(threadId, `turn-${threadId}`);
      insSess.run(threadId, "idle");
      insRuntime.run(threadId, `{"cursor":"${threadId}"}`);
      insReceipt.run(`cmd-${threadId}`, threadId, "accepted");
    }
  }

  db.prepare(
    "INSERT INTO projection_state(projector, last_applied_sequence, updated_at) VALUES (?,?,?)",
  ).run("threads", projectorMax, "2026-07-09T00:00:00.000Z");
  db.prepare(
    "INSERT INTO projection_state(projector, last_applied_sequence, updated_at) VALUES (?,?,?)",
  ).run("projects", projectorMax, "2026-07-09T00:00:00.000Z");

  // Live credentials + pairing tokens that MUST be stripped.
  db.prepare("INSERT INTO auth_sessions(session_id, subject, expires_at) VALUES (?,?,?)").run(
    "sess-1",
    "user",
    "2026-08-01T00:00:00.000Z",
  );
  db.prepare("INSERT INTO auth_pairing_links(id, credential, expires_at) VALUES (?,?,?)").run(
    "pair-1",
    "secret-token",
    "2026-07-10T00:00:00.000Z",
  );
}

function buildFakeProd(root: string, spec: FixtureSpec = { schemaVersion: 32 }): string {
  const userdata = join(root, "userdata");
  mkdirSync(userdata, { recursive: true });
  const dbPath = join(userdata, "state.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  createSchema(db);
  seedData(db, spec);
  db.close();

  writeFileSync(join(userdata, "settings.json"), JSON.stringify({ theme: "dark" }));
  writeFileSync(join(userdata, "keybindings.json"), "{}");
  mkdirSync(join(userdata, "secrets"));
  writeFileSync(join(userdata, "secrets", "openai.bin"), "sk-fake");

  // Attachments: one file per thread, named "<segment>-<uuid>.png".
  const attachments = join(userdata, "attachments");
  mkdirSync(attachments);
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  const threads = reader
    .prepare("SELECT thread_id AS id FROM projection_threads")
    .all() as unknown as ReadonlyArray<{ id: string }>;
  reader.close();
  for (const { id } of threads) {
    const segment = toSafeThreadAttachmentSegment(id);
    if (segment) {
      writeFileSync(join(attachments, `${segment}-${UUID(999)}.png`), "PNGDATA");
    }
  }
  return userdata;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function openTemplateDb(templateDir: string): DatabaseSync {
  return new DatabaseSync(join(templateDir, "userdata", "state.sqlite"), { readOnly: true });
}

function count(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  return Number(Object.values(row ?? { c: 0 })[0] ?? 0);
}

const DEFAULT_OPTS: RefreshOptions = {
  projects: 3,
  threads: 2,
  preferImported: false,
  maxEventsPerThread: null,
};

let home = "";
let prodRoot = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "t3-seed-home-"));
  prodRoot = mkdtempSync(join(tmpdir(), "t3-seed-prod-"));
  process.env.T3_TEST_DEPLOY_HOME = home;
  process.env.T3_SEED_PROD_USERDATA_DIR = join(prodRoot, "userdata");
  process.env.T3_SEED_PROD_DIR = prodRoot; // not a git repo => prodGitSha "unknown"
});

afterEach(() => {
  delete process.env.T3_TEST_DEPLOY_HOME;
  delete process.env.T3_SEED_PROD_USERDATA_DIR;
  delete process.env.T3_SEED_PROD_DIR;
  rmSync(home, { recursive: true, force: true });
  rmSync(prodRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("parseRefreshArgs", () => {
  it("defaults to 3 projects / 4 threads", () => {
    const opts = parseRefreshArgs([]);
    assert.equal(opts.projects, 3);
    assert.equal(opts.threads, 4);
    assert.isFalse(opts.preferImported);
    assert.isNull(opts.maxEventsPerThread);
  });

  it("parses all knobs", () => {
    const opts = parseRefreshArgs([
      "--projects",
      "2",
      "--threads",
      "5",
      "--prefer-imported",
      "--max-events-per-thread",
      "10",
    ]);
    assert.deepEqual(
      { p: opts.projects, t: opts.threads, i: opts.preferImported, m: opts.maxEventsPerThread },
      { p: 2, t: 5, i: true, m: 10 },
    );
  });

  it("rejects a non-integer count", () => {
    assert.throws(() => parseRefreshArgs(["--projects", "x"]), /Invalid --projects/);
  });
});

describe("selectKeptSets", () => {
  function openFixture(): DatabaseSync {
    buildFakeProd(prodRoot);
    const copy = join(home, "work.sqlite");
    cpSync(join(prodRoot, "userdata", "state.sqlite"), copy);
    return new DatabaseSync(copy);
  }

  it("keeps the N most-recently-active projects and M threads each", () => {
    const db = openFixture();
    const kept = selectKeptSets(db, DEFAULT_OPTS);
    assert.deepEqual(
      kept.projects.map((p) => p.id),
      ["proj-1", "proj-2", "proj-3"],
    );
    for (const project of kept.projects) {
      assert.isAtMost(project.threadIds.length, 2);
    }
    // proj-1's two newest threads: the claude-import chat (t=0) + thread-1-1.
    assert.include(kept.projects[0]!.threadIds, `claude-import-${UUID(10)}`);
    assert.equal(kept.threadIds.length, 6);
    // streamIds = kept project ids ∪ kept thread ids.
    assert.equal(kept.streamIds.length, 3 + 6);
    db.close();
  });

  it("keeps all projects when prod has fewer than requested", () => {
    const db = openFixture();
    const kept = selectKeptSets(db, { ...DEFAULT_OPTS, projects: 99 });
    assert.equal(kept.projects.length, 4);
    db.close();
  });

  it("--max-events-per-thread drops oversized threads", () => {
    const db = openFixture();
    // thread-1-2 has 12 events; with a cap of 5 it is excluded from proj-1.
    const kept = selectKeptSets(db, { ...DEFAULT_OPTS, threads: 3, maxEventsPerThread: 5 });
    const p1 = kept.projects.find((p) => p.id === "proj-1")!;
    assert.notInclude(p1.threadIds, "thread-1-2");
    db.close();
  });
});

describe("pruneCuratedDb + verify + rename", () => {
  function seededCopy(): DatabaseSync {
    buildFakeProd(prodRoot);
    const copy = join(home, "work.sqlite");
    cpSync(join(prodRoot, "userdata", "state.sqlite"), copy);
    return new DatabaseSync(copy);
  }

  it("prunes to kept sets with zero orphans and empty sensitive tables", () => {
    const db = seededCopy();
    const sandbox = curatedSandboxDir();
    const kept = selectKeptSets(db, DEFAULT_OPTS);
    db.exec("BEGIN");
    pruneCuratedDb(db, kept);
    // simulate strip inline (stripSensitive is exercised end-to-end below)
    db.exec(
      "DELETE FROM auth_sessions; DELETE FROM auth_pairing_links; DELETE FROM provider_session_runtime;",
    );
    renameCuratedTitles(db);
    neutralizeWorkspacePaths(db, sandbox);
    rewriteCuratedEventPayloads(db, sandbox);
    db.exec("COMMIT");

    assert.equal(count(db, "SELECT COUNT(*) FROM projection_projects"), 3);
    assert.equal(count(db, "SELECT COUNT(*) FROM projection_threads"), 6);
    // per-thread tables carry only kept threads.
    assert.equal(count(db, "SELECT COUNT(*) FROM projection_thread_messages"), 6);
    // provider_session_runtime fully cleared.
    assert.equal(count(db, "SELECT COUNT(*) FROM provider_session_runtime"), 0);
    // Every project/thread row is COPYOF-prefixed.
    assert.equal(
      count(
        db,
        `SELECT COUNT(*) FROM projection_projects WHERE title NOT LIKE '${COPYOF_PREFIX}%'`,
      ),
      0,
    );
    assert.equal(
      count(db, `SELECT COUNT(*) FROM projection_threads WHERE title NOT LIKE '${COPYOF_PREFIX}%'`),
      0,
    );

    // SAFETY: no prod workspace path survives — every workspace_root is redirected
    // to the inert sandbox and every worktree_path is nulled (both in projections
    // and in the source events, so a projection rebuild cannot restore prod paths).
    assert.equal(
      count(db, `SELECT COUNT(*) FROM projection_projects WHERE workspace_root <> '${sandbox}'`),
      0,
    );
    assert.equal(
      count(db, "SELECT COUNT(*) FROM projection_threads WHERE worktree_path IS NOT NULL"),
      0,
    );
    assert.equal(
      count(
        db,
        "SELECT COUNT(*) FROM orchestration_events WHERE payload_json LIKE '%/home/prod/repos/%'",
      ),
      0,
    );

    // verifyCuratedDb passes on the pruned+stripped+renamed+neutralized copy.
    verifyCuratedDb(db, sandbox);
    db.close();
  });

  it("verifyCuratedDb throws when a prod workspace path survives", () => {
    const db = seededCopy();
    const sandbox = curatedSandboxDir();
    const kept = selectKeptSets(db, DEFAULT_OPTS);
    db.exec("BEGIN");
    pruneCuratedDb(db, kept);
    db.exec(
      "DELETE FROM auth_sessions; DELETE FROM auth_pairing_links; DELETE FROM provider_session_runtime;",
    );
    renameCuratedTitles(db);
    // Deliberately SKIP neutralizeWorkspacePaths/rewriteCuratedEventPayloads.
    db.exec("COMMIT");
    assert.throws(() => verifyCuratedDb(db, sandbox), /workspace_root|worktree_path/);
    db.close();
  });

  it("renameCuratedTitles is idempotent (double-run adds no second prefix)", () => {
    const db = seededCopy();
    renameCuratedTitles(db);
    renameCuratedTitles(db);
    const titles = db
      .prepare("SELECT title FROM projection_projects")
      .all() as unknown as ReadonlyArray<{ title: string }>;
    for (const { title } of titles) {
      assert.equal(title.startsWith(`${COPYOF_PREFIX}${COPYOF_PREFIX}`), false);
      assert.isTrue(title.startsWith(COPYOF_PREFIX));
    }
    db.close();
  });

  it("verifyCuratedDb throws on an orphan row", () => {
    const db = seededCopy();
    const sandbox = curatedSandboxDir();
    const kept = selectKeptSets(db, DEFAULT_OPTS);
    db.exec("BEGIN");
    pruneCuratedDb(db, kept);
    renameCuratedTitles(db);
    neutralizeWorkspacePaths(db, sandbox);
    rewriteCuratedEventPayloads(db, sandbox);
    db.exec("COMMIT");
    // Inject an orphan message referencing a dropped thread.
    db.exec(
      "INSERT INTO projection_thread_messages(message_id, thread_id, text) VALUES ('orphan','thread-4-0','x')",
    );
    assert.throws(() => verifyCuratedDb(db, sandbox), /orphan/);
    db.close();
  });
});

describe("runRefresh end-to-end (prod read-only)", () => {
  it("builds a curated template and leaves prod byte-identical", async () => {
    const userdata = buildFakeProd(prodRoot);
    const prodDb = join(userdata, "state.sqlite");
    const beforeSha = sha256(prodDb);
    const beforeMtime = statSync(prodDb).mtimeMs;

    const manifest = await runRefresh(DEFAULT_OPTS);

    // Prod untouched.
    assert.equal(sha256(prodDb), beforeSha);
    assert.equal(statSync(prodDb).mtimeMs, beforeMtime);

    // Template resolves and is complete.
    const template = resolveSeedTemplate();
    assert.isNotNull(template);
    const db = openTemplateDb(template!.dir);
    assert.equal(
      (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
      "ok",
    );
    assert.equal(count(db, "SELECT COUNT(*) FROM projection_projects"), 3);
    assert.equal(count(db, "SELECT COUNT(*) FROM projection_threads"), 6);
    assert.equal(count(db, "SELECT COUNT(*) FROM auth_sessions"), 0);
    assert.equal(count(db, "SELECT COUNT(*) FROM auth_pairing_links"), 0);
    assert.equal(count(db, "SELECT COUNT(*) FROM provider_session_runtime"), 0);
    assert.equal(
      count(
        db,
        `SELECT COUNT(*) FROM projection_projects WHERE title NOT LIKE '${COPYOF_PREFIX}%'`,
      ),
      0,
    );

    // SAFETY: the shipped template holds NO prod workspace path — every workspace
    // is redirected to the inert sandbox and every worktree override is nulled, in
    // both the projections and the source events.
    const sandbox = curatedSandboxDir();
    assert.equal(
      count(db, `SELECT COUNT(*) FROM projection_projects WHERE workspace_root <> '${sandbox}'`),
      0,
    );
    assert.equal(
      count(db, "SELECT COUNT(*) FROM projection_threads WHERE worktree_path IS NOT NULL"),
      0,
    );
    assert.equal(
      count(
        db,
        "SELECT COUNT(*) FROM orchestration_events WHERE payload_json LIKE '%/home/prod/repos/%'",
      ),
      0,
    );
    // The COPYOF marker also lives in the events, so it survives a projection
    // rebuild on the test worktree.
    assert.isAbove(
      count(
        db,
        `SELECT COUNT(*) FROM orchestration_events WHERE payload_json LIKE '%${COPYOF_PREFIX}%'`,
      ),
      0,
    );
    db.close();

    // No -wal/-shm sidecar in the template (single VACUUMed file).
    assert.isFalse(existsSync(join(template!.userdata, "state.sqlite-wal")));

    // Manifest fields.
    assert.equal(manifest.projects, 3);
    assert.equal(manifest.threadsPerProject, 2);
    assert.equal(manifest.dbSchemaVersion, 32);
    assert.equal(manifest.pruneSchemaVersion, 32);
    assert.equal(manifest.keptThreadIds.length, 6);
    assert.equal(manifest.prodGitSha, "unknown");
    assert.isTrue(manifest.keptProjects.every((p) => p.title.startsWith(COPYOF_PREFIX)));
    const onDisk = readSeedManifest(template!.dir);
    assert.deepEqual(onDisk?.keptThreadIds, manifest.keptThreadIds);

    // Settings + secrets copied; attachments pruned to kept threads only.
    assert.isTrue(existsSync(join(template!.userdata, "settings.json")));
    assert.isTrue(existsSync(join(template!.userdata, "secrets", "openai.bin")));
    const keptSegments = new Set(
      manifest.keptThreadIds
        .map((id) => toSafeThreadAttachmentSegment(id))
        .filter(Boolean) as string[],
    );
    for (const file of readdirSync(join(template!.userdata, "attachments"))) {
      const seg = attachmentFileThreadSegment(file);
      assert.isTrue(seg !== null && keptSegments.has(seg), `unexpected attachment ${file}`);
    }
    assert.equal(readdirSync(join(template!.userdata, "attachments")).length, keptSegments.size);
  });

  it("refuses when prod schema is newer than the prune list", async () => {
    buildFakeProd(prodRoot, { schemaVersion: 33 });
    let err: Error | null = null;
    try {
      await runRefresh(DEFAULT_OPTS);
    } catch (e) {
      err = e as Error;
    }
    assert.isNotNull(err);
    assert.match(err!.message, /schema 33/);
    // A refused build must not leave a published template behind.
    assert.isNull(resolveSeedTemplate());
  });

  it("builds an empty-but-valid template for empty prod", async () => {
    // Empty prod: schema present, no projects/threads.
    const userdata = join(prodRoot, "userdata");
    mkdirSync(userdata, { recursive: true });
    const db = new DatabaseSync(join(userdata, "state.sqlite"));
    createSchema(db);
    db.prepare(
      "INSERT INTO effect_sql_migrations(migration_id, created_at, name) VALUES (32,'x','m')",
    ).run();
    db.prepare(
      "INSERT INTO projection_state(projector, last_applied_sequence, updated_at) VALUES ('t',0,'x')",
    ).run();
    db.close();

    const manifest = await runRefresh(DEFAULT_OPTS);
    assert.equal(manifest.projects, 0);
    const template = resolveSeedTemplate();
    assert.isNotNull(template);
    const tdb = openTemplateDb(template!.dir);
    assert.equal(
      (tdb.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
      "ok",
    );
    tdb.close();
  });
});

describe("atomic publish + GC", () => {
  it("resolveSeedTemplate always resolves a complete dir across rebuilds", async () => {
    buildFakeProd(prodRoot);
    await runRefresh(DEFAULT_OPTS);
    const first = resolveSeedTemplate();
    assert.isNotNull(first);
    assert.isTrue(existsSync(join(first!.userdata, "state.sqlite")));

    // Rebuild; the symlink swaps atomically to a new complete dir.
    await new Promise((r) => setTimeout(r, 1100)); // distinct builtAt label (second resolution)
    await runRefresh(DEFAULT_OPTS);
    const second = resolveSeedTemplate();
    assert.isNotNull(second);
    assert.isTrue(existsSync(second!.manifestPath));
  });

  it("retains only the newest 2 version dirs", () => {
    const { seedVersions } = registryPaths();
    mkdirSync(seedVersions, { recursive: true });
    for (const name of ["2026-07-09T10-00-00Z", "2026-07-09T11-00-00Z", "2026-07-09T12-00-00Z"]) {
      mkdirSync(join(seedVersions, name, "userdata"), { recursive: true });
    }
    gcSeedVersions(join(seedVersions, "2026-07-09T12-00-00Z"));
    const remaining = readdirSync(seedVersions).sort();
    assert.deepEqual(remaining, ["2026-07-09T11-00-00Z", "2026-07-09T12-00-00Z"]);
  });
});

describe("attachment segment parity with server helpers", () => {
  // Golden values captured from apps/server/src/attachmentStore.ts
  // (toSafeThreadAttachmentSegment / parseThreadSegmentFromAttachmentId). The
  // ported helpers in test-deploy-lib.ts must stay in lockstep with the server's;
  // these goldens fail loudly if the server derivation ever changes. Cross-project
  // type-checking forbids importing the server module here, so we assert against
  // its verified outputs instead.
  const GOLDEN: ReadonlyArray<{ threadId: string; segment: string }> = [
    {
      threadId: "1c9df8e0-1111-2222-3333-444455556666",
      segment: "1c9df8e0-1111-2222-3333-444455556666",
    },
    {
      threadId: "claude-import-1c9df8e0-1111-2222-3333-444455556666",
      segment: "claude-import-1c9df8e0-1111-2222-3333-444455556666",
    },
  ];

  for (const { threadId, segment } of GOLDEN) {
    it(`derives the server segment for ${threadId.slice(0, 20)}...`, () => {
      assert.equal(toSafeThreadAttachmentSegment(threadId), segment);
      // Round-trip: a file "<segment>-<uuid>.png" recovers the same segment.
      const fileName = `${segment}-${UUID(7)}.png`;
      assert.equal(attachmentFileThreadSegment(fileName), segment);
    });
  }

  it("matches the server's parseThreadSegmentFromAttachmentId on a plain segment", () => {
    // Server: parseThreadSegmentFromAttachmentId("myseg-<uuid>") === "myseg".
    assert.equal(attachmentFileThreadSegment(`myseg-${UUID(7)}.png`), "myseg");
  });

  it("rejects non-attachment file names", () => {
    assert.isNull(attachmentFileThreadSegment("nodotshere"));
    assert.isNull(attachmentFileThreadSegment("not-a-uuid.png"));
  });
});
