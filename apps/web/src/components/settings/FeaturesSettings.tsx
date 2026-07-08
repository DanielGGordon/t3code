import { GitBranchIcon, PlayIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { type ReactNode } from "react";
import {
  type ClientSettings,
  DEFAULT_HEADER_CONTROL_VISIBILITY,
  type HeaderControlVisibility,
} from "@t3tools/contracts/settings";

import { useIsMobile } from "../../hooks/useMediaQuery";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { resolveHeaderControlVisibility } from "../chat/ChatHeader";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

type HeaderControlSettingKey = Extract<
  keyof ClientSettings,
  "headerGitActionsVisibility" | "headerOpenInEditorVisibility" | "headerProjectScriptsVisibility"
>;

const HEADER_CONTROL_ROWS: ReadonlyArray<{
  key: HeaderControlSettingKey;
  title: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    key: "headerGitActionsVisibility",
    title: "Git actions",
    description: "Commit, branch, and pull-request actions for the active project.",
    icon: <GitBranchIcon className="size-3.5" />,
  },
  {
    key: "headerOpenInEditorVisibility",
    title: "Open in editor",
    description:
      "Open the project in a local editor such as Zed or VS Code. Only useful when T3 Code runs on the machine you are sitting at.",
    icon: <SquareArrowOutUpRightIcon className="size-3.5" />,
  },
  {
    key: "headerProjectScriptsVisibility",
    title: "Project scripts",
    description: "Run and manage project scripts (the “Add Action” control).",
    icon: <PlayIcon className="size-3.5" />,
  },
];

function visibilityStatusLabel(visibility: HeaderControlVisibility, isMobile: boolean): string {
  if (visibility === "auto") {
    return isMobile
      ? "Auto — hidden on this device (mobile)"
      : "Auto — shown on this device (desktop)";
  }
  return visibility === "show" ? "Always shown on this device" : "Hidden on this device";
}

export function FeaturesSettingsPanel() {
  const isMobile = useIsMobile();
  const settings = useClientSettings((s) => ({
    headerGitActionsVisibility: s.headerGitActionsVisibility,
    headerOpenInEditorVisibility: s.headerOpenInEditorVisibility,
    headerProjectScriptsVisibility: s.headerProjectScriptsVisibility,
  }));
  const updateSettings = useUpdateClientSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Header actions">
        {HEADER_CONTROL_ROWS.map((row) => {
          const visibility = settings[row.key];
          const effective = resolveHeaderControlVisibility(visibility, isMobile);
          return (
            <SettingsRow
              key={row.key}
              title={
                <span className="inline-flex items-center gap-1.5">
                  {row.icon}
                  {row.title}
                </span>
              }
              description={row.description}
              status={visibilityStatusLabel(visibility, isMobile)}
              resetAction={
                visibility !== DEFAULT_HEADER_CONTROL_VISIBILITY ? (
                  <SettingResetButton
                    label={`${row.title} visibility`}
                    onClick={() => updateSettings({ [row.key]: DEFAULT_HEADER_CONTROL_VISIBILITY })}
                  />
                ) : null
              }
              control={
                <Switch
                  checked={effective}
                  onCheckedChange={(checked) =>
                    updateSettings({ [row.key]: checked ? "show" : "hide" })
                  }
                  aria-label={`Show ${row.title} in the chat header`}
                />
              }
            />
          );
        })}
      </SettingsSection>
      <p className="px-1 text-xs text-muted-foreground/70">
        Visibility is stored per device. “Auto” shows a control on desktop-width screens and hides
        it on mobile. Toggling the switch pins it on or off for this device; use the reset arrow to
        return to Auto.
      </p>
    </SettingsPageContainer>
  );
}
