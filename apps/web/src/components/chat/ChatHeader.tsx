import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { type HeaderControlVisibility } from "@t3tools/contracts/settings";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { cn } from "~/lib/utils";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
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
import { useClaudeAccountUsage } from "../../hooks/useClaudeAccountUsage";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  contextWindow: ContextWindowSnapshot | null;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function resolveHeaderControlVisibility(
  visibility: HeaderControlVisibility,
  isMobile: boolean,
): boolean {
  if (visibility === "auto") {
    return !isMobile;
  }
  return visibility === "show";
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  contextWindow,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const claudeAccountUsage = useClaudeAccountUsage();
  const isMobile = useIsMobile();
  const headerControlVisibility = useClientSettings((settings) => ({
    gitActions: settings.headerGitActionsVisibility,
    openInEditor: settings.headerOpenInEditorVisibility,
    projectScripts: settings.headerProjectScriptsVisibility,
  }));
  const usageStatsVisibility = useClientSettings(selectHeaderUsageStatsVisibility);
  const updateClientSettings = useUpdateClientSettings();
  // The usage RPC reads the primary server's host credentials, so only surface
  // Claude account stats for threads that actually run there (same gate as
  // ClaudeAccountUsageBadge below).
  const claudeUsageForThread =
    activeThreadEnvironmentId === primaryEnvironmentId ? claudeAccountUsage : null;
  const usageStats = selectHeaderUsageStats({
    visibility: usageStatsVisibility,
    contextWindow,
    claudeUsage: claudeUsageForThread,
  });
  const showGitActions = resolveHeaderControlVisibility(
    headerControlVisibility.gitActions,
    isMobile,
  );
  const showOpenInEditor = resolveHeaderControlVisibility(
    headerControlVisibility.openInEditor,
    isMobile,
  );
  const showProjectScripts = resolveHeaderControlVisibility(
    headerControlVisibility.projectScripts,
    isMobile,
  );
  const showOpenInPicker =
    showOpenInEditor &&
    shouldShowOpenInPicker({
      activeProjectName,
      activeThreadEnvironmentId,
      primaryEnvironmentId,
    });
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
      </div>
      <HeaderUsageStats stats={usageStats} />
      <div
        data-chat-header-actions
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
          rightPanelOpen ? "pr-0" : "pr-16",
        )}
      >
        {contextWindow && <TokenUsageBadge usage={contextWindow} />}
        {/* The usage RPC reads the primary server's host credentials, so only
            show it for threads that actually run there. */}
        {claudeAccountUsage && activeThreadEnvironmentId === primaryEnvironmentId && (
          <ClaudeAccountUsageBadge usage={claudeAccountUsage} />
        )}
        <HeaderUsageStatsMenu
          visibility={usageStatsVisibility}
          scopedWeeklyLabel={resolveScopedWeeklyLabel(claudeAccountUsage)}
          onPatch={updateClientSettings}
        />
        {showProjectScripts && activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {showOpenInPicker && (
          <OpenInPicker
            environmentId={activeThreadEnvironmentId}
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {showGitActions && activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
      </div>
    </div>
  );
});
