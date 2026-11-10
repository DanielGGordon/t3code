import type { EnvironmentId, RuntimeMode } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";

import { useClientSettings } from "../hooks/useSettings";
import { shortcutLabelForCommand } from "../keybindings";
import { useManagedPolicy } from "../state/managedPolicy";
import { primaryServerKeybindingsAtom } from "../state/server";
import { ComposerControl } from "./chat/ComposerControl";
import { ComposerPermissionsSection } from "./chat/ComposerFooterControls";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  filterAutoRuntimeModeOption,
  resolveCompatibleRuntimeMode,
  resolveRuntimeModeOptions,
  runtimeModeConfig,
} from "./chat/runtimeModeConfig";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Menu, MenuPopup, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ComposerContextPermissions(props: {
  environmentId: EnvironmentId | null;
  runtimeMode: RuntimeMode;
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.mode",
  );
  const { mode, modes } = resolveCompatibleRuntimeMode(
    props.runtimeMode,
    props.supportedRuntimeModes,
  );
  const autoVisible = useClientSettings((s) => s.composerAutoRuntimeModeVisible);
  const options = filterAutoRuntimeModeOption(
    resolveRuntimeModeOptions(modes, useManagedPolicy(props.environmentId)),
    autoVisible,
    mode,
  );
  const composerMenuProps = useComposerMenuProps();
  const { icon: Icon, label } = runtimeModeConfig[mode];
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  size="xs"
                  className="ms-auto min-w-0 shrink-0"
                  aria-label={`Permissions: ${label}`}
                  data-composer-context-control
                />
              }
            />
          }
        >
          <Icon aria-hidden="true" className="size-3" />
          <ComposerContextLabel>{label}</ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>Permissions{shortcutLabel ? ` · ${shortcutLabel}` : null}</TooltipPopup>
      </Tooltip>
      <MenuPopup side="top" align="end" {...composerMenuProps}>
        <ComposerPermissionsSection
          runtimeMode={mode}
          runtimeModeOptions={options}
          onRuntimeModeChange={props.onRuntimeModeChange}
        />
      </MenuPopup>
    </Menu>
  );
}
