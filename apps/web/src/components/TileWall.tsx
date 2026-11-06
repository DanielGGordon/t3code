import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, LayoutGridIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { useThreadActions } from "../hooks/useThreadActions";
import { cn } from "../lib/utils";
import { observeResize } from "../lib/observeResize";
import {
  MAX_TILE_COLUMNS,
  MAX_TILE_ROWS,
  TILE_GAP_PX,
  computeTileGrid,
  orderTileWallThreads,
  resolveTileState,
  selectTileWallThreads,
  tileWallKey,
  type TileState,
} from "../lib/tileWall";
import {
  useAllEnvironmentShellsBootstrapped,
  useDelegatedUnderParent,
  useProject,
  useServerConfigs,
  useThreadShells,
} from "../state/entities";
import { usePrefetchEnvironmentThread } from "../state/threads";
import { useEnvironmentScope } from "../state/session";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  closeTileWall,
  setTileWallLayout,
  setTileWallOrder,
  useTileWallStore,
} from "../tileWallStore";
import { SnoozeMenuButton } from "./sidebar/SidebarThreadRow";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
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

const TILE_HEADER_BUTTON_CLASS =
  "inline-flex cursor-pointer items-center gap-1 rounded-sm bg-background/25 px-1.5 py-0.5 text-2xs font-bold tracking-wide uppercase hover:bg-background/40";

function reportTileActionFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

function TileWallTile({
  thread,
  position,
}: {
  readonly thread: EnvironmentThreadShell;
  /** Where the tile sits on the wall; the DOM keeps creation order so a move never remounts it. */
  readonly position: number;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tileWallKey(thread),
  });
  const navigate = useNavigate();
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const project = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
  const stateKey = resolveTileState(thread);
  const state = TILE_STATE_STYLES[stateKey];
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { settleThread, snoozeThread } = useThreadActions();
  const environmentKnown = useServerConfigs().has(thread.environmentId);
  const canOperate = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
  // Read when the thread changes, not per render, so the snooze gate follows the thread's state.
  const [snoozeClock, setSnoozeClock] = useState(() => ({
    thread,
    now: new Date().toISOString(),
  }));
  if (snoozeClock.thread !== thread) {
    // oxlint-disable-next-line react/purity -- Reseeds the clock only in the render-phase adjustment that runs when the thread changes.
    setSnoozeClock({ thread, now: new Date().toISOString() });
  }
  const showSnooze = canOperate && environmentKnown && canSnooze(thread, { now: snoozeClock.now });
  const settleTile = async () =>
    reportTileActionFailure("Failed to settle thread", await settleThread(threadRef));
  const snoozeTile = async (preset: { readonly snoozedUntil: string }) =>
    reportTileActionFailure(
      "Failed to snooze thread",
      await snoozeThread(threadRef, preset.snoozedUntil),
    );

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
      ref={setNodeRef}
      style={{
        order: position,
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
      }}
      data-side-chat-pane
      data-tile-wall-tile
      data-tile-state={stateKey}
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border-2 bg-background focus-within:ring-2 focus-within:ring-inset focus-within:ring-foreground/30",
        isDragging && "opacity-90 shadow-2xl",
        state.frame,
      )}
    >
      <header
        {...listeners}
        className={cn(
          "flex h-9 shrink-0 cursor-grab touch-none items-center gap-2 px-3 select-none",
          isDragging && "cursor-grabbing",
          state.header,
        )}
      >
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
        {showSnooze ? (
          <SnoozeMenuButton
            open={snoozeMenuOpen}
            onOpenChange={setSnoozeMenuOpen}
            onSnooze={(preset) => void snoozeTile(preset)}
            timestampFormat={timestampFormat}
            environmentId={thread.environmentId}
            triggerClassName={cn(TILE_HEADER_BUTTON_CLASS, "py-1")}
          />
        ) : null}
        {canOperate && environmentKnown ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Settle thread"
                  className={TILE_HEADER_BUTTON_CLASS}
                  onClick={() => void settleTile()}
                />
              }
            >
              <CheckIcon className="size-3" />
              Settle
            </TooltipTrigger>
            <TooltipPopup>Settle thread</TooltipPopup>
          </Tooltip>
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

function PrefetchTileThread({ thread }: { readonly thread: EnvironmentThreadShell }) {
  usePrefetchEnvironmentThread(thread.environmentId, thread.id);
  return null;
}

/** Once the app is idle, decodes each tile's cached thread so opening the wall renders from memory. */
export function TileWallPrefetch() {
  const used = useTileWallStore((state) => state.used);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const [idle, setIdle] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- waits for the browser's first idle period after startup
  useEffect(() => {
    if (!used || !bootstrapped || idle) return;
    if (typeof window.requestIdleCallback !== "function") {
      const timer = window.setTimeout(() => setIdle(true), 500);
      return () => window.clearTimeout(timer);
    }
    const handle = window.requestIdleCallback(() => setIdle(true), { timeout: 3000 });
    return () => window.cancelIdleCallback(handle);
  }, [used, bootstrapped, idle]);
  const threads = useThreadShells(idle);
  const delegatedUnderParent = useDelegatedUnderParent();
  if (!idle) return null;
  return selectTileWallThreads({ threads, delegatedUnderParent }).map((thread) => (
    <PrefetchTileThread key={tileWallKey(thread)} thread={thread} />
  ));
}

function TileCountPicker(props: {
  readonly label: string;
  readonly max: number;
  readonly value: number | null;
  readonly onChange: (value: number | null) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-xs text-muted-foreground">{props.label}</span>
      <ToggleGroup
        aria-label={props.label}
        value={[props.value === null ? "auto" : String(props.value)]}
        onValueChange={(next) => {
          const value = next[0];
          if (value) props.onChange(value === "auto" ? null : Number(value));
        }}
      >
        <Toggle value="auto">Auto</Toggle>
        {Array.from({ length: props.max }, (_, index) => (
          <Toggle key={index} value={String(index + 1)}>
            {index + 1}
          </Toggle>
        ))}
      </ToggleGroup>
    </div>
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
  const savedOrder = useTileWallStore((state) => state.order);
  const orderedKeys = orderTileWallThreads(tiles, savedOrder).map(tileWallKey);
  // A small drag distance keeps a plain click on the title opening the thread.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = orderedKeys.indexOf(String(active.id));
    const to = orderedKeys.indexOf(String(over.id));
    if (from >= 0 && to >= 0) setTileWallOrder(arrayMove(orderedKeys, from, to));
  };
  const columnsPreference = useTileWallStore((state) => state.columns);
  const rowsPreference = useTileWallStore((state) => state.rows);
  const [gridElement, setGridElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Measured before paint and tiles wait for it, so they never mount into a one-column grid and reflow.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the wall's measured size into state so the grid shape follows the window
  useLayoutEffect(() => {
    if (!gridElement) return;
    const read = () =>
      setSize({ width: gridElement.clientWidth, height: gridElement.clientHeight });
    read();
    return observeResize(gridElement, read);
  }, [gridElement]);

  const { columns, visibleRows, minTileHeightPx } = computeTileGrid(
    tiles.length,
    size.width,
    size.height,
    { columns: columnsPreference, rows: rowsPreference },
  );
  return (
    <div
      data-tile-wall
      className="fixed inset-0 z-50 flex flex-col gap-1 bg-background p-1.5"
      role="region"
      aria-label="Thread tile wall"
    >
      <div className="flex h-7 shrink-0 items-center gap-2 px-1 text-xs text-muted-foreground">
        <span>{tiles.length === 1 ? "1 thread" : `${tiles.length} threads`}</span>
        <div className="ms-auto flex items-center gap-1">
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="xs"
                  aria-label="Tile layout"
                  title="Tile layout"
                />
              }
            >
              <LayoutGridIcon />
              {columns} × {visibleRows}
            </PopoverTrigger>
            <PopoverPopup align="end" padding="compact">
              <div className="flex flex-col gap-2">
                <TileCountPicker
                  label="Columns"
                  max={MAX_TILE_COLUMNS}
                  value={columnsPreference}
                  onChange={(value) => setTileWallLayout({ columns: value })}
                />
                <TileCountPicker
                  label="Rows"
                  max={MAX_TILE_ROWS}
                  value={rowsPreference}
                  onChange={(value) => setTileWallLayout({ rows: value })}
                />
                <p className="text-xs text-muted-foreground">
                  The most tiles shown at once. The rest scroll. Auto fits the window.
                </p>
              </div>
            </PopoverPopup>
          </Popover>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Close tile wall"
            title="Close tile wall"
            onClick={closeTileWall}
          >
            <XIcon />
          </Button>
        </div>
      </div>
      <div
        ref={setGridElement}
        className="grid min-h-0 min-w-0 flex-1 overflow-y-auto"
        style={{
          gap: TILE_GAP_PX,
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          // max(), not minmax(): a minmax track shrinks to fit every row on screen instead of scrolling.
          gridAutoRows: `max(${minTileHeightPx}px, calc((100% - ${(visibleRows - 1) * TILE_GAP_PX}px) / ${visibleRows}))`,
        }}
      >
        {size.width === 0 ? null : tiles.length === 0 ? (
          <p className="col-span-full self-center text-center text-sm text-muted-foreground">
            No active threads. Press the shortcut again to leave the tile wall.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={orderedKeys} strategy={rectSortingStrategy}>
              {tiles.map((thread) => (
                <TileWallTile
                  key={tileWallKey(thread)}
                  thread={thread}
                  position={orderedKeys.indexOf(tileWallKey(thread))}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}
