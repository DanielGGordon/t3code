import {
  NEW_THREAD_PROJECT_SLOTS,
  type KeybindingCommand,
  type NewThreadProjectSlot,
  type ProjectId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { shortcutLabelForCommand } from "../../keybindings";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const UNASSIGNED = "";

/**
 * Picks the project each "New Thread in Project Slot N" shortcut opens. Slots
 * hold primary-environment project ids, matching where keybindings live.
 */
export function NewThreadProjectSlotsSettings({
  keybindings,
}: {
  readonly keybindings: ResolvedKeybindingsConfig;
}) {
  const slots = usePrimarySettings((settings) => settings.newThreadProjectSlots);
  const updateSettings = useUpdatePrimarySettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects
        .filter(
          (project) => project.environmentId === primaryEnvironmentId && project.isScratch !== true,
        )
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [allProjects, primaryEnvironmentId],
  );
  if (primaryEnvironmentId === null) return null;

  return (
    <SettingsSection title="Project shortcuts">
      {NEW_THREAD_PROJECT_SLOTS.map((slot: NewThreadProjectSlot) => {
        const command: KeybindingCommand = `chat.newInProject.${slot}`;
        const shortcut = shortcutLabelForCommand(keybindings, command);
        const projectId = slots[slot] ?? null;
        const missing = projectId !== null && !projects.some((project) => project.id === projectId);
        return (
          <SettingsRow
            key={slot}
            title={`Project slot ${slot}`}
            description={
              shortcut
                ? `${shortcut} starts a new thread in this project.`
                : `Bind "New Thread in Project Slot ${slot}" below to use it.`
            }
            control={
              <Select
                value={projectId ?? UNASSIGNED}
                onValueChange={(value) => {
                  updateSettings({
                    newThreadProjectSlots: {
                      [slot]: value === UNASSIGNED || value === null ? null : (value as ProjectId),
                    },
                  });
                }}
              >
                <SelectTrigger size="sm" aria-label={`Project slot ${slot}`}>
                  <SelectValue>
                    {(value: string | null) =>
                      !value
                        ? "None"
                        : missing
                          ? "Missing project"
                          : (projects.find((project) => project.id === value)?.title ?? "None")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={UNASSIGNED}>None</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        );
      })}
    </SettingsSection>
  );
}
