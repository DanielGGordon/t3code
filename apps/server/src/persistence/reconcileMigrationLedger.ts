/**
 * Name-aware repair of the `effect_sql_migrations` ledger, run before the Migrator on every startup.
 * Effect's Migrator is ordinal and never compares names, but this fork owns id 33 and shifts upstream's
 * ids >= 33 up by one, so a stock-numbered ledger would silently skip migrations. Renumbers by name in
 * one transaction, runs gap migrations, and fails on unknown names; see UPSTREAM_DIVERGENCE.md (2026-10-06).
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

export type CanonicalMigration<E = never> = readonly [
  id: number,
  name: string,
  migration: Effect.Effect<unknown, E, SqlClient.SqlClient>,
];

interface LedgerRow {
  readonly migration_id: number;
  readonly name: string;
}

interface LedgerPlan<E> {
  /** Known rows recorded under a different id than this build's. */
  readonly renumber: ReadonlyArray<{
    readonly from: number;
    readonly to: number;
    readonly name: string;
  }>;
  /** Canonical migrations missing from the ledger at or below its (renumbered) max id. */
  readonly gaps: ReadonlyArray<CanonicalMigration<E>>;
}

const badState = (message: string) => new Migrator.MigrationError({ kind: "BadState", message });

const planLedger = Effect.fn("reconcileMigrationLedger.planLedger")(function* <E>(
  canonical: ReadonlyArray<CanonicalMigration<E>>,
  rows: ReadonlyArray<LedgerRow>,
) {
  const idByName = new Map(canonical.map(([id, name]) => [name, id] as const));
  const lastCanonicalId = Math.max(0, ...canonical.map(([id]) => id));

  const seenNames = new Set<string>();
  const duplicates = rows.filter((row) => {
    const duplicate = seenNames.has(row.name);
    seenNames.add(row.name);
    return duplicate;
  });
  if (duplicates.length > 0) {
    return yield* badState(
      `Migration ledger records the same migration name under several ids (${duplicates
        .map((row) => `${row.migration_id}:${row.name}`)
        .join(", ")}); cannot reconcile it by name. Inspect effect_sql_migrations by hand.`,
    );
  }

  const unknown = rows.filter((row) => !idByName.has(row.name));
  const renumber = rows.flatMap((row) => {
    const to = idByName.get(row.name);
    return to === undefined || to === row.migration_id
      ? []
      : [{ from: row.migration_id, to, name: row.name }];
  });

  const beyondBuild = unknown.filter((row) => row.migration_id > lastCanonicalId);
  if (beyondBuild.length > 0 || (renumber.length > 0 && unknown.length > 0)) {
    const offending = beyondBuild.length > 0 ? beyondBuild : unknown;
    return yield* badState(
      `Database migration ledger contains migrations unknown to this build (${offending
        .map((row) => `${row.migration_id}:${row.name}`)
        .join(", ")}). It was migrated by a newer or foreign T3 Code build; refusing to ` +
        `reconcile it by name. Run a build that knows these migrations, or restore a ` +
        `database written by this fork.`,
    );
  }

  // Ids after renumbering; unknown (site-local) rows keep consuming their id.
  const recordedIds = new Set(rows.map((row) => idByName.get(row.name) ?? row.migration_id));
  const maxRecordedId = Math.max(0, ...recordedIds);
  const gaps = canonical
    .filter(([id]) => id <= maxRecordedId && !recordedIds.has(id))
    .sort(([a], [b]) => a - b);
  return { renumber, gaps } satisfies LedgerPlan<E>;
});

const ledgerExists = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  return tables.length > 0;
});

const readLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<LedgerRow>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
});

/**
 * Reconcile the migration ledger by name against `canonical` (this build's
 * `migrationEntries`). Returns the gap migrations it ran, as `[id, name]`.
 */
export const reconcileMigrationLedger = Effect.fn("reconcileMigrationLedger")(function* <E>(
  canonical: ReadonlyArray<CanonicalMigration<E>>,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* ledgerExists)) return [];

  // Cheap read-only check first; only a divergent ledger takes the write lock.
  const preview = yield* planLedger(canonical, yield* readLedger);
  if (preview.renumber.length === 0 && preview.gaps.length === 0) return [];

  const { renumber, gaps } = yield* sql.withTransaction(
    Effect.gen(function* () {
      // Re-plan under the write lock: another process may have reconciled already.
      const plan = yield* planLedger(canonical, yield* readLedger);

      // Two-phase renumber through negative ids so no step collides on the key.
      for (const { from, to } of plan.renumber) {
        yield* sql`UPDATE effect_sql_migrations SET migration_id = ${-to} WHERE migration_id = ${from}`;
      }
      yield* sql`UPDATE effect_sql_migrations SET migration_id = -migration_id WHERE migration_id < 0`;

      for (const [id, name, migration] of plan.gaps) {
        yield* migration.pipe(
          Effect.mapError(
            (cause) =>
              new Migrator.MigrationError({
                cause,
                kind: "Failed",
                message: `Gap migration "${id}_${name}" failed while reconciling the migration ledger by name`,
              }),
          ),
          Effect.withSpan(`reconcileMigrationLedger gap ${id}_${name}`),
        );
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
      }
      return plan;
    }),
  );

  if (renumber.length > 0 || gaps.length > 0) {
    yield* Effect.logWarning("Migration ledger reconciled by name").pipe(
      Effect.annotateLogs({
        renumbered: renumber.map(({ from, to, name }) => `${from}->${to}:${name}`),
        gapMigrationsRun: gaps.map(([id, name]) => `${id}_${name}`),
      }),
    );
  }
  return gaps.map(([id, name]) => [id, name] as const);
});
