import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { observeResize } from "../lib/observeResize";
import { MIN_TILE_HEIGHT_PX, computeTileGrid, selectTileWallThreads } from "../lib/tileWall";
import { useDelegatedUnderParent, useProject, useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { closeTileWall } from "../tileWallStore";
import { toastManager } from "./ui/toast";
import ChatView from "./ChatView";
import { ComposerHandleContext } from "../composerHandleContext";
import { BackgroundThreadContext } from "./chat/backgroundThread";
import { resolveThreadStatusPill } from "./Sidebar.logic";

function TileWallTile({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const navigate = useNavigate();
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const project = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
  const status = resolveThreadStatusPill({ thread });

  const openThread = () => {
    closeTileWall();
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  };
  // The tile has no diff panel or terminal drawer; the full thread does.
  const parentPanel = {
    openToolDiff: openThread,
    runShellCommand: () =>
      toastManager.add({
        type: "info",
        title: "Open the thread to run shell commands",
        description: "Click the tile title to leave the wall and open this thread.",
      }),
  };

  return (
    <section
      data-side-chat-pane
      data-tile-wall-tile
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-background focus-within:border-ring"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        {status ? (
          <span
            role="img"
            aria-label={status.label}
            className={`size-2 shrink-0 rounded-full ${status.dotClass}`}
          />
        ) : null}
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline"
          onClick={openThread}
        >
          {thread.title}
        </button>
        {project ? (
          <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
            {project.title}
          </span>
        ) : null}
      </header>
      <BackgroundThreadContext value>
        <ComposerHandleContext value={null}>
          <ChatView
            environmentId={thread.environmentId}
            threadId={thread.id}
            routeKind="server"
            embedded={parentPanel}
          />
        </ComposerHandleContext>
      </BackgroundThreadContext>
    </section>
  );
}

/**
 * Every unsettled thread as a live chat tile filling the window; toggled by `view.tiles.toggle`.
 * Tiles stay mounted, so a half-typed message waits in its composer while you work in another.
 */
export function TileWall() {
  const threads = useThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const tiles = selectTileWallThreads({ threads, delegatedUnderParent });
  const [gridElement, setGridElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the wall's measured size into state so the grid shape follows the window
  useEffect(() => {
    if (!gridElement) return;
    const read = () =>
      setSize({ width: gridElement.clientWidth, height: gridElement.clientHeight });
    read();
    return observeResize(gridElement, read);
  }, [gridElement]);

  const { columns, rows } = computeTileGrid(tiles.length, size.width, size.height);
  return (
    <div
      data-tile-wall
      className="fixed inset-0 z-50 flex bg-background p-1.5"
      role="region"
      aria-label="Thread tile wall"
    >
      <div
        ref={setGridElement}
        className="grid min-h-0 min-w-0 flex-1 gap-1.5 overflow-y-auto"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridAutoRows: `minmax(${MIN_TILE_HEIGHT_PX}px, calc((100% - ${(rows - 1) * 6}px) / ${rows}))`,
        }}
      >
        {tiles.length === 0 ? (
          <p className="col-span-full self-center text-center text-sm text-muted-foreground">
            No active threads. Press the shortcut again to leave the tile wall.
          </p>
        ) : (
          tiles.map((thread) => (
            <TileWallTile key={`${thread.environmentId}:${thread.id}`} thread={thread} />
          ))
        )}
      </div>
    </div>
  );
}
