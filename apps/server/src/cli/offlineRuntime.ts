import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

/**
 * Offline runtime for CLI subcommands that operate directly on the T3 state
 * database without a running server (`t3 import`, `t3 session`). Mirrors
 * `ProjectCliRuntimeLive` (orchestration engine + projection snapshot + sqlite
 * + workspace paths) and additionally provides the provider session directory
 * (resume bindings) and server settings (provider instance resolution).
 * `FileSystem`, `Path`, and `Crypto` are satisfied by the ambient CLI runtime
 * layer (NodeServices) provided in `bin.ts`. Callers still supply
 * `ServerConfig` and `MinimumLogLevel`.
 *
 * SQLite runs in WAL mode, so these commands are safe to run while the server
 * is serving; the server re-reads resume bindings from the database on every
 * session start.
 */
export const OfflineCliRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer)),
  ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntimeRepositoryLive)),
  OrchestrationLayerLive,
).pipe(
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceLayerLive),
);
