import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon, RotateCcwIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { isTrailingDoubleClick } from "../Sidebar.logic";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { readLocalApi } from "~/localApi";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { cn } from "~/lib/utils";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { useCondensedChrome, useDriveMode } from "../../hooks/useTouchLayout";
import {
  HeaderUsageStats,
  HeaderUsageStatsMenu,
  resolveScopedWeeklyLabel,
  selectHeaderUsageStats,
  selectHeaderUsageStatsVisibility,
} from "./HeaderUsageStats";
import { ClaudeAccountUsageBadge } from "./ClaudeAccountUsageBadge";
import { TokenUsageBadge } from "./TokenUsageBadge";
import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { useProviderUsage } from "../../hooks/useProviderUsage";
import { useStockQuote } from "../../hooks/useStockQuote";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  /** Drafts have no server thread yet, so the title carries no action menu. */
  isServerThread: boolean;
  contextWindow: ContextWindowSnapshot | null;
  restartRequested: boolean;
  onToggleRestartRequest: () => void;
  activeProject: EnvironmentProject | null;
  rightPanelOpen: boolean;
  onNewThreadInProject: () => void;
  onOpenProjectSettings?: (() => void) | undefined;
}

/**
 * Rename commit rule shared with the sidebar's inline rename: trim, reject
 * empty (the caller toasts), and skip the mutation when nothing changed.
 */
export function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

// How long a click on the thread title waits before opening the action menu,
// so a double-click-to-rename can cancel it first. Only the native desktop
// menu needs this: it swallows input while open, so the wait must cover the
// OS double-click interval. The browser fallback menu keeps seeing DOM
// events (the second click dismisses it and dblclick still fires), so it
// opens immediately.
const TITLE_MENU_OPEN_DELAY_MS = 500;
export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  activeThreadTitle,
  isServerThread,
  contextWindow,
  restartRequested,
  onToggleRestartRequest,
  activeProject,
  rightPanelOpen,
  onNewThreadInProject,
  onOpenProjectSettings,
}: ChatHeaderProps) {
  const activeProjectName = activeProject?.title;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeThreadRef = useMemo(
    () => scopeThreadRef(activeThreadEnvironmentId, activeThreadId),
    [activeThreadEnvironmentId, activeThreadId],
  );
  // Subscription windows ride on the thread's own environment's provider
  // snapshots, so they always describe the account the thread runs on.
  const { claude: claudeAccountUsage, codex: codexUsage } =
    useProviderUsage(activeThreadEnvironmentId);
  const usageStatsVisibility = useClientSettings(selectHeaderUsageStatsVisibility);
  const stockSymbol = useClientSettings((settings) => settings.headerUsageStockSymbol);
  const stockQuote = useStockQuote(usageStatsVisibility.stock, stockSymbol);
  const updateClientSettings = useUpdateClientSettings();
  // Phones and the touch / car layout keep the big usage readouts visible and
  // drop the small badges that duplicate them.
  const condensed = useCondensedChrome();
  // Drive density (car-sized touch viewport): the usage readouts fold into a
  // compact stack that never collapses, so the ticker and the session/weekly
  // percentages stay readable at a glance.
  const driveMode = useDriveMode();
  const usageStats = selectHeaderUsageStats({
    visibility: usageStatsVisibility,
    contextWindow,
    claudeUsage: claudeAccountUsage,
    codexUsage,
    // A stock quote is a public, host-agnostic value, so it is shown for every
    // thread (no primary-environment gate like the credential-backed stats).
    stockQuote,
    stockSymbol,
  });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  // Inline rename, keyed by thread: navigating away drops an in-progress
  // rename instead of committing stale text. Cleared on thread change (not
  // just hidden) so returning to the thread doesn't revive the old draft.
  const [renaming, setRenaming] = useState<{
    threadId: ThreadId;
    environmentId: EnvironmentId;
    title: string;
  } | null>(null);
  if (
    renaming !== null &&
    (renaming.threadId !== activeThreadId || renaming.environmentId !== activeThreadEnvironmentId)
  ) {
    setRenaming(null);
  }
  const renamingTitle = renaming?.threadId === activeThreadId ? renaming.title : null;
  const renameCommittedRef = useRef(false);
  const startRename = useCallback(() => {
    renameCommittedRef.current = false;
    setRenaming({
      threadId: activeThreadId,
      environmentId: activeThreadEnvironmentId,
      title: activeThreadTitle,
    });
  }, [activeThreadEnvironmentId, activeThreadId, activeThreadTitle]);
  const commitRename = useCallback(
    (title: string) => {
      setRenaming(null);
      const resolution = resolveRenameCommit({ title, originalTitle: activeThreadTitle });
      if (resolution.action === "reject-empty") {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        return;
      }
      if (resolution.action === "noop") return;
      void updateThreadMetadata({
        environmentId: activeThreadEnvironmentId,
        input: { threadId: activeThreadId, title: resolution.title },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
      });
    },
    [activeThreadEnvironmentId, activeThreadId, activeThreadTitle, updateThreadMetadata],
  );
  const { openMenu, closeMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    onStartRename: startRename,
  });
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleMenuTimerRef = useRef<number | null>(null);
  const cancelPendingTitleMenu = useCallback(() => {
    if (titleMenuTimerRef.current === null) return;
    clearTimeout(titleMenuTimerRef.current);
    titleMenuTimerRef.current = null;
  }, []);
  // Drop a pending menu-open when the thread changes or the header unmounts,
  // so it can never fire for a thread the user already left.
  useEffect(
    () => () => {
      cancelPendingTitleMenu();
    },
    [activeThreadEnvironmentId, activeThreadId, cancelPendingTitleMenu],
  );
  const openTitleMenuNow = useCallback(() => {
    cancelPendingTitleMenu();
    const rect = titleButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  }, [cancelPendingTitleMenu, openMenu]);
  const openMenuFromTitle = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      // The trailing click of a double-click belongs to rename, not the menu.
      if (isTrailingDoubleClick(event.detail)) return;
      // Keyboard activation and the explicit chevron affordance can never be
      // the first half of a double-click, so they open without waiting.
      const clickedChevron =
        (event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null;
      if (event.detail === 0 || clickedChevron || window.desktopBridge === undefined) {
        openTitleMenuNow();
        return;
      }
      // Stay pending long enough for dblclick to cancel the open before the
      // native menu appears and swallows the second click.
      cancelPendingTitleMenu();
      titleMenuTimerRef.current = window.setTimeout(() => {
        titleMenuTimerRef.current = null;
        openTitleMenuNow();
      }, TITLE_MENU_OPEN_DELAY_MS);
    },
    [cancelPendingTitleMenu, openTitleMenuNow],
  );
  const handleTitleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      // The chevron is the explicit menu affordance; only the title text renames.
      if ((event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null) return;
      cancelPendingTitleMenu();
      closeMenu();
      startRename();
    },
    [cancelPendingTitleMenu, closeMenu, startRename],
  );
  const handleHeaderContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if (renamingTitle !== null) return;
      if (!isServerThread && onOpenProjectSettings === undefined) return;
      cancelPendingTitleMenu();
      event.preventDefault();
      if (!isServerThread) {
        const api = readLocalApi();
        if (!api) return;
        void api.contextMenu
          .show([{ id: "project-settings", label: "Project settings", icon: "settings" }], {
            x: event.clientX,
            y: event.clientY,
          })
          .then((action) => {
            if (action === "project-settings") onOpenProjectSettings?.();
          });
        return;
      }
      openMenu({ x: event.clientX, y: event.clientY });
    },
    [cancelPendingTitleMenu, isServerThread, onOpenProjectSettings, openMenu, renamingTitle],
  );
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        renameCommittedRef.current = true;
        commitRename(event.currentTarget.value);
      } else if (event.key === "Escape") {
        renameCommittedRef.current = true;
        setRenaming(null);
      }
    },
    [commitRename],
  );
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 sm:gap-3",
        // Room for the fixed panel toggles. The touch layout keeps only the
        // 48px thread-details toggle (ChatView hides the other two).
        rightPanelOpen ? "pr-10" : "pr-24",
        "touch:pr-16",
      )}
      onContextMenu={handleHeaderContextMenu}
    >
      <WorkspaceBreadcrumb
        ariaLabel="Thread breadcrumb"
        className="flex-1 overflow-clip [overflow-clip-margin:2px]"
      >
        {/* The project always leads the header: knowing which project a
            thread lives in is priority zero, and the thread title alone
            doesn't answer it. */}
        {activeProject ? (
          <>
            <WorkspaceBreadcrumbItem
              className={cn(
                "shrink",
                // On a phone the usage strip competes for width, so the project
                // name may truncate instead of starving the thread title.
                condensed && "max-md:max-w-28",
              )}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`New thread in ${activeProjectName}`}
                      onClick={onNewThreadInProject}
                      className={cn(
                        "inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                        // The new-chat crumb is a real tap target on phones and in
                        // the touch layout (which grows it further to 48px).
                        condensed && "min-h-11 gap-2 rounded-lg px-2 hover:bg-accent",
                        "touch:min-h-12 touch:text-base",
                      )}
                    />
                  }
                >
                  <ProjectFavicon
                    project={activeProject}
                    className={cn("size-3.5 touch:size-5", condensed && "size-4.5")}
                  />
                  {/* Drive density keeps only the favicon: the sidebar already
                      names the project, and the title needs the width. */}
                  <WorkspaceBreadcrumbText className="max-w-40 drive:hidden">
                    {activeProjectName}
                  </WorkspaceBreadcrumbText>
                </TooltipTrigger>
                <TooltipPopup side="top">New thread in {activeProjectName}</TooltipPopup>
              </Tooltip>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator>
              <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbSeparator>
          </>
        ) : null}
        <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
          {renamingTitle !== null ? (
            <input
              autoFocus
              aria-label="Thread title"
              className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-ring/50 focus:ring-ring touch:min-h-12 touch:text-base"
              defaultValue={renamingTitle}
              onBlur={(event) => {
                if (renameCommittedRef.current) return;
                // Focus landing on a navigation button means the rename was
                // abandoned — discard it rather than persisting a half-draft.
                if (
                  event.relatedTarget instanceof HTMLElement &&
                  event.relatedTarget.closest("button")
                ) {
                  setRenaming(null);
                  return;
                }
                commitRename(event.currentTarget.value);
              }}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={handleRenameKeyDown}
            />
          ) : isServerThread ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    ref={titleButtonRef}
                    type="button"
                    aria-label={`Thread actions for ${activeThreadTitle}`}
                    aria-haspopup="menu"
                    onClick={openMenuFromTitle}
                    onDoubleClick={handleTitleDoubleClick}
                    onBlur={cancelPendingTitleMenu}
                    className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring touch:min-h-12 touch:text-base"
                  />
                }
              >
                <h2 className="min-w-0">
                  <WorkspaceBreadcrumbText>{activeThreadTitle}</WorkspaceBreadcrumbText>
                </h2>
                <ChevronDownIcon
                  aria-hidden
                  data-thread-title-chevron
                  className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100 touch:size-5 touch:opacity-100"
                />
              </TooltipTrigger>
              <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <h2 aria-label={activeThreadTitle} className="min-w-0 flex-1 touch:text-base" />
                }
              >
                <WorkspaceBreadcrumbText>{activeThreadTitle}</WorkspaceBreadcrumbText>
              </TooltipTrigger>
              <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
            </Tooltip>
          )}
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <HeaderUsageStats stats={usageStats} condensed={condensed} compact={driveMode} />
      {/* Drive density hides the configuration and restart-flag buttons: both
          are parked-time actions, and the width goes to the readouts. */}
      <div
        data-chat-header-actions
        className="flex shrink-0 items-center justify-end gap-2 touch:gap-3 drive:hidden"
      >
        {/* The small badges duplicate the big readouts; condensed headers drop
            them to make room for the readouts themselves. */}
        {!condensed && contextWindow && <TokenUsageBadge usage={contextWindow} />}
        {!condensed && claudeAccountUsage && <ClaudeAccountUsageBadge usage={claudeAccountUsage} />}
        <HeaderUsageStatsMenu
          condensed={condensed}
          visibility={usageStatsVisibility}
          scopedWeeklyLabel={resolveScopedWeeklyLabel(claudeAccountUsage)}
          stockSymbol={stockSymbol}
          onPatch={updateClientSettings}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0 touch:size-12 touch:min-w-12"
                pressed={restartRequested}
                onPressedChange={onToggleRestartRequest}
                aria-label="Flag this chat as needing a service restart"
                variant="outline-destructive"
                size="xs"
              >
                <RotateCcwIcon className="size-3 touch:size-5" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {restartRequested
              ? "This chat is flagged as needing a service restart — click to clear"
              : "Flag this chat as needing a service restart"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
