import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon, RotateCcwIcon } from "lucide-react";
import {
  memo,
  useEffect,
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
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useCondensedChrome, useDriveMode, useTouchLayout } from "../../hooks/useTouchLayout";
import {
  HeaderUsageStats,
  HeaderUsageStatsMenu,
  resolveScopedWeeklyLabel,
  selectHeaderUsageBadges,
  selectHeaderUsageStats,
  selectHeaderUsageStatsVisibility,
} from "./HeaderUsageStats";
import { NotificationBell } from "../notifications/NotificationBell";
import { CacheKeepAliveToggle } from "./CacheKeepAliveToggle";
import { ClaudeAccountUsageBadge } from "./ClaudeAccountUsageBadge";
import { TokenUsageBadge } from "./TokenUsageBadge";
import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { useProviderUsage } from "../../hooks/useProviderUsage";
import { useStockQuote } from "../../hooks/useStockQuote";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  providerInstanceId: ProviderInstanceId | null;
  isServerThread: boolean;
  contextWindow: ContextWindowSnapshot | null;
  restartRequested: boolean;
  onToggleRestartRequest: () => void;
  activeProject: EnvironmentProject | null;
  parentThreadLink: { threadId: ThreadId; title: string } | null;
  onOpenThread: (threadId: ThreadId) => void;
  rightPanelOpen: boolean;
  onNewThreadInProject: () => void;
  onOpenProjectSettings?: (() => void) | undefined;
}

export function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

// How long a click on the thread title waits before opening the action menu, so
// a double-click-to-rename can cancel it first. Only the native desktop menu
// needs this: it swallows input while open, so the wait must cover the OS
// double-click interval.
const TITLE_MENU_OPEN_DELAY_MS = 500;
export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  activeThreadTitle,
  providerInstanceId,
  isServerThread,
  contextWindow,
  restartRequested,
  onToggleRestartRequest,
  activeProject,
  parentThreadLink,
  onOpenThread,
  rightPanelOpen,
  onNewThreadInProject,
  onOpenProjectSettings,
}: ChatHeaderProps) {
  const activeProjectName = activeProject?.isScratch ? "No project" : activeProject?.title;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const interfaceFont = useClientSettings((settings) => settings.fontFamilySans);
  const breadcrumbContainerRef = useRef<HTMLDivElement>(null);
  const [collapseParentTitle, setCollapseParentTitle] = useState(false);
  const activeThreadRef = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
  // Subscription windows ride on the thread's own environment's provider
  // snapshots, so they always describe the account the thread runs on.
  const {
    claude: claudeAccountUsage,
    codex: codexUsage,
    gemini: geminiUsage,
  } = useProviderUsage(activeThreadEnvironmentId, providerInstanceId);
  const usageStatsVisibility = useClientSettings(selectHeaderUsageStatsVisibility);
  const stockSymbol = useClientSettings((settings) => settings.headerUsageStockSymbol);
  const stockQuote = useStockQuote(usageStatsVisibility.stock, stockSymbol);
  // Phones and the touch / car layout keep the big usage readouts visible and
  // drop the small badges that duplicate them.
  const condensed = useCondensedChrome();
  // Drive density (car-sized touch viewport): the usage readouts fold into a
  // compact stack that never collapses, so the ticker and the session/weekly
  // percentages stay readable at a glance.
  const driveMode = useDriveMode();
  const touchLayout = useTouchLayout();
  const usageStats = selectHeaderUsageStats({
    visibility: usageStatsVisibility,
    contextWindow,
    claudeUsage: claudeAccountUsage,
    codexUsage,
    geminiUsage,
    // A stock quote is a public, host-agnostic value, so it is shown for every
    // thread (no primary-environment gate like the credential-backed stats).
    stockQuote,
    stockSymbol,
  });
  const usageBadges = selectHeaderUsageBadges({
    stats: usageStats,
    contextWindow,
    claudeUsage: claudeAccountUsage,
  });
  const canOperateThread = useEnvironmentScope(
    activeThreadEnvironmentId,
    AuthOrchestrationOperateScope,
  );
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [renaming, setRenaming] = useState<{
    threadId: ThreadId;
    environmentId: EnvironmentId;
    title: string;
  } | null>(null);
  if (
    renaming !== null &&
    (renaming.threadId !== activeThreadId ||
      renaming.environmentId !== activeThreadEnvironmentId ||
      !canOperateThread)
  ) {
    setRenaming(null);
  }
  const renamingTitle =
    canOperateThread &&
    renaming?.threadId === activeThreadId &&
    renaming.environmentId === activeThreadEnvironmentId
      ? renaming.title
      : null;
  const isRenamingTitle = renamingTitle !== null;
  useEffect(() => {
    const list = breadcrumbContainerRef.current?.querySelector("ol");
    if (!list || !parentThreadLink) return;
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
      const width = Array.from(list.children).reduce(
        (total, item) => {
          const label = item.querySelector('[data-slot="workspace-breadcrumb-text"]');
          const ellipsis = item.querySelector("[data-parent-breadcrumb-ellipsis]");
          return (
            total +
            (item.firstElementChild?.getBoundingClientRect().width ?? 0) +
            (label && getComputedStyle(label).maxWidth === "none"
              ? label.scrollWidth - label.clientWidth
              : 0) -
            (ellipsis?.getBoundingClientRect().width ?? 0)
          );
        },
        gap * (list.children.length - 1),
      );
      setCollapseParentTitle(width > list.clientWidth);
    };
    measure();
    const frame = requestAnimationFrame(measure);
    document.fonts.addEventListener("loadingdone", measure);
    const stopObserving = observeResize(list, measure);
    return () => {
      cancelAnimationFrame(frame);
      document.fonts.removeEventListener("loadingdone", measure);
      stopObserving();
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Title, font and rename changes resize the breadcrumb text without resizing the list, so it re-measures.
    activeProjectName,
    activeThreadTitle,
    parentThreadLink,
    interfaceFont,
    isRenamingTitle,
  ]);
  const renameCommittedRef = useRef(false);
  const startRename = () => {
    if (
      !isServerThread ||
      !readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)
    )
      return;
    renameCommittedRef.current = false;
    setRenaming({
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      title: activeThreadTitle,
    });
  };
  const commitRename = (title: string) => {
    setRenaming(null);
    if (!readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)) return;
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
  };
  const { openMenu, closeMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    onStartRename: startRename,
  });
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleMenuTimerRef = useRef<number | null>(null);
  const cancelPendingTitleMenu = () => {
    if (titleMenuTimerRef.current === null) return;
    clearTimeout(titleMenuTimerRef.current);
    titleMenuTimerRef.current = null;
  };
  useEffect(
    () => () => {
      if (titleMenuTimerRef.current === null) return;
      clearTimeout(titleMenuTimerRef.current);
      titleMenuTimerRef.current = null;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A pending title menu belongs to the thread that was clicked, so switching threads drops it.
    [activeThreadEnvironmentId, activeThreadId],
  );
  const openTitleMenuNow = () => {
    cancelPendingTitleMenu();
    const rect = titleButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  const openMenuFromTitle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (isTrailingDoubleClick(event.detail)) return;
    const clickedChevron =
      (event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null;
    if (event.detail === 0 || clickedChevron || window.desktopBridge === undefined) {
      openTitleMenuNow();
      return;
    }
    cancelPendingTitleMenu();
    titleMenuTimerRef.current = window.setTimeout(() => {
      titleMenuTimerRef.current = null;
      openTitleMenuNow();
    }, TITLE_MENU_OPEN_DELAY_MS);
  };
  const handleTitleDoubleClick = (event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null) return;
    cancelPendingTitleMenu();
    closeMenu();
    startRename();
  };
  const handleHeaderContextMenu = (event: ReactMouseEvent) => {
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
  };
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      renameCommittedRef.current = true;
      commitRename(event.currentTarget.value);
    } else if (event.key === "Escape") {
      renameCommittedRef.current = true;
      setRenaming(null);
    }
  };
  return (
    <div
      ref={breadcrumbContainerRef}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 sm:gap-3",
        // Phones give the project and title the whole first row; the usage
        // readouts and the header actions share a second one below it.
        // The reserved right inset moves onto the title row, since the fixed
        // panel toggles only sit beside that row.
        condensed && "max-md:flex-wrap max-md:content-start max-md:gap-y-0 max-md:pr-0!",
        // Room for the fixed panel toggles. The touch layout keeps only the
        // 48px thread-details toggle (ChatView hides the other two).
        rightPanelOpen ? "pr-10" : "pr-24",
        "touch:pr-16",
      )}
      onContextMenu={handleHeaderContextMenu}
    >
      <WorkspaceBreadcrumb
        ariaLabel="Thread breadcrumb"
        className={cn(
          "flex-1 overflow-clip [overflow-clip-margin:2px]",
          condensed &&
            "max-md:h-[var(--workspace-topbar-height)] max-md:basis-full max-md:pr-24 max-md:touch:pr-16",
        )}
      >
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
                        "inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
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
        {parentThreadLink ? (
          <>
            <WorkspaceBreadcrumbItem>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`Open parent thread: ${parentThreadLink.title}`}
                      onClick={() => onOpenThread(parentThreadLink.threadId)}
                      className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    />
                  }
                >
                  <WorkspaceBreadcrumbText
                    aria-hidden
                    className={collapseParentTitle ? "w-0" : undefined}
                  >
                    {parentThreadLink.title}
                  </WorkspaceBreadcrumbText>
                  {collapseParentTitle ? (
                    <span aria-hidden data-parent-breadcrumb-ellipsis>
                      ...
                    </span>
                  ) : null}
                </TooltipTrigger>
                <TooltipPopup side="top">{parentThreadLink.title}</TooltipPopup>
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
              className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-inset ring-ring/50 focus:ring-ring touch:min-h-12 touch:text-base"
              defaultValue={renamingTitle}
              onBlur={(event) => {
                if (renameCommittedRef.current) return;
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
                    onDoubleClick={canOperateThread ? handleTitleDoubleClick : undefined}
                    onBlur={cancelPendingTitleMenu}
                    className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring touch:min-h-12 touch:text-base"
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
        className="flex shrink-0 items-center justify-end gap-2 touch:gap-3 max-md:ml-auto max-md:touch:gap-1.5 max-md:pb-1.5 drive:hidden"
      >
        {/* The small badges stand in for big readouts that are hidden; condensed
            headers drop them to make room for the readouts themselves. */}
        {!condensed && contextWindow && usageBadges.tokens && (
          <TokenUsageBadge usage={contextWindow} />
        )}
        {!condensed && claudeAccountUsage && usageBadges.claudeLimit && (
          <ClaudeAccountUsageBadge usage={claudeAccountUsage} headline={usageBadges.claudeLimit} />
        )}
        <NotificationBell />
        <HeaderUsageStatsMenu
          condensed={condensed}
          visibility={usageStatsVisibility}
          scopedWeeklyLabel={resolveScopedWeeklyLabel(claudeAccountUsage)}
          stockSymbol={stockSymbol}
          onPatch={updateClientSettings}
        />
        {/* Elsewhere the toggle lives in the composer footer beside the access mode. */}
        {isServerThread && touchLayout ? (
          <CacheKeepAliveToggle
            placement="header"
            environmentId={activeThreadEnvironmentId}
            threadId={activeThreadId}
          />
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0 touch:size-12 touch:min-w-12 max-md:touch:size-10 max-md:touch:min-w-10"
                pressed={restartRequested}
                onPressedChange={onToggleRestartRequest}
                disabled={!canOperateThread}
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
