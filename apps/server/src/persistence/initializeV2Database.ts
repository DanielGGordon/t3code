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
 * The legacy snapshot is one-shot. A CLI process (e.g. the `t3 import sync` timer) taking it
 * while the old server still writes state.sqlite would silently lose every later write, so
 * only the long-running server (`runServer`) seeds; everything else refuses.
 */
export type V2DatabaseSeedPolicyValue = "seed-from-legacy" | "refuse-legacy-seed";

export class V2DatabaseSeedPolicy extends Context.Reference<V2DatabaseSeedPolicyValue>(
  "t3/persistence/V2DatabaseSeedPolicy",
  { defaultValue: () => "refuse-legacy-seed" },
) {}

/** Marks an effect as the long-running server, the only entrypoint allowed to seed V2. */
export const allowLegacySeed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, V2DatabaseSeedPolicy, "seed-from-legacy");

const isV2DatabaseImportError = Schema.is(V2DatabaseImportError);

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

// Legacy names have no PID; newer copies stay while their process is alive.
const removeAbandonedCopies = Effect.fn("removeAbandonedCopies")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed([]),
    ),
  );
  for (const entry of entries) {
    const copy = /^\.v2-import-(?:(\d+)-)?[A-Za-z0-9]{6}$/.exec(entry);
    if (copy === null || (copy[1] !== undefined && isProcessAlive(Number(copy[1])))) continue;
    yield* fs.remove(path.join(directory, entry), { recursive: true });
  }
});

/** Seed V2 once. Its copied legacy tables remain the source for lazy transcript import. */
export const initializeV2Database = Effect.fn("initializeV2Database")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const policy = yield* V2DatabaseSeedPolicy;
  const directory = path.dirname(destinationPath);
  const sourcePath = path.join(directory, "state.sqlite");
  yield* removeAbandonedCopies(directory).pipe(Effect.ignore({ log: true }));
  yield* Effect.gen(function* () {
    if (yield* fs.exists(destinationPath)) return;
    if (!(yield* fs.exists(sourcePath))) return;
    if (policy !== "seed-from-legacy") {
      return yield* new V2DatabaseNotInitializedError({ sourcePath, destinationPath });
    }
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: `.v2-import-${process.pid}-`,
    });
    const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
    yield* Effect.tryPromise({
      try: async () => {
        const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
        try {
          await NodeSqlite.backup(database, snapshotPath);
        } finally {
          database.close();
        }
      },
      catch: (cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause }),
    });
    // Publish only a complete snapshot, without replacing an existing V2 database.
    yield* fs.link(snapshotPath, destinationPath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        (_error) => Effect.void,
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) =>
      cause._tag === "V2DatabaseNotInitializedError" || isV2DatabaseImportError(cause)
        ? cause
        : new V2DatabaseImportError({ sourcePath, destinationPath, cause }),
    ),
  );
});
