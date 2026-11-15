import type { DraftId } from "~/composerDraftStore";
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import { resolveEnvironmentMachineKind, type ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { ArchiveIcon, ChevronDownIcon, FolderPlusIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useOrderWhileOpen } from "~/hooks/useOrderWhileOpen";
import { useProjectPin } from "~/hooks/useProjectGroupUpdate";
import { useScratchProject } from "~/hooks/useScratchProject";
import { isTriagePrompt } from "@t3tools/shared/triagePrompt";
import { useClientSettings } from "~/hooks/useSettings";
import { useCondensedChrome } from "~/hooks/useTouchLayout";
import { cn } from "~/lib/utils";
import { hasExplicitComposerModelSelection } from "~/lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  pickableProjectGroups,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
} from "~/sidebarProjectGrouping";
import { useProjects, useVisibleThreadShells } from "~/state/entities";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  useEnvironmentProviders,
} from "~/state/environments";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  isProjectArchiveShortcut,
  isProjectPinShortcut,
  ProjectArchiveButton,
  ProjectPinButton,
} from "../ProjectPinButton";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button, InlineButton } from "../ui/button";
import { DraftProjectName } from "./DraftProjectName";
import { DraftHeroProjectHeading } from "./DraftHeroProjectHeading";
import { TriageDraftHero } from "./TriageDraftHero";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";

const ADD_PROJECT_VALUE = "add-project";

interface PickerItem {
  readonly value: string;
  readonly label: string;
}

/**
 * Phone / touch-layout project selector: a 48px+ pill with a chevron, so it
 * reads as a button and is easy to hit with a finger instead of being a
 * dotted word inside the sentence.
 */
const PILL_SELECTOR_CLASS =
  "pointer-events-auto inline-flex min-h-12 max-w-80 cursor-pointer items-center gap-2 rounded-full border border-border bg-muted/50 px-5 align-middle text-foreground transition-colors hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-muted data-popup-open:bg-muted touch:min-h-14 touch:px-6 drive:min-h-12 drive:px-4";

// Finger-sized rows for the project menu in the touch layout.
const TOUCH_MENU_ITEM_CLASS = "touch:min-h-12";

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const threads = useVisibleThreadShells();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  // A boolean, so typing in a draft does not re-render the hero.
  const isTriageDraftPrompt = useComposerDraftStore((store) =>
    draftId ? isTriagePrompt(store.getComposerDraft(draftId)?.prompt ?? "") : false,
  );
  const applyStickyState = useComposerDraftStore((store) => store.applyStickyState);
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const openAddProject = () => openCommandPalette({ open: "add-project" });
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const openProjectDraft = useNewThreadHandler();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const pillSelector = useCondensedChrome();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerFilter = useComboboxFilter();
  const highlightedPickerValueRef = useRef<string | null>(null);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const { canPinProjectGroup, toggleProjectGroupPin, setProjectGroupArchived } = useProjectPin();

  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectGroups = sortLogicalProjectsForSidebar(
    buildSidebarProjectSnapshots({
      projects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
    }),
    threads,
    projectSortOrder,
  );
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
  const environmentMachineById = new Map(
    environments.map(
      (environment) =>
        [
          environment.environmentId,
          resolveEnvironmentMachineKind(environment.serverConfig),
        ] as const,
    ),
  );
  const projectPickerEntries = buildSidebarProjectPickerEntries({
    groups: pickableProjectGroups(projectGroups),
    preferredProjectRef: activeProjectRef,
  });
  const archivedPickerEntries = buildSidebarProjectPickerEntries({
    groups: projectGroups.filter((group) => group.archived),
    preferredProjectRef: activeProjectRef,
  });
  const projectEntryByKey = new Map(
    [...projectPickerEntries, ...archivedPickerEntries].map(
      (entry) => [entry.group.projectKey, entry] as const,
    ),
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  const shouldShowProjectMenu = canChooseProject;
  const isMenuEntry = ({ targetProject }: (typeof projectPickerEntries)[number]) =>
    !isScratchProject(targetProject, scratchWorkspaceRootFor(targetProject.environmentId));
  const menuEntries = projectPickerEntries.filter(isMenuEntry);
  const archivedMenuEntries = archivedPickerEntries.filter(isMenuEntry);
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const scratchTargetEnvironmentId = scratchEnvironmentId(activeProjectRef?.environmentId ?? null);
  const scratchWorkspaceRoot = scratchWorkspaceRootFor(scratchTargetEnvironmentId);
  const isScratchDraft =
    activeProject !== null &&
    isScratchProject(activeProject, scratchWorkspaceRootFor(activeProject.environmentId));

  const pickerSearch = pickerQuery.trim();
  // Archived projects stay out of the list until a search or "Show archived" asks for them.
  const includeArchivedProjects = showArchivedProjects || pickerSearch.length > 0;
  const hiddenArchivedCount = includeArchivedProjects ? 0 : archivedMenuEntries.length;
  const toPickerItem = ({ group }: (typeof projectPickerEntries)[number]) => ({
    value: group.projectKey,
    label: group.displayName,
  });
  // Pinning from a row keeps rows in place while the picker is open.
  const openPickerItems = useOrderWhileOpen(
    menuEntries.map(toPickerItem),
    (item) => item.value,
    pickerOpen,
  );
  const pickerItems: readonly PickerItem[] = [
    ...openPickerItems,
    ...(includeArchivedProjects ? archivedMenuEntries.map(toPickerItem) : []),
    { value: ADD_PROJECT_VALUE, label: "Add project" },
  ];
  const filteredPickerItems =
    pickerSearch.length === 0
      ? pickerItems
      : pickerItems.filter(
          (item) =>
            item.value !== ADD_PROJECT_VALUE &&
            pickerFilter.contains(item, pickerSearch, (candidate) => candidate.label),
        );
  const selectedPickerItem = pickerItems.find((item) => item.value === activeProjectKey) ?? null;

  // The picker can change the draft's target while the no-project home is
  // still being opened; a stale continuation must not retarget it again. Picking
  // a project clears the pending request, and the draft session is compared
  // against the store when the scratch project arrives.
  const pendingScratchRef = useRef<symbol | null>(null);
  const draftTargetKey = () => {
    const session = draftId ? useComposerDraftStore.getState().getDraftSession(draftId) : null;
    return session
      ? `${session.environmentId}:${session.projectId}:${session.logicalProjectKey}`
      : null;
  };
  // Retargeting an empty draft would overwrite the project's draft and strand browser tabs.
  const selectProject = (project: (typeof projects)[number], logicalProjectKey: string) => {
    if (!draftId) {
      return;
    }
    pendingScratchRef.current = null;
    const currentDraft = getComposerDraft(draftId);
    if (!composerDraftHasUserContent(currentDraft)) {
      void openProjectDraft(scopeProjectRef(project.environmentId, project.id));
      return;
    }
    setLogicalProjectDraftThreadId(
      logicalProjectKey,
      scopeProjectRef(project.environmentId, project.id),
      draftId,
    );
    if (!hasExplicitComposerModelSelection(currentDraft)) {
      applyStickyState(draftId);
      const environmentConfig = environments.find(
        (environment) => environment.environmentId === project.environmentId,
      )?.serverConfig;
      const environmentSettings = environmentConfig?.settings;
      const defaultSelection = environmentSettings
        ? resolveProjectSettings(environmentSettings, project.id, project).settings
            .defaultModelSelection
        : project.defaultModelSelection;
      const fallbackResolution = resolveNewThreadModelSelection({
        defaultSelection:
          defaultSelection ??
          (useComposerDraftStore.getState().stickyActiveProvider !== null || !environmentSettings
            ? null
            : resolveProjectDefaultProviderModelSelection(
                providersByEnvironment.get(project.environmentId) ?? [],
                environmentSettings,
                project.id,
              )),
        fallbackSelection: environmentSettings?.fallbackModelSelection ?? null,
        providers: providersByEnvironment.get(project.environmentId) ?? [],
        ...(environmentSettings ? { settings: environmentSettings } : {}),
        projectId: project.id,
        now: Date.now(),
      });
      const defaultModelSelection = fallbackResolution.fallback
        ? fallbackResolution.selection
        : defaultSelection;
      if (defaultModelSelection) {
        setModelSelection(draftId, defaultModelSelection, {
          replaceOptions: true,
        });
      }
    }
  };
  const startScratch = async (): Promise<boolean> => {
    if (scratchTargetEnvironmentId === null || isScratchDraft) {
      return false;
    }
    const request = Symbol("scratch");
    pendingScratchRef.current = request;
    const requestedTarget = draftTargetKey();
    const project = await openScratchProject(scratchTargetEnvironmentId);
    if (!project || pendingScratchRef.current !== request || draftTargetKey() !== requestedTarget) {
      return false;
    }
    pendingScratchRef.current = null;
    selectProject(project, deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings));
    return true;
  };

  const projectSelector = shouldShowProjectMenu ? (
    <Combobox
      items={pickerItems}
      filteredItems={filteredPickerItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={pickerOpen}
      onItemHighlighted={(item) => {
        highlightedPickerValueRef.current = item?.value ?? null;
      }}
      onOpenChange={(open) => {
        setPickerOpen(open);
        setPickerQuery("");
        setShowArchivedProjects(false);
      }}
      value={selectedPickerItem}
      onValueChange={(item) => {
        if (!item) return;
        setPickerOpen(false);
        if (item.value === ADD_PROJECT_VALUE) {
          openAddProject();
          return;
        }
        const entry = projectEntryByKey.get(item.value);
        if (!entry || item.value === activeProjectKey) {
          return;
        }
        selectProject(entry.targetProject, entry.group.projectKey);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            pillSelector ? (
              <ComboboxTrigger
                render={<button type="button" className={PILL_SELECTOR_CLASS} />}
                data-draft-project-trigger=""
              />
            ) : (
              <ComboboxTrigger
                render={<InlineButton tone="picker" />}
                data-draft-project-trigger=""
                className="pointer-events-auto min-w-0 max-w-full align-baseline"
              />
            )
          }
        >
          <DraftProjectName
            value={isScratchDraft ? "No project" : (activeProjectTitle ?? "Choose a project")}
            singleLine
          />
          {pillSelector ? (
            <ChevronDownIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
          ) : null}
        </TooltipTrigger>
        {activeProjectTitle && !isScratchDraft ? (
          <TooltipPopup side="top">{activeProjectTitle}</TooltipPopup>
        ) : null}
      </Tooltip>
      <ComboboxPopup align="center" className="w-72 overflow-hidden touch:min-w-80">
        <ComboboxSearchInput
          aria-label="Search projects"
          placeholder="Search projects..."
          value={pickerQuery}
          onChange={(event) => setPickerQuery(event.target.value)}
          onKeyDown={(event) => {
            const highlighted = highlightedPickerValueRef.current;
            const group = highlighted ? projectEntryByKey.get(highlighted)?.group : undefined;
            if (!group || !canPinProjectGroup(group)) return;
            if (!group.archived && isProjectPinShortcut(event, keybindings)) {
              event.preventDefault();
              event.stopPropagation();
              toggleProjectGroupPin(group);
            } else if (isProjectArchiveShortcut(event, keybindings)) {
              event.preventDefault();
              event.stopPropagation();
              setProjectGroupArchived(group, !group.archived);
            }
          }}
        />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList>
          {(item: PickerItem) => {
            const entry = projectEntryByKey.get(item.value);
            return (
              <ComboboxItem
                key={item.value}
                hideIndicator
                value={item}
                className={TOUCH_MENU_ITEM_CLASS}
              >
                {item.value === ADD_PROJECT_VALUE ? (
                  <FolderPlusIcon className="size-4 shrink-0" />
                ) : entry ? (
                  <ProjectFavicon project={entry.group} className="size-4 shrink-0" />
                ) : null}
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 flex-1 text-sm" />}>
                    <DraftProjectName value={item.label} />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{item.label}</TooltipPopup>
                </Tooltip>
                {entry && !entry.group.archived && canPinProjectGroup(entry.group) ? (
                  <ProjectPinButton
                    name={entry.group.displayName}
                    pinned={entry.group.pinned}
                    shortcutLabel={shortcutLabelForCommand(keybindings, "thread.pin")}
                    onToggle={() => toggleProjectGroupPin(entry.group)}
                  />
                ) : null}
                {entry && canPinProjectGroup(entry.group) ? (
                  <ProjectArchiveButton
                    name={entry.group.displayName}
                    archived={entry.group.archived}
                    shortcutLabel={shortcutLabelForCommand(keybindings, "thread.settle")}
                    onToggle={() => setProjectGroupArchived(entry.group, !entry.group.archived)}
                  />
                ) : null}
                {entry && showProjectEnvironments ? (
                  <ProjectEnvironmentBadge
                    group={entry.group}
                    primaryEnvironmentId={primaryEnvironmentId}
                    machineByEnvironmentId={environmentMachineById}
                  />
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
        {hiddenArchivedCount > 0 ? (
          <div className="border-t p-1">
            <Button variant="ghost-muted" size="sm" onClick={() => setShowArchivedProjects(true)}>
              <ArchiveIcon />
              Show archived projects ({hiddenArchivedCount})
            </Button>
          </div>
        ) : null}
      </ComboboxPopup>
    </Combobox>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className={
        pillSelector
          ? PILL_SELECTOR_CLASS
          : "pointer-events-auto inline min-w-0 max-w-full cursor-pointer border-muted-foreground/35 border-b border-dotted text-muted-foreground/60 transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      }
    >
      {pillSelector ? (
        <>
          <FolderPlusIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{activeProjectTitle ?? "Add a project"}</span>
        </>
      ) : (
        <DraftProjectName value={activeProjectTitle ?? "Add a project"} singleLine />
      )}
    </button>
  );

  const noProjectShortcut = shortcutLabelForCommand(keybindings, "chat.newWithoutProject");
  const orStartWithoutProject =
    scratchWorkspaceRoot !== null && !isScratchDraft && (hasResolvedProject || canChooseProject) ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              tone="muted"
              className={cn(
                "pointer-events-auto",
                // A finger-sized hit area for the other way to start a chat.
                pillSelector && "min-h-12",
              )}
              onClick={() =>
                void startScratch().then((started) => {
                  if (started) {
                    document.querySelector<HTMLElement>("[data-draft-project-trigger]")?.focus();
                  }
                })
              }
            />
          }
        >
          or start without a project
        </TooltipTrigger>
        {noProjectShortcut ? <TooltipPopup side="bottom">{noProjectShortcut}</TooltipPopup> : null}
      </Tooltip>
    ) : null;

  if (isScratchDraft && isTriageDraftPrompt) {
    const environment = environments.find(
      (entry) => entry.environmentId === activeProject.environmentId,
    );
    return (
      <TriageDraftHero
        machineLabel={environment?.label ?? null}
        serverVersion={environment?.serverConfig?.environment.serverVersion ?? null}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      {hasResolvedProject && !isScratchDraft ? (
        <DraftHeroProjectHeading projectName={activeProjectTitle ?? "Choose a project"}>
          {projectSelector}
        </DraftHeroProjectHeading>
      ) : (
        // Drive density: a one-line caption so the composer and Speak button own the car's viewport.
        <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl drive:text-lg">
          {isScratchDraft ? (
            <>What should we work on?</>
          ) : canChooseProject ? (
            <>{projectSelector} to start</>
          ) : (
            <>Add a project to start</>
          )}
        </h1>
      )}
      {scratchWorkspaceRoot === null ? null : (
        <p
          className={cn(
            "mt-2 flex w-full items-center justify-center text-sm",
            // The pill / finger-sized link is taller than the inline line.
            pillSelector ? "min-h-14 touch:text-base drive:min-h-12 drive:text-sm" : "h-6",
          )}
        >
          {isScratchDraft ? projectSelector : orStartWithoutProject}
        </p>
      )}
    </div>
  );
}
