import { FileFinder } from "@ff-labs/fff-node";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { vi } from "vite-plus/test";

import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

it.effect("preserves unexpected FileFinder creation failures", () =>
  Effect.gen(function* () {
    const cause = new Error("native initialization failed");
    vi.spyOn(FileFinder, "create").mockImplementationOnce(() => {
      throw cause;
    });

    const error = yield* Effect.flip(
      Effect.scoped(WorkspaceSearchIndex.make("/workspace/project")),
    );

    expect(error).toMatchObject({
      _tag: "WorkspaceSearchIndexCreateFailed",
      cwd: "/workspace/project",
      reason: "FileFinder.create threw unexpectedly.",
      cause,
    });
  }),
);

it.effect("keeps returned FileFinder creation diagnostics out of the cause chain", () =>
  Effect.gen(function* () {
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({
      ok: false,
      error: "native index rejected the directory",
    });

    const error = yield* Effect.flip(
      Effect.scoped(WorkspaceSearchIndex.make("/workspace/project")),
    );

    expect(error).toMatchObject({
      _tag: "WorkspaceSearchIndexCreateFailed",
      cwd: "/workspace/project",
      reason: "native index rejected the directory",
    });
    expect(error.cause).toBeUndefined();
  }),
);

it.effect("preserves FileFinder destroy failures as structured defects", () =>
  Effect.gen(function* () {
    const cause = new Error("native destroy failed");
    const finder = {
      destroy: vi.fn(() => {
        throw cause;
      }),
      isScanning: vi.fn(() => false),
    } as unknown as FileFinder;
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

    const exit = yield* Effect.scoped(WorkspaceSearchIndex.make("/workspace/project")).pipe(
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(WorkspaceSearchIndex.WorkspaceSearchIndexDestroyFailed);
      expect(error).toMatchObject({
        _tag: "WorkspaceSearchIndexDestroyFailed",
        cwd: "/workspace/project",
        cause,
      });
    }
  }),
);

it.effect("preserves search and refresh failures with operation context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const searchCause = new Error("native search failed");
      const refreshCause = new Error("native scan failed");
      const finder = {
        destroy: vi.fn(),
        isScanning: vi.fn(() => false),
        mixedSearch: vi.fn(() => {
          throw searchCause;
        }),
        scanFiles: vi.fn(() => {
          throw refreshCause;
        }),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project");
      const query = "authorization: Bearer secret-token";
      const searchError = yield* Effect.flip(searchIndex.search(query, 3));
      const refreshError = yield* Effect.flip(searchIndex.refresh());

      expect(searchError).toMatchObject({
        _tag: "WorkspaceSearchIndexSearchFailed",
        cwd: "/workspace/project",
        queryLength: query.length,
        pageSize: 4,
        reason: "FileFinder.mixedSearch threw unexpectedly.",
        cause: searchCause,
      });
      expect(searchError).not.toHaveProperty("query");
      expect(searchError.message).not.toMatch(/Bearer|secret-token/);
      expect(refreshError).toMatchObject({
        _tag: "WorkspaceSearchIndexRefreshFailed",
        cwd: "/workspace/project",
        reason: "FileFinder.scanFiles threw unexpectedly.",
        cause: refreshCause,
      });
    }),
  ),
);

it.effect("keeps returned search diagnostics out of the cause chain", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const finder = {
        destroy: vi.fn(),
        isScanning: vi.fn(() => false),
        mixedSearch: vi.fn(() => ({ ok: false, error: "native query rejected" })),
        scanFiles: vi.fn(() => ({ ok: false, error: "native refresh rejected" })),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project");
      const query = "authorization: Bearer secret-token";
      const searchError = yield* Effect.flip(searchIndex.search(query, 3));
      const refreshError = yield* Effect.flip(searchIndex.refresh());

      expect(searchError).toMatchObject({
        _tag: "WorkspaceSearchIndexSearchFailed",
        cwd: "/workspace/project",
        queryLength: query.length,
        pageSize: 4,
        reason: "native query rejected",
      });
      expect(searchError).not.toHaveProperty("query");
      expect(searchError.message).not.toMatch(/Bearer|secret-token/);
      expect(searchError.cause).toBeUndefined();
      expect(refreshError).toMatchObject({
        _tag: "WorkspaceSearchIndexRefreshFailed",
        cwd: "/workspace/project",
        reason: "native refresh rejected",
      });
      expect(refreshError.cause).toBeUndefined();
    }),
  ),
);

it.effect("walks dot-directories without descending into .git", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* Effect.acquireRelease(
        Effect.tryPromise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-dotfiles-"))),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(cwd, ".github", "workflows"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(cwd, ".git"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(cwd, ".github", "workflows", "ci.yml"), "name: CI");
        await NodeFSP.writeFile(NodePath.join(cwd, ".git", "config"), "secret");
        await NodeFSP.writeFile(NodePath.join(cwd, ".env"), "TOKEN=test");
      });
      const finder = {
        destroy: vi.fn(),
        isScanning: vi.fn(() => false),
        mixedSearch: vi.fn(() => ({
          ok: true,
          value: { items: [], totalMatched: 0 },
        })),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
      const result = yield* searchIndex.list(true);

      expect(result.entries).toEqual([
        { path: ".env", kind: "file" },
        { path: ".github", kind: "directory" },
        { path: ".github/workflows", kind: "directory" },
        { path: ".github/workflows/ci.yml", kind: "file" },
      ]);
      expect(result.truncated).toBe(false);
    }),
  ),
);

it.effect("surfaces dotfiles even when the native results already fill the entry cap", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* Effect.acquireRelease(
        Effect.tryPromise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-dotfiles-cap-"))),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(cwd, ".env"), "TOKEN=test"));

      // Simulate a tree (e.g. the home directory) whose gitignore-filtered
      // native scan alone reaches the entry cap. Before dotfiles were given
      // priority, this starved dotfile discovery so `.env` never appeared.
      const nativeItems = Array.from(
        { length: WorkspaceSearchIndex.WORKSPACE_INDEX_MAX_ENTRIES },
        (_, index) => ({ type: "file", item: { relativePath: `native-${index}.txt` } }),
      );
      const finder = {
        destroy: vi.fn(),
        isScanning: vi.fn(() => false),
        mixedSearch: vi.fn(() => ({
          ok: true,
          value: { items: nativeItems, totalMatched: nativeItems.length },
        })),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
      const result = yield* searchIndex.list(true);

      expect(result.entries).toContainEqual({ path: ".env", kind: "file" });
      expect(result.entries.length).toBeLessThanOrEqual(
        WorkspaceSearchIndex.WORKSPACE_INDEX_MAX_ENTRIES,
      );
      expect(result.truncated).toBe(true);
    }),
  ),
);
