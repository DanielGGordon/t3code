import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { cn } from "../lib/utils";
import { observeResize } from "../lib/observeResize";
import {
  MIN_TILE_HEIGHT_PX,
  computeTileGrid,
  resolveTileState,
  selectTileWallThreads,
  type TileState,
} from "../lib/tileWall";
import { useDelegatedUnderParent, useProject, useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { closeTileWall } from "../tileWallStore";
import { toastManager } from "./ui/toast";
import ChatView from "./ChatView";
import { ComposerHandleContext } from "../composerHandleContext";
import { BackgroundThreadContext } from "./chat/backgroundThread";

// Theme tokens, not palette colors, so Solarized and every custom theme supply their own hues.
const TILE_STATE_STYLES: Record<
  TileState,
  { readonly label: string; readonly frame: string; readonly header: string }
> = {
  waiting: {
    label: "Waiting on you",
    frame: "border-tile-waiting",
    header: "bg-tile-waiting text-background",
  },
  running: { label: "Running", frame: "border-info", header: "bg-info text-background" },
  done: { label: "Done", frame: "border-success", header: "bg-success text-background" },
  failed: {
    label: "Failed",
    frame: "border-destructive",
    header: "bg-destructive text-background",
  },
  idle: { label: "New", frame: "border-border", header: "bg-muted text-foreground" },
};

function TileWallTile({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const navigate = useNavigate();
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const project = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
  const stateKey = resolveTileState(thread);
  const state = TILE_STATE_STYLES[stateKey];

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
      data-tile-state={stateKey}
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border-2 bg-background focus-within:ring-2 focus-within:ring-inset focus-within:ring-foreground/30",
        state.frame,
      )}
    >
      <header className={cn("flex h-9 shrink-0 items-center gap-2 px-3", state.header)}>
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm font-semibold hover:underline"
          onClick={openThread}
        >
          {thread.title}
        </button>
        {project ? (
          <span className="max-w-[30%] shrink-0 truncate text-xs opacity-75">{project.title}</span>
        ) : null}
        <span className="shrink-0 rounded-sm bg-background/25 px-1.5 py-0.5 text-2xs font-bold tracking-wide uppercase">
          {state.label}
        </span>
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
