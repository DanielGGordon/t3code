import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";

const freshDatabase = () => NodeSqliteClient.layer({ filename: ":memory:" });

/**
 * Guards the fork's migration-id offset against the production database.
 *
 * This fork owns id 33 (`ProjectionThreadRestartRequest`); it has been recorded
 * in production's `effect_sql_migrations` since 2026-07-09. Every upstream
 * migration with id >= 33 therefore runs one id higher here: upstream's
 * settled/snoozed pair as 34/35 (2026-07 sync) and upstream 35..58 as 36..59
 * (2026-10 sync, incl. OrchestrationV2 at 56).
 *
 * This matters because Effect's Migrator run loop is purely ordinal —
 * `if (currentId <= latestMigrationId) continue` — with no name or checksum
 * comparison. Had the fork's migration been renumbered upward instead, an
 * upstream migration reusing an already-recorded id would be silently skipped
 * on production, its schema would never be created, and every query touching
 * it would fail.
 *
 * A fresh-database test cannot catch that: it runs every migration from zero.
 * The regression only reproduces when the ledger already carries a high-water
 * mark, which is exactly the state of the production database.
 */
describe("034_035 fork migration offset", () => {
  it.effect("applies the settled and snoozed migrations over a ledger already at 33", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Reproduce production as of 2026-07: the fork's own migration is the max.
      yield* runMigrations({ toMigrationInclusive: 33 });

      const beforeMax = yield* sql<{ readonly max_id: number }>`
        SELECT MAX(migration_id) AS max_id FROM effect_sql_migrations
      `;
      assert.strictEqual(beforeMax[0]?.max_id, 33);

      yield* runMigrations();

      const tail = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id IN (33, 34, 35)
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(tail, [
        { migration_id: 33, name: "ProjectionThreadRestartRequest" },
        { migration_id: 34, name: "ProjectionThreadsSettled" },
        { migration_id: 35, name: "ProjectionThreadsSnoozed" },
      ]);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const names = new Set(columns.map((column) => column.name));
      for (const required of [
        "requesting_restart",
        "restart_request_reason",
        "settled_override",
        "settled_at",
        "snoozed_until",
        "snoozed_at",
      ]) {
        assert.isTrue(names.has(required), `projection_threads is missing ${required}`);
      }
    }).pipe(Effect.provide(freshDatabase())),
  );

  it.effect("applies every upstream migration from 35 on over a ledger already at 35", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Reproduce production as of 2026-10: ledger max is the fork's 35 (Snoozed).
      yield* runMigrations({ toMigrationInclusive: 35 });
      const beforeMax = yield* sql<{ readonly max_id: number }>`
        SELECT MAX(migration_id) AS max_id FROM effect_sql_migrations
      `;
      assert.strictEqual(beforeMax[0]?.max_id, 35);

      const executed = yield* runMigrations();
      // Every upstream migration from upstream-35 (TitleRegeneration) on runs,
      // none is skipped, and the ids are contiguous 36..59.
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        Array.from({ length: 59 - 35 }, (_, index) => 36 + index),
      );
      assert.deepStrictEqual(executed[0], [36, "ProjectionThreadTitleRegeneration"]);
      assert.deepStrictEqual(
        executed.find(([, name]) => name === "OrchestrationV2"),
        [56, "OrchestrationV2"],
      );
      assert.deepStrictEqual(executed.at(-1), [59, "WebhookRelayDeliveries"]);
      assert.deepStrictEqual(yield* runMigrations(), []);

      // The recorded ledger equals this build's manifest (no divergence warning).
      const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        recorded.map((row) => [row.migration_id, row.name] as const),
        migrationEntries.map(([id, name]) => [id, name] as const),
      );

      // Schema from both ends of the shifted range exists.
      const threadColumns = new Set(
        (yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`).map(
          (column) => column.name,
        ),
      );
      for (const required of ["title_regeneration_request_id", "auto_settle_disabled_at"]) {
        assert.isTrue(threadColumns.has(required), `projection_threads is missing ${required}`);
      }
      const v2Tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('orchestration_v2_events', 'scheduled_tasks')
        ORDER BY name
      `;
      assert.deepStrictEqual(
        v2Tables.map(({ name }) => name),
        ["orchestration_v2_events", "scheduled_tasks"],
      );
    }).pipe(Effect.provide(freshDatabase())),
  );

  it.effect("keeps the fork's 033 below every upstream id", () =>
    Effect.sync(() => {
      const ids = migrationEntries.map(([id]) => id);
      assert.deepStrictEqual(
        ids,
        Array.from({ length: ids.length }, (_, index) => index + 1),
      );
      assert.deepStrictEqual(migrationEntries.find(([id]) => id === 33)?.slice(0, 2), [
        33,
        "ProjectionThreadRestartRequest",
      ]);
    }),
  );
});
