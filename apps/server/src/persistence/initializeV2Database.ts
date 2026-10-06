import * as NodeSqlite from "node:sqlite";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class V2DatabaseImportError extends Schema.TaggedError<V2DatabaseImportError>()(
  "V2DatabaseImportError",
  { sourcePath: Schema.String, destinationPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not copy the V1 database at ${this.sourcePath} to ${this.destinationPath}. The V1 database has not been migrated.`;
  }
}

export class V2DatabaseNotInitializedError extends Schema.TaggedError<V2DatabaseNotInitializedError>()(
  "V2DatabaseNotInitializedError",
  { sourcePath: Schema.String, destinationPath: Schema.String },
) {
  override get message() {
    return (
      `The v2 database is not initialized yet: ${this.destinationPath} does not exist, but the ` +
      `legacy database ${this.sourcePath} does. Start the T3 Code server once (\`t3 serve\`) to ` +
      `migrate, then re-run this command. Nothing was written.`
    );
  }
}

/**
 * Whether this process may snapshot the legacy state.sqlite into statev2.sqlite.
 *
 * The snapshot is one-shot: once statev2.sqlite exists it is never re-seeded. If
 * a short-lived CLI process (e.g. the 15-minute `t3 import sync` timer running
 * from a freshly checked-out but not-yet-restarted deploy) took it while the old
 * server was still writing state.sqlite, every write after the snapshot would be
 * silently lost when the new server starts. So only the long-running server
 * (`runServer`) seeds; everything else defaults to refusing.
 */
export type V2DatabaseSeedPolicyValue = "seed-from-legacy" | "refuse-legacy-seed";

export class V2DatabaseSeedPolicy extends Context.Reference<V2DatabaseSeedPolicyValue>(
  "t3/persistence/V2DatabaseSeedPolicy",
  { defaultValue: () => "refuse-legacy-seed" },
) {}

/** Marks an effect as the long-running server, the only entrypoint allowed to seed V2. */
export const allowLegacySeed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, V2DatabaseSeedPolicy, "seed-from-legacy");

/** Seed V2 once. Its copied legacy tables remain the source for lazy transcript import. */
export const initializeV2Database = Effect.fn("initializeV2Database")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const policy = yield* V2DatabaseSeedPolicy;
  const directory = path.dirname(destinationPath);
  const sourcePath = path.join(directory, "state.sqlite");
  yield* Effect.gen(function* () {
    if (yield* fs.exists(destinationPath)) return;
    if (!(yield* fs.exists(sourcePath))) return;
    if (policy !== "seed-from-legacy") {
      return yield* new V2DatabaseNotInitializedError({ sourcePath, destinationPath });
    }
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: ".v2-import-",
    });
    const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
    yield* Effect.tryPromise(async () => {
      const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
      try {
        await NodeSqlite.backup(database, snapshotPath);
      } finally {
        database.close();
      }
    });
    // Publish only a complete snapshot, without replacing an existing V2 database.
    yield* fs
      .link(snapshotPath, destinationPath)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
        ),
      );
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) =>
      cause._tag === "V2DatabaseNotInitializedError"
        ? cause
        : new V2DatabaseImportError({ sourcePath, destinationPath, cause }),
    ),
  );
});
