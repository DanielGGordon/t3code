import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

/**
 * Guards the fork's migration-id offset against the production database.
 *
 * Upstream shipped its settled/snoozed migrations as 033/034. This fork already
 * owns id 33 (`ProjectionThreadRestartRequest`) and it has been recorded in
 * production's `effect_sql_migrations` since 2026-07-09, so upstream's pair is
 * renumbered locally to 034/035.
 *
 * This matters because Effect's Migrator run loop is purely ordinal —
 * `if (currentId <= latestMigrationId) continue` — with no name or checksum
 * comparison. Had the fork's migration been renumbered upward instead, an
 * upstream migration reusing id 33 would be silently skipped on any database
 * that already recorded 33, the settled columns would never be created, and
 * every thread read and write would fail with `no such column`.
 *
 * A fresh-database test cannot catch that: it runs every migration from zero.
 * The regression only reproduces when the ledger already carries a high-water
 * mark, which is exactly the state of the production database.
 */
layer("034_035 fork migration offset", (it) => {
  it.effect("applies the settled and snoozed migrations over a ledger already at 33", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Reproduce production: the fork's own migration is the recorded maximum.
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

      // The columns the auto-merged projection queries reference unconditionally.
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
    }),
  );
});
