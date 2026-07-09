// Build / refresh the curated seed template for the test-deploy framework.
//
//   node scripts/test-seed-refresh.ts \
//     [--projects N=3] [--threads M=4] \
//     [--prefer-imported] [--max-events-per-thread K]
//
// Reads prod userdata STRICTLY READ-ONLY (a WAL-safe online backup), prunes the
// snapshot COPY down to the most-recently-active projects/threads, prefixes every
// project/thread title with "COPYOF ", strips all auth sessions / pairing links /
// provider resume state, VACUUMs the result into a single static DB, copies
// settings/secrets/pruned-attachments, and publishes the whole thing atomically
// via a symlink swap at ~/.t3-test-deploy/seed-template.
//
// PROD IS SACRED. Every prod path is opened read-only; all DELETE/UPDATE/VACUUM
// happen on the backed-up copy under the registry's seed-versions/ dir. This
// script never opens prod for write and never writes anywhere but its own build
// dir. See docs/test-deployments.md ("Seeding a test instance").
//
// These scripts intentionally avoid the repo's Effect toolchain (dependency-free
// Node 24 type-stripped, invoked with `node scripts/<name>.ts`).

import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import {
  acquireSeedRefreshLock,
  attachmentFileThreadSegment,
  COPYOF_PREFIX,
  ensureRegistry,
  PROD_DIR,
  PROD_USERDATA_DIR,
  PRUNE_SCHEMA_VERSION,
  registryPaths,
  registryRoot,
  runCapture,
  SEED_DEFAULT_PROJECTS,
  SEED_DEFAULT_THREADS,
  SEED_MANIFEST_SCHEMA_VERSION,
  toSafeThreadAttachmentSegment,
  type SeedManifest,
  type SeedManifestKeptProject,
} from "./test-deploy-lib.ts";

// ---------------------------------------------------------------------------
// Prod guard constants
// ---------------------------------------------------------------------------

/**
 * The reconnaissance-verified absolute prod userdata dir. When the refresh runs
 * against REAL prod (no test override), PROD_USERDATA_DIR must still equal this —
 * a drifted constant would mean we no longer know we are reading the real prod
 * and we refuse rather than snapshot an unknown location.
 */
const RECON_PROD_USERDATA = join(homedir(), ".t3", "userdata");

/**
 * Test/dev override for the prod userdata source. Tests point this at a
 * throwaway fake-prod so the suite never depends on (or touches) real prod. When
 * set, the RECON constant check is skipped, but the "never under registryRoot"
 * and read-only guards still apply.
 */
function prodUserdataDir(): string {
  const override = process.env.T3_SEED_PROD_USERDATA_DIR;
  return override && override.trim().length > 0 ? override.trim() : PROD_USERDATA_DIR;
}

/** Git-sha source dir (read-only `git rev-parse`); overridable for hermetic tests. */
function prodGitDir(): string {
  const override = process.env.T3_SEED_PROD_DIR;
  return override && override.trim().length > 0 ? override.trim() : PROD_DIR;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RefreshOptions {
  readonly projects: number;
  readonly threads: number;
  readonly preferImported: boolean;
  readonly maxEventsPerThread: number | null;
}

function parseCount(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || String(n) !== raw.trim()) {
    throw new Error(`Invalid ${flag} ${raw}. Use a non-negative integer.`);
  }
  return n;
}

export function parseRefreshArgs(argv: readonly string[]): RefreshOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      projects: { type: "string" },
      threads: { type: "string" },
      "prefer-imported": { type: "boolean", default: false },
      "max-events-per-thread": { type: "string" },
    },
  });
  const maxEventsRaw = values["max-events-per-thread"];
  return {
    projects: parseCount(values.projects, SEED_DEFAULT_PROJECTS, "--projects"),
    threads: parseCount(values.threads, SEED_DEFAULT_THREADS, "--threads"),
    preferImported: values["prefer-imported"] === true,
    maxEventsPerThread:
      maxEventsRaw === undefined ? null : parseCount(maxEventsRaw, 0, "--max-events-per-thread"),
  };
}

// ---------------------------------------------------------------------------
// Kept-set selection (pure over an open DB; exported for tests)
// ---------------------------------------------------------------------------

export interface KeptProject {
  readonly id: string;
  /** Title as it stands in the DB at selection time (pre-COPYOF rename). */
  readonly title: string;
  readonly threadIds: readonly string[];
}

export interface KeptSets {
  readonly projects: readonly KeptProject[];
  readonly threadIds: readonly string[];
  /** kept project ids ∪ kept thread ids (orchestration streams/aggregates). */
  readonly streamIds: readonly string[];
}

function eventCountForStream(db: DatabaseSync, streamId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM orchestration_events WHERE stream_id = ?")
    .get(streamId) as { c: number } | undefined;
  return row?.c ?? 0;
}

/**
 * Select the kept projects (most recently active first) and, per project, the
 * kept threads. Deterministic and computed — never hardcoded. If prod has fewer
 * projects/threads than requested, keep all available. Optional knobs:
 *   - preferImported: bias thread pick toward `claude-import-*` (small chats).
 *   - maxEventsPerThread: drop threads whose orchestration_events count exceeds K.
 */
export function selectKeptSets(db: DatabaseSync, opts: RefreshOptions): KeptSets {
  const projectRows = db
    .prepare(
      `SELECT p.project_id AS id, p.title AS title
         FROM projection_projects p
         JOIN projection_threads t ON t.project_id = p.project_id
        WHERE p.deleted_at IS NULL
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL
        GROUP BY p.project_id, p.title
        ORDER BY MAX(t.updated_at) DESC
        LIMIT ?`,
    )
    .all(opts.projects) as unknown as ReadonlyArray<{ id: string; title: string }>;

  // --prefer-imported biases the pick toward small `claude-import-*` chats; the
  // default order is purely most-recently-active. The trailing `updated_at DESC`
  // keeps selection deterministic either way.
  const threadOrderBy = opts.preferImported
    ? "(thread_id LIKE 'claude-import-%') DESC, updated_at DESC"
    : "updated_at DESC";
  const threadStmt = db.prepare(
    `SELECT thread_id AS id
       FROM projection_threads
      WHERE project_id = ?
        AND deleted_at IS NULL
        AND archived_at IS NULL
      ORDER BY ${threadOrderBy}`,
  );

  const projects: KeptProject[] = [];
  const threadIds: string[] = [];
  for (const project of projectRows) {
    const rows = threadStmt.all(project.id) as unknown as ReadonlyArray<{ id: string }>;

    const kept: string[] = [];
    for (const row of rows) {
      if (kept.length >= opts.threads) {
        break;
      }
      if (
        opts.maxEventsPerThread !== null &&
        eventCountForStream(db, row.id) > opts.maxEventsPerThread
      ) {
        continue;
      }
      kept.push(row.id);
    }
    if (kept.length === 0) {
      continue; // a project all of whose threads were filtered out is dropped
    }
    projects.push({ id: project.id, title: project.title, threadIds: kept });
    threadIds.push(...kept);
  }

  const streamIds = [...projects.map((p) => p.id), ...threadIds];
  return { projects, threadIds, streamIds };
}

// ---------------------------------------------------------------------------
// Prune / strip / rename / verify — all on the snapshot COPY.
// ---------------------------------------------------------------------------

/**
 * Per-thread projection tables keyed by `thread_id`. Exhaustive as of schema
 * PRUNE_SCHEMA_VERSION — there are NO SQL foreign keys, so nothing cascades and
 * every project/thread-keyed table must be listed here. Bump PRUNE_SCHEMA_VERSION
 * and extend this list together when a migration adds such a table.
 */
const PER_THREAD_TABLES = [
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_turns",
  "projection_thread_sessions",
  "projection_thread_proposed_plans",
  "projection_pending_approvals",
  "checkpoint_diff_blobs",
] as const;

function loadKeptTempTables(db: DatabaseSync, kept: KeptSets): void {
  db.exec(
    `CREATE TEMP TABLE _kept_projects(id TEXT PRIMARY KEY);
     CREATE TEMP TABLE _kept_threads(id TEXT PRIMARY KEY);
     CREATE TEMP TABLE _kept_streams(id TEXT PRIMARY KEY);`,
  );
  const insProject = db.prepare("INSERT OR IGNORE INTO _kept_projects(id) VALUES (?)");
  for (const project of kept.projects) {
    insProject.run(project.id);
  }
  const insThread = db.prepare("INSERT OR IGNORE INTO _kept_threads(id) VALUES (?)");
  for (const id of kept.threadIds) {
    insThread.run(id);
  }
  const insStream = db.prepare("INSERT OR IGNORE INTO _kept_streams(id) VALUES (?)");
  for (const id of kept.streamIds) {
    insStream.run(id);
  }
}

/**
 * Delete-all-except-kept, exhaustively. `projection_state` is deliberately left
 * untouched (it is the global projector cursor; keeping it ≥ max remaining
 * sequence means the server does no boot replay). Runs inside the caller's
 * transaction.
 *
 * NOTE (deviation from the spec's literal listing): `projection_threads` is
 * pruned by `thread_id NOT IN keptThreadIds`, which is STRICTER than the spec's
 * "project_id NOT IN keptProjectIds" (it also drops non-kept threads within kept
 * projects). This avoids leaving empty "shell" threads with a title but no
 * messages, matching the "a few conversations each" promise. Because every kept
 * thread belongs to a kept project, this also satisfies the project_id
 * constraint. Non-kept projects lose all their threads and are dropped by the
 * project_id delete below.
 */
export function pruneCuratedDb(db: DatabaseSync, kept: KeptSets): void {
  loadKeptTempTables(db, kept);

  db.exec(
    `DELETE FROM orchestration_events WHERE stream_id NOT IN (SELECT id FROM _kept_streams);`,
  );
  db.exec(
    `DELETE FROM orchestration_command_receipts WHERE aggregate_id NOT IN (SELECT id FROM _kept_streams);`,
  );
  db.exec(
    `DELETE FROM projection_projects WHERE project_id NOT IN (SELECT id FROM _kept_projects);`,
  );
  db.exec(`DELETE FROM projection_threads WHERE thread_id NOT IN (SELECT id FROM _kept_threads);`);
  for (const table of PER_THREAD_TABLES) {
    db.exec(`DELETE FROM ${table} WHERE thread_id NOT IN (SELECT id FROM _kept_threads);`);
  }

  db.exec(`DROP TABLE _kept_projects; DROP TABLE _kept_threads; DROP TABLE _kept_streams;`);
}

/**
 * Strip everything credential/resume-bearing (unconditional):
 *   - auth_sessions / auth_pairing_links: prod's live 30-day bearers + pairing
 *     tokens must never travel into a test instance.
 *   - provider_session_runtime (ENTIRE table): drops every thread's resume cursor
 *     so a test instance can never reconnect to a live prod Claude/Codex session.
 *     Kept threads keep their full message/activity history; they simply start a
 *     fresh provider session if the user interacts.
 */
export function stripSensitive(db: DatabaseSync): void {
  db.exec(`DELETE FROM auth_sessions;`);
  db.exec(`DELETE FROM auth_pairing_links;`);
  db.exec(`DELETE FROM provider_session_runtime;`);
}

/**
 * Rename kept project/thread titles at the DURABLE projection layer (idempotent
 * via the NOT LIKE guard). The paired `rewriteCuratedEventPayloads` also prefixes
 * the titles carried in the source orchestration_events, so the COPYOF marker (and
 * the neutralized workspace paths below) survive even a projection rebuild on the
 * test worktree — the projector re-derives titles/paths from those events.
 */
export function renameCuratedTitles(db: DatabaseSync): void {
  db.prepare(`UPDATE projection_projects SET title = ? || title WHERE title NOT LIKE ?`).run(
    COPYOF_PREFIX,
    `${COPYOF_PREFIX}%`,
  );
  db.prepare(
    `UPDATE projection_threads SET title = ? || title WHERE title IS NOT NULL AND title <> '' AND title NOT LIKE ?`,
  ).run(COPYOF_PREFIX, `${COPYOF_PREFIX}%`);
}

/**
 * The inert, per-host scratch directory every curated thread's workspace is
 * redirected to. It lives under the test registry root (never under prod, never a
 * real git repo) and is created by `runRefresh`. See `neutralizeWorkspacePaths`.
 */
export function curatedSandboxDir(): string {
  return join(registryRoot(), "curated-sandbox");
}

/**
 * SAFETY-CRITICAL. Prod's `projection_projects.workspace_root` /
 * `projection_threads.worktree_path` are absolute paths into the USER'S REAL
 * repositories. The server derives a turn's spawn `cwd` from exactly these columns
 * (resolveThreadWorkspaceCwd → worktreePath ?? workspaceRoot, fed to the provider
 * session in ProviderCommandReactor), so if they travelled verbatim into a test
 * instance, opening a "COPYOF …" thread and sending a message would run a coding
 * agent against live prod source — reading, editing, and committing it. That
 * would blow the whole read-only-prod guarantee.
 *
 * So we repoint EVERY workspace at a single inert sandbox dir (which is never prod
 * and never a real repo) and null every per-thread worktree override so it falls
 * back to that same sandbox. `workspace_root` is `NOT NULL`, hence the concrete
 * sandbox path rather than NULL.
 */
export function neutralizeWorkspacePaths(db: DatabaseSync, sandboxPath: string): void {
  db.prepare("UPDATE projection_projects SET workspace_root = ?").run(sandboxPath);
  db.prepare("UPDATE projection_threads SET worktree_path = NULL").run();
}

/**
 * Event types whose payloads carry a project/thread `title`, `workspaceRoot`, or
 * `worktreePath` that a projector replays into the projection tables. Kept in
 * lockstep with apps/server/src/orchestration/projector.ts.
 */
const CURATED_PAYLOAD_EVENT_TYPES = [
  "project.created",
  "project.meta-updated",
  "thread.created",
  "thread.meta-updated",
] as const;

/**
 * Apply the curation (COPYOF titles + neutralized workspace paths) to the SOURCE
 * orchestration_events too, not just the projection rows. The projection layer is
 * what the running server reads today, but the events are the source of truth: a
 * future migration on the test worktree that rebuilds projections from events (a
 * normal maintenance pattern here — the projection_state cursor can be reset)
 * would otherwise restore the original prod titles AND the original prod workspace
 * paths, silently un-doing both the visible COPYOF marker and — far worse — the
 * read-only-prod safety redirect. Rewriting the events makes the curated invariant
 * hold regardless of whether projections are ever rebuilt. Runs on the pruned COPY
 * only (kept events), inside the caller's transaction.
 */
export function rewriteCuratedEventPayloads(db: DatabaseSync, sandboxPath: string): void {
  const placeholders = CURATED_PAYLOAD_EVENT_TYPES.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT sequence AS seq, payload_json AS payload
         FROM orchestration_events
        WHERE event_type IN (${placeholders})`,
    )
    .all(...CURATED_PAYLOAD_EVENT_TYPES) as unknown as ReadonlyArray<{
    seq: number;
    payload: string;
  }>;
  const update = db.prepare("UPDATE orchestration_events SET payload_json = ? WHERE sequence = ?");
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(row.payload);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      continue; // a payload we cannot parse carries no title/path we could leak
    }
    let changed = false;
    if (typeof payload.workspaceRoot === "string") {
      payload.workspaceRoot = sandboxPath;
      changed = true;
    }
    if (typeof payload.worktreePath === "string") {
      payload.worktreePath = null;
      changed = true;
    }
    if (
      typeof payload.title === "string" &&
      payload.title.length > 0 &&
      !payload.title.startsWith(COPYOF_PREFIX)
    ) {
      payload.title = `${COPYOF_PREFIX}${payload.title}`;
      changed = true;
    }
    if (changed) {
      update.run(JSON.stringify(payload), row.seq);
    }
  }
}

function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  if (!row) {
    return 0;
  }
  const value = Object.values(row)[0];
  return typeof value === "number" ? value : Number(value ?? 0);
}

/** Throw if the curated copy is not shippable. Runs on the COPY only. */
export function verifyCuratedDb(db: DatabaseSync, sandboxPath: string): void {
  const integrity = db.prepare("PRAGMA integrity_check").get() as
    | { integrity_check?: string }
    | undefined;
  if (integrity?.integrity_check !== "ok") {
    throw new Error(`integrity_check failed: ${JSON.stringify(integrity)}`);
  }

  // MAX(sequence) must not exceed the (unchanged) cursor of ANY projector, else
  // boot would replay events the projectors have not seen.
  const maxSeq = scalar(db, "SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events");
  const minCursor = scalar(
    db,
    "SELECT COALESCE(MIN(last_applied_sequence), 0) FROM projection_state",
  );
  if (maxSeq > minCursor) {
    throw new Error(
      `orchestration_events MAX(sequence)=${maxSeq} exceeds min projector cursor ${minCursor}`,
    );
  }

  // Zero orphans across every per-thread table, and threads → projects.
  for (const table of PER_THREAD_TABLES) {
    const orphans = scalar(
      db,
      `SELECT COUNT(*) FROM ${table} x
         LEFT JOIN projection_threads t ON t.thread_id = x.thread_id
        WHERE t.thread_id IS NULL`,
    );
    if (orphans > 0) {
      throw new Error(`${orphans} orphan row(s) in ${table} (no parent thread)`);
    }
  }
  const orphanThreads = scalar(
    db,
    `SELECT COUNT(*) FROM projection_threads t
       LEFT JOIN projection_projects p ON p.project_id = t.project_id
      WHERE p.project_id IS NULL`,
  );
  if (orphanThreads > 0) {
    throw new Error(`${orphanThreads} orphan thread(s) (no parent project)`);
  }

  // Sensitive tables must be empty.
  for (const table of ["auth_sessions", "auth_pairing_links", "provider_session_runtime"]) {
    const n = scalar(db, `SELECT COUNT(*) FROM ${table}`);
    if (n > 0) {
      throw new Error(`${table} not empty after strip (${n} rows)`);
    }
  }

  // Every project title, and every non-empty thread title, is COPYOF-prefixed.
  const badProjects = scalar(
    db,
    `SELECT COUNT(*) FROM projection_projects WHERE title NOT LIKE '${COPYOF_PREFIX}%'`,
  );
  if (badProjects > 0) {
    throw new Error(`${badProjects} project title(s) missing the ${COPYOF_PREFIX.trim()} prefix`);
  }
  const badThreads = scalar(
    db,
    `SELECT COUNT(*) FROM projection_threads
      WHERE title IS NOT NULL AND title <> '' AND title NOT LIKE '${COPYOF_PREFIX}%'`,
  );
  if (badThreads > 0) {
    throw new Error(`${badThreads} thread title(s) missing the ${COPYOF_PREFIX.trim()} prefix`);
  }

  // SAFETY-CRITICAL: every workspace path must be the inert sandbox — no prod repo
  // path may survive into a shippable template (see neutralizeWorkspacePaths).
  const liveWorkspaces = (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM projection_projects WHERE workspace_root IS NULL OR workspace_root <> ?",
      )
      .get(sandboxPath) as { c: number }
  ).c;
  if (liveWorkspaces > 0) {
    throw new Error(
      `${liveWorkspaces} project workspace_root(s) not redirected to the curated sandbox`,
    );
  }
  const liveWorktrees = scalar(
    db,
    "SELECT COUNT(*) FROM projection_threads WHERE worktree_path IS NOT NULL",
  );
  if (liveWorktrees > 0) {
    throw new Error(`${liveWorktrees} thread worktree_path(s) not nulled to the curated sandbox`);
  }

  // The same must hold at the event layer, or a projection rebuild would restore a
  // prod path/title. Scan the kept title/path-bearing events.
  const eventPlaceholders = CURATED_PAYLOAD_EVENT_TYPES.map(() => "?").join(", ");
  const payloadRows = db
    .prepare(
      `SELECT payload_json AS payload FROM orchestration_events WHERE event_type IN (${eventPlaceholders})`,
    )
    .all(...CURATED_PAYLOAD_EVENT_TYPES) as unknown as ReadonlyArray<{ payload: string }>;
  for (const { payload: raw } of payloadRows) {
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof payload.workspaceRoot === "string" && payload.workspaceRoot !== sandboxPath) {
      throw new Error("an orchestration event still carries a non-sandbox workspaceRoot");
    }
    if (typeof payload.worktreePath === "string") {
      throw new Error("an orchestration event still carries a worktreePath");
    }
    if (
      typeof payload.title === "string" &&
      payload.title.length > 0 &&
      !payload.title.startsWith(COPYOF_PREFIX)
    ) {
      throw new Error(`an orchestration event title is missing the ${COPYOF_PREFIX.trim()} prefix`);
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot (WAL-safe, prod read-only)
// ---------------------------------------------------------------------------

/**
 * Online-backup prod's state.sqlite into `dstDbPath`, opening prod strictly
 * read-only (SQLITE_OPEN_READONLY). Returns the sqlite lib used. Prefers the
 * built-in node:sqlite backup(); falls back to the proven python3 read-only
 * backup one-liner if node:sqlite's backup() is unavailable/broken.
 */
async function snapshotProdDb(srcDbPath: string, dstDbPath: string): Promise<string> {
  try {
    const src = new DatabaseSync(srcDbPath, { readOnly: true });
    try {
      await backup(src, dstDbPath);
    } finally {
      src.close();
    }
    return "node:sqlite (node 24)";
  } catch (nodeErr) {
    // Fallback: python3 sqlite3 read-only online backup (recon-verified WAL-safe).
    const py = [
      "import sqlite3, sys",
      "src = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)",
      "dst = sqlite3.connect(sys.argv[2])",
      "src.backup(dst)",
      "dst.close(); src.close()",
    ].join("; ");
    const result = runCapture("python3", ["-c", py, srcDbPath, dstDbPath]);
    if (result.status !== 0) {
      throw new Error(
        `snapshot failed: node:sqlite backup error (${(nodeErr as Error).message}); ` +
          `python3 fallback error (${result.stderr.trim() || result.stdout.trim()})`,
      );
    }
    return "python3 sqlite3 (fallback)";
  }
}

// ---------------------------------------------------------------------------
// Attachment pruning (read-only from prod)
// ---------------------------------------------------------------------------

function copyPrunedAttachments(
  prodAttachments: string,
  destAttachments: string,
  keptThreadIds: readonly string[],
): number {
  if (!existsSync(prodAttachments)) {
    return 0;
  }
  const keptSegments = new Set<string>();
  for (const id of keptThreadIds) {
    const segment = toSafeThreadAttachmentSegment(id);
    if (segment) {
      keptSegments.add(segment);
    }
  }
  let copied = 0;
  let madeDir = false;
  for (const entry of readdirSync(prodAttachments, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const segment = attachmentFileThreadSegment(entry.name);
    if (segment === null || !keptSegments.has(segment)) {
      continue;
    }
    if (!madeDir) {
      mkdirSync(destAttachments, { recursive: true, mode: 0o700 });
      madeDir = true;
    }
    cpSync(join(prodAttachments, entry.name), join(destAttachments, entry.name));
    copied += 1;
  }
  return copied;
}

// ---------------------------------------------------------------------------
// fsync helpers (best-effort durability of the build tree before publish)
// ---------------------------------------------------------------------------

function fsyncPath(path: string): void {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best-effort; a failed dir fsync must not abort a valid build
  }
}

// ---------------------------------------------------------------------------
// Publish (atomic symlink swap) + GC
// ---------------------------------------------------------------------------

const VERSION_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:\.\d+)?$/;

/**
 * Atomically publish `versionDir` (a completed real dir under seed-versions) as
 * the active template: create a temp symlink then rename it over seed-template.
 * A concurrent deploy therefore always resolves either the old complete template
 * or the new one — never a half-built dir.
 */
export function publishTemplate(versionDir: string): void {
  const { seedTemplate } = registryPaths();
  const tmpLink = `${seedTemplate}.tmp.${process.pid}`;
  try {
    unlinkSync(tmpLink);
  } catch {
    // ignore missing leftover
  }
  // Relative target keeps the symlink valid if the registry root is relocated.
  symlinkSync(join("seed-versions", basename(versionDir)), tmpLink);
  renameSync(tmpLink, seedTemplate); // atomic replace of the symlink on POSIX
}

/** Keep the newest 2 version dirs; delete older. Never deletes `keep`. */
export function gcSeedVersions(keep: string): void {
  const { seedVersions } = registryPaths();
  const dirs = readdirSync(seedVersions, { withFileTypes: true })
    .filter((e) => e.isDirectory() && VERSION_DIR_PATTERN.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse(); // newest first (ISO sorts chronologically)
  const survivors = new Set(dirs.slice(0, 2));
  survivors.add(basename(keep));
  for (const name of dirs) {
    if (!survivors.has(name)) {
      rmSync(join(seedVersions, name), { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Build pipeline
// ---------------------------------------------------------------------------

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertProdReadOnlyGuards(prodUserdata: string): void {
  const override = process.env.T3_SEED_PROD_USERDATA_DIR;
  const usingRealProd = !(override && override.trim().length > 0);

  if (usingRealProd && PROD_USERDATA_DIR !== RECON_PROD_USERDATA) {
    throw new Error(
      `Refusing: PROD_USERDATA_DIR (${PROD_USERDATA_DIR}) is not the recon constant ` +
        `(${RECON_PROD_USERDATA}); refusing to snapshot an unknown location as prod.`,
    );
  }

  // Never treat a slot base-dir under the registry as a prod source.
  let prodReal = prodUserdata;
  let rootReal = registryRoot();
  try {
    prodReal = realpathSync(prodUserdata);
  } catch {
    // handled below by existence check
  }
  try {
    rootReal = realpathSync(registryRoot());
  } catch {
    // registry may not exist yet
  }
  if (prodReal === rootReal || prodReal.startsWith(`${rootReal}/`)) {
    throw new Error(
      `Refusing: prod userdata (${prodUserdata}) resolves under the test registry ` +
        `(${registryRoot()}); a slot base-dir is never a valid prod source.`,
    );
  }

  if (!existsSync(join(prodUserdata, "state.sqlite"))) {
    throw new Error(`Prod userdata has no state.sqlite at ${join(prodUserdata, "state.sqlite")}.`);
  }
}

export async function runRefresh(opts: RefreshOptions): Promise<SeedManifest> {
  const prodUserdata = prodUserdataDir();
  assertProdReadOnlyGuards(prodUserdata);

  // Bootstrap the registry tree BEFORE acquiring the lock — the mkdir lock lives
  // under the registry root, which must exist first.
  const paths = ensureRegistry();
  // The inert workspace sandbox every curated thread is redirected to. Create it
  // now (persistent, outside seed-versions so GC never touches it) so a test
  // instance's agent has a real, empty, non-prod dir to spawn in.
  const sandboxPath = curatedSandboxDir();
  mkdirSync(sandboxPath, { recursive: true, mode: 0o700 });
  const release = acquireSeedRefreshLock();
  try {
    const builtAtIso = new Date().toISOString();
    const builtAtLabel = builtAtIso.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");

    const buildDir = join(paths.seedVersions, `${builtAtLabel}.building.${process.pid}`);
    rmSync(buildDir, { recursive: true, force: true });
    const buildUserdata = join(buildDir, "userdata");
    mkdirSync(buildUserdata, { recursive: true, mode: 0o700 });

    const prodDbPath = join(prodUserdata, "state.sqlite");
    const workDbPath = join(buildUserdata, "state.sqlite");

    // 1. Safe snapshot (prod read-only, WAL-safe online backup).
    const sqliteLib = await snapshotProdDb(prodDbPath, workDbPath);

    // Everything below operates on the COPY only.
    const db = new DatabaseSync(workDbPath);
    let keptSets: KeptSets;
    let dbSchemaVersion: number;
    try {
      // 3. Schema-drift guard.
      dbSchemaVersion = scalar(
        db,
        "SELECT COALESCE(MAX(migration_id), 0) FROM effect_sql_migrations",
      );
      if (dbSchemaVersion > PRUNE_SCHEMA_VERSION) {
        throw new Error(
          `prod DB is at schema ${dbSchemaVersion}, prune list authored for ${PRUNE_SCHEMA_VERSION}; ` +
            "a newer migration may add a project/thread-keyed table this prune would orphan. " +
            "Update PRUNE_SCHEMA_VERSION + pruneCuratedDb() and re-run.",
        );
      }

      // 4. Select kept sets.
      keptSets = selectKeptSets(db, opts);

      // 5-7. Prune + strip + rename + neutralize workspace paths in one txn.
      db.exec("BEGIN");
      try {
        pruneCuratedDb(db, keptSets);
        stripSensitive(db);
        renameCuratedTitles(db);
        neutralizeWorkspacePaths(db, sandboxPath);
        rewriteCuratedEventPayloads(db, sandboxPath);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }

      // 8. Verify on the copy.
      verifyCuratedDb(db, sandboxPath);

      // 9. Compact: VACUUM INTO a fresh single file, then swap it into place.
      const finalDbPath = `${workDbPath}.final`;
      rmSync(finalDbPath, { force: true });
      db.exec(`VACUUM INTO '${finalDbPath.replace(/'/g, "''")}'`);
      db.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${workDbPath}${suffix}`, { force: true });
      }
      renameSync(finalDbPath, workDbPath);
    } catch (err) {
      try {
        db.close();
      } catch {
        // already closed
      }
      rmSync(buildDir, { recursive: true, force: true });
      throw err;
    }

    // 10. Copy settings / secrets / pruned attachments (prod read-only sources).
    for (const file of ["settings.json", "keybindings.json"]) {
      const src = join(prodUserdata, file);
      if (existsSync(src)) {
        cpSync(src, join(buildUserdata, file));
      }
    }
    const secretsSrc = join(prodUserdata, "secrets");
    if (existsSync(secretsSrc)) {
      cpSync(secretsSrc, join(buildUserdata, "secrets"), { recursive: true });
    }
    const attachmentsCopied = copyPrunedAttachments(
      join(prodUserdata, "attachments"),
      join(buildUserdata, "attachments"),
      keptSets.threadIds,
    );

    // 11. Manifest.
    const gitSha = (() => {
      const result = runCapture("git", ["-C", prodGitDir(), "rev-parse", "--short", "HEAD"]);
      return result.status === 0 ? result.stdout.trim() : "unknown";
    })();
    const keptProjects: SeedManifestKeptProject[] = keptSets.projects.map((p) => ({
      id: p.id,
      title: `${COPYOF_PREFIX}${p.title}`,
      threads: p.threadIds.length,
    }));
    const manifest: SeedManifest = {
      schemaVersion: SEED_MANIFEST_SCHEMA_VERSION,
      builtAt: builtAtIso,
      prodDir: prodGitDir(),
      prodGitSha: gitSha,
      dbSchemaVersion,
      pruneSchemaVersion: PRUNE_SCHEMA_VERSION,
      projects: keptSets.projects.length,
      threadsPerProject: opts.threads,
      keptProjects,
      keptThreadIds: keptSets.threadIds,
      prodDbBytes: statSync(prodDbPath).size,
      templateDbBytes: statSync(workDbPath).size,
      sqliteLib,
    };
    writeFileSync(join(buildDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });

    // fsync the build tree before publishing.
    fsyncPath(workDbPath);
    fsyncPath(buildUserdata);
    fsyncPath(buildDir);

    // 12. Atomic publish (rename building → versioned dir, then symlink swap).
    let versionDir = join(paths.seedVersions, builtAtLabel);
    if (existsSync(versionDir)) {
      versionDir = `${versionDir}.${process.pid}`;
    }
    renameSync(buildDir, versionDir);
    publishTemplate(versionDir);
    fsyncPath(paths.seedVersions);

    // GC: keep newest 2 version dirs (retention protects an in-flight cpSync).
    gcSeedVersions(versionDir);

    process.stdout.write(
      `[test-seed-refresh] published ${basename(versionDir)}\n` +
        `  template: ${paths.seedTemplate} -> seed-versions/${basename(versionDir)}\n` +
        `  projects: ${manifest.projects} (schema ${dbSchemaVersion}, sha ${gitSha})\n`,
    );
    for (const project of keptProjects) {
      process.stdout.write(`    ${project.title} — ${project.threads} thread(s)\n`);
    }
    const shrink =
      manifest.prodDbBytes > 0
        ? ` (${((manifest.templateDbBytes / manifest.prodDbBytes) * 100).toFixed(1)}% of prod)`
        : "";
    process.stdout.write(
      `  db: ${manifest.templateDbBytes} bytes${shrink}; prod: ${manifest.prodDbBytes} bytes\n` +
        `  attachments copied: ${attachmentsCopied}; sqlite: ${sqliteLib}\n` +
        `  builtAt: ${builtAtIso}\n`,
    );
    if (manifest.projects === 0) {
      process.stdout.write(
        "[test-seed-refresh] WARNING: prod has no live projects; built an empty-but-migrated template.\n",
      );
    }
    return manifest;
  } finally {
    release();
  }
}

async function main(): Promise<void> {
  const opts = parseRefreshArgs(process.argv.slice(2));
  await runRefresh(opts);
}

// sha256File is exported for the validation transcript / potential callers.
export { sha256File };

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`[test-seed-refresh] FAILED: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
