import {
  ActivityIcon,
  BellIcon,
  FileKeyIcon,
  GitBranchIcon,
  KeyboardIcon,
  SmartphoneIcon,
  TabletSmartphoneIcon,
  PlayIcon,
  ShieldIcon,
  SparklesIcon,
  SquareArrowOutUpRightIcon,
} from "lucide-react";
import { type ReactNode } from "react";
import {
  type ClientSettings,
  DEFAULT_HEADER_CONTROL_VISIBILITY,
  type HeaderControlVisibility,
  type SidebarHostStatsStyle,
} from "@t3tools/contracts/settings";

import { HOST_STATS_PICKER_STYLES, HOST_STATS_VARIANTS } from "../host-stats/variants";

import { useCondensedChrome } from "../../hooks/useTouchLayout";
import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { resolveHeaderControlVisibility } from "../../lib/headerControlVisibility";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

type HeaderControlSettingKey = Extract<
  keyof ClientSettings,
  | "headerGitActionsVisibility"
  | "headerOpenInEditorVisibility"
  | "headerProjectScriptsVisibility"
  | "headerNotificationsVisibility"
>;

const HEADER_CONTROL_ROWS: ReadonlyArray<{
  key: HeaderControlSettingKey;
  title: string;
  description: string;
  icon: ReactNode;
  /** Wording of the "auto" status; defaults to the condensed-chrome rule. */
  autoStatus?: string;
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
  {
    key: "headerNotificationsVisibility",
    title: "Notifications",
    description:
      "Bell with pending notifications from outside services, such as held messages awaiting approval.",
    icon: <BellIcon className="size-3.5" />,
    autoStatus: "Auto — shown only while a notification is open",
  },
];

function visibilityStatusLabel(visibility: HeaderControlVisibility, condensed: boolean): string {
  if (visibility === "auto") {
    return condensed
      ? "Auto — hidden on this device (phone / touch layout)"
      : "Auto — shown on this device (desktop)";
  }
  return visibility === "show" ? "Always shown on this device" : "Hidden on this device";
}

export function FeaturesSettingsPanel() {
  const condensed = useCondensedChrome();
  const settings = useClientSettings((s) => ({
    headerGitActionsVisibility: s.headerGitActionsVisibility,
    headerOpenInEditorVisibility: s.headerOpenInEditorVisibility,
    headerProjectScriptsVisibility: s.headerProjectScriptsVisibility,
    headerNotificationsVisibility: s.headerNotificationsVisibility,
    fileExplorerShowDotfiles: s.fileExplorerShowDotfiles,
    fileViewerOpenInEditorVisible: s.fileViewerOpenInEditorVisible,
    composerAutoRuntimeModeVisible: s.composerAutoRuntimeModeVisible,
    composerRuntimeModeVisible: s.composerRuntimeModeVisible,
    composerKeyboardOnDemand: s.composerKeyboardOnDemand,
    touchLayout: s.touchLayout,
    touchLayoutOnPhones: s.touchLayoutOnPhones,
    sidebarHostStatsVisible: s.sidebarHostStatsVisible,
    sidebarHostStatsStyle: s.sidebarHostStatsStyle,
  }));
  const updateSettings = updateClientSettings;

  return (
    <SettingsPageContainer>
      <p className="px-1 text-sm text-muted-foreground">
        Features added in DanielGGordon&apos;s fork of T3 Code. They are not part of upstream T3
        Code, and each one is stored on this device only.
      </p>
      <SettingsSection title="Header actions">
        {HEADER_CONTROL_ROWS.map((row) => {
          const visibility = settings[row.key];
          const effective = row.autoStatus
            ? visibility !== "hide"
            : resolveHeaderControlVisibility(visibility, condensed);
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
              status={
                row.autoStatus && visibility === "auto"
                  ? row.autoStatus
                  : visibilityStatusLabel(visibility, condensed)
              }
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
      <SettingsSection title="Composer">
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              <ShieldIcon className="size-3.5" />
              Access mode
            </span>
          }
          description="Show the access selector (“Full access”, “Supervised”) at the bottom of the composer. Hiding it only removes the button; the thread keeps its current mode, and the touch layout's controls menu still lists it. Stored on this device only."
          control={
            <Switch
              checked={settings.composerRuntimeModeVisible}
              onCheckedChange={(checked) => updateSettings({ composerRuntimeModeVisible: checked })}
              aria-label="Show the access mode in the composer"
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="Touch screens">
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              <TabletSmartphoneIcon className="size-3.5" />
              Touch / car layout
            </span>
          }
          description="Bigger buttons, a large mic on the left (driver side), rarely-changed composer controls folded into one menu, and swipe / press-and-hold gestures instead of small hover buttons. For a car display or tablet. Stored on this device only."
          control={
            <Switch
              checked={settings.touchLayout}
              onCheckedChange={(checked) => updateSettings({ touchLayout: checked })}
              aria-label="Use the touch / car layout on this device"
            />
          }
        />
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              <SmartphoneIcon className="size-3.5" />
              Touch layout on phones
            </span>
          }
          description="Phones get the touch layout automatically: bigger buttons, a tidier top bar, and gestures (two-finger swipes for new chats in your project slots, a three-finger tap for the project list, swipe and hold on chats; the full list is under the ⋯ menu in the composer). Turn this off to keep the regular layout on this phone. Stored on this device only."
          control={
            <Switch
              checked={settings.touchLayoutOnPhones}
              onCheckedChange={(checked) => updateSettings({ touchLayoutOnPhones: checked })}
              aria-label="Use the touch layout automatically on phones"
            />
          }
        />
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              <KeyboardIcon className="size-3.5" />
              Keyboard on demand
            </span>
          }
          description="Tapping the message box no longer opens the on-screen keyboard; a keyboard button next to the mic does. For touch screens you mostly dictate on. Stored on this device only."
          {...(settings.touchLayout ? { status: "On — implied by the touch / car layout" } : {})}
          control={
            <Switch
              checked={settings.composerKeyboardOnDemand || settings.touchLayout}
              disabled={settings.touchLayout}
              onCheckedChange={(checked) => updateSettings({ composerKeyboardOnDemand: checked })}
              aria-label="Open the on-screen keyboard only from the keyboard button"
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="File explorer">
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              <FileKeyIcon className="size-3.5" />
              Show dotfiles in the file explorer
            </span>
          }
          description="Show hidden files such as .env and .gitignore in the project tree."
          control={
            <Switch
              checked={settings.fileExplorerShowDotfiles}
              onCheckedChange={(checked) => updateSettings({ fileExplorerShowDotfiles: checked })}
              aria-label="Show dotfiles in the file explorer"
            />
          }
        />
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              <SquareArrowOutUpRightIcon className="size-3.5" />
              Open in editor button
            </span>
          }
          description="Show the button that opens the file you are viewing in a local editor such as VS Code or Zed. Turn it off if you never use it."
          control={
            <Switch
              checked={settings.fileViewerOpenInEditorVisible}
              onCheckedChange={(checked) =>
                updateSettings({ fileViewerOpenInEditorVisible: checked })
              }
              aria-label="Show the open in editor button in the file viewer"
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="Sidebar">
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              <SparklesIcon className="size-3.5" />
              Auto runtime mode
            </span>
          }
          description="Offer upstream's Auto access mode in the composer. An AI reviewer approves routine tool calls inside a workspace-write sandbox without asking you. Hidden by default: once a thread is set to Auto, older builds of the server can no longer read the thread list."
          control={
            <Switch
              checked={settings.composerAutoRuntimeModeVisible}
              onCheckedChange={(checked) =>
                updateSettings({ composerAutoRuntimeModeVisible: checked })
              }
              aria-label="Offer the Auto runtime mode in the composer"
            />
          }
        />
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              <ActivityIcon className="size-3.5" />
              Server load
            </span>
          }
          description="Show the T3 server host's CPU and memory usage next to Settings at the bottom of the sidebar. Refreshes every few seconds while visible."
          control={
            <Switch
              checked={settings.sidebarHostStatsVisible}
              onCheckedChange={(checked) => updateSettings({ sidebarHostStatsVisible: checked })}
              aria-label="Show server load in the sidebar"
            />
          }
        />
        <SettingsRow
          title="Server load style"
          description="Visual style of the server-load readout. Applies while “Server load” is on."
          control={
            <Select
              value={settings.sidebarHostStatsStyle}
              onValueChange={(value) => {
                updateSettings({ sidebarHostStatsStyle: value as SidebarHostStatsStyle });
              }}
            >
              <SelectTrigger className="w-full sm:w-48" aria-label="Server load style">
                <SelectValue>
                  {HOST_STATS_VARIANTS[settings.sidebarHostStatsStyle].label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {HOST_STATS_PICKER_STYLES.map((value) => (
                  <SelectItem hideIndicator key={value} value={value}>
                    {HOST_STATS_VARIANTS[value].label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
      <p className="px-1 text-xs text-muted-foreground/70">
        Visibility is stored per device. “Auto” shows a control on desktop-width screens and hides
        it on phones and in the touch / car layout. Toggling the switch pins it on or off for this
        device; use the reset arrow to return to Auto.
      </p>
    </SettingsPageContainer>
  );
}
