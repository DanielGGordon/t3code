import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";
import { reconcileMigrationLedger } from "./reconcileMigrationLedger.ts";

const freshDatabase = () => NodeSqliteClient.layer({ filename: ":memory:" });

/**
 * Production's `effect_sql_migrations` above the fork's 35 as read on
 * 2026-10-06: written under STOCK upstream numbering, so upstream's
 * `ProjectionThreadTitleRegeneration` (upstream 35) was skipped.
 */
const PROD_LEDGER_ABOVE_35 = [
  [36, "ProjectionThreadsPinned"],
  [37, "ProjectionTurnsKeysetIndex"],
  [38, "ProjectionThreadsPinOrderKey"],
  [39, "ProjectionProjectsDefaultThreadEnvMode"],
  [40, "ProjectionProjectFaviconPath"],
  [41, "AuthSessionClientConnection"],
  [42, "ProjectionThreadLinkedPullRequest"],
  [43, "ProjectionThreadsUnsettledAt"],
  [44, "ClearAutomaticProjectModelDefaults"],
  [45, "ProjectionProjectsAutoPull"],
  [46, "RepairAutomaticSettlementTimestamps"],
  [47, "ProjectionProjectIcon"],
  [48, "ProjectionThreadBranchPullRequest"],
  [49, "ProjectionThreadsActiveOrderKey"],
  [50, "ProjectionThreadPullRequests"],
  [51, "ProjectionThreadMessageContext"],
  [52, "ProjectionThreadTitleState"],
  [53, "PullRequestFilesViewed"],
  [54, "ProjectionThreadsAutoSettleDisabledAt"],
] as const;

/** Run this build's migration of `name` and record it under a foreign `id`. */
const recordUnder = (id: number, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const entry = migrationEntries.find(([, entryName]) => entryName === name);
    assert.isDefined(entry, `no migration named ${name}`);
    yield* entry![2];
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
  });

/** Exactly production's state: fork 1..35, then upstream-numbered 36..54. */
const seedProductionLedger = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 35 });
  for (const [id, name] of PROD_LEDGER_ABOVE_35) yield* recordUnder(id, name);
});

const readLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const columnsOf = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info(${table})
    `;
    return new Set(columns.map((column) => column.name));
  });

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const captureLogs = (logs: CapturedLog[]) =>
  Effect.provideService(
    Logger.CurrentLoggers,
    new Set([
      Logger.make(({ fiber, message }) => {
        logs.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) });
      }),
    ]),
  );

describe("reconcileMigrationLedger", () => {
  it.effect("repairs production's stock-numbered ledger and runs the skipped migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedProductionLedger;
      yield* sql`
        UPDATE effect_sql_migrations SET created_at = '2026-09-10 00:00:00' WHERE migration_id = 36
      `;
      assert.isFalse((yield* columnsOf("projection_threads")).has("title_regeneration_request_id"));

      const logs: CapturedLog[] = [];
      const executed = yield* runMigrations().pipe(captureLogs(logs));

      assert.deepStrictEqual(executed, [
        [36, "ProjectionThreadTitleRegeneration"],
        [56, "OrchestrationV2"],
        [57, "RemoveRedundantProjectionIndexes"],
        [58, "ScheduledTaskWebhooks"],
        [59, "WebhookRelayDeliveries"],
      ]);
      assert.deepStrictEqual(yield* readLedger, migrationManifest);

      const threadColumns = yield* columnsOf("projection_threads");
      for (const column of [
        "title_regeneration_request_id",
        "title_regeneration_started_at",
        "requesting_restart",
        "auto_settle_disabled_at",
      ]) {
        assert.isTrue(threadColumns.has(column), `projection_threads is missing ${column}`);
      }
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_events'`,
        [{ name: "orchestration_v2_events" }],
      );
      // Renumbered rows keep their original timestamp.
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE name = 'ProjectionThreadsPinned'`,
        [{ created_at: "2026-09-10 00:00:00" }],
      );

      const reconciled = logs.find((log) =>
        String(log.message).includes("Migration ledger reconciled by name"),
      );
      assert.deepStrictEqual(reconciled?.annotations.gapMigrationsRun, [
        "36_ProjectionThreadTitleRegeneration",
      ]);
      assert.deepStrictEqual(
        reconciled?.annotations.renumbered,
        PROD_LEDGER_ABOVE_35.map(([id, name]) => `${id}->${id + 1}:${name}`),
      );
      assert.isUndefined(
        logs.find((log) => String(log.message).includes("migration history diverges")),
      );

      // A second boot is a no-op.
      assert.deepStrictEqual(yield* reconcileMigrationLedger(migrationEntries), []);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* readLedger, migrationManifest);
    }).pipe(Effect.provide(freshDatabase())),
  );

  it.effect("adopts a stock-created database and runs the fork's 033", () =>
    Effect.gen(function* () {
      // Stock upstream numbering through upstream 054: 33 = ProjectionThreadsSettled.
      yield* runMigrations({ toMigrationInclusive: 32 });
      for (const [ourId, name] of migrationEntries.filter(([id]) => id >= 34 && id <= 55)) {
        yield* recordUnder(ourId - 1, name);
      }
      assert.isFalse((yield* columnsOf("projection_threads")).has("requesting_restart"));

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed[0], [33, "ProjectionThreadRestartRequest"]);
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        [33, 56, 57, 58, 59],
      );
      assert.deepStrictEqual(yield* readLedger, migrationManifest);
      const threadColumns = yield* columnsOf("projection_threads");
      assert.isTrue(threadColumns.has("requesting_restart"));
      assert.isTrue(threadColumns.has("restart_request_reason"));
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(freshDatabase())),
  );

  it.effect("is a read-only no-op on a canonical fork ledger", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 35 });
      assert.deepStrictEqual(yield* reconcileMigrationLedger(migrationEntries), []);
      assert.deepStrictEqual(
        yield* readLedger,
        migrationManifest.filter(([id]) => id <= 35),
      );
    }).pipe(Effect.provide(freshDatabase())),
  );

  it.effect("is a no-op before the ledger table exists", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* reconcileMigrationLedger(migrationEntries), []);
    }).pipe(Effect.provide(freshDatabase())),
  );

  it.effect.each([
    ["beyond this build", 60, "SomeFutureMigration"],
    ["alongside a ledger that needs renumbering", 55, "SomeForeignMigration"],
  ] as const)("refuses an unknown migration %s without writing", ([, id, name]) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedProductionLedger;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), `${id}:${name}`);
      assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "newer or foreign");

      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        before,
      );
      assert.isFalse((yield* columnsOf("projection_threads")).has("title_regeneration_request_id"));
    }).pipe(Effect.provide(freshDatabase())),
  );

  it.effect("rolls back renumbering when a gap migration fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedProductionLedger;
      yield* sql`
        CREATE TRIGGER fail_gap BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.name = 'ProjectionThreadTitleRegeneration'
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;
      const before = yield* readLedger;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* readLedger, before);
      assert.isFalse((yield* columnsOf("projection_threads")).has("title_regeneration_request_id"));

      yield* sql`DROP TRIGGER fail_gap`;
      yield* runMigrations();
      assert.deepStrictEqual(yield* readLedger, migrationManifest);
    }).pipe(Effect.provide(freshDatabase())),
  );
});
