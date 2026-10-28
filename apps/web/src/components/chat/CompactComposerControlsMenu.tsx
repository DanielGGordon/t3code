import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode, useRef } from "react";
import { ChevronUpIcon, EllipsisIcon, HandIcon, PaperclipIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { openTouchGestures } from "../TouchGesturesDialog";
import { ComposerTouchButton } from "./ComposerTouchButton";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { focusRequestedPermission, useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import { formatComposerInteractionModeLabel } from "./composerTouchLayout";
import { ComposerPermissionsSection, type RuntimeModeOption } from "./ComposerFooterControls";

// Touch layout: every row in the popup (including the traits rows rendered by
// TraitsMenuContent) becomes a >=48px target.
const TOUCH_MENU_POPUP_CLASS_NAME =
  "touch:min-w-72 touch:[&_[data-slot=menu-item]]:min-h-12 touch:[&_[data-slot=menu-radio-item]]:min-h-12 touch:[&_[data-slot=menu-checkbox-item]]:min-h-12";
const SECTION_LABEL_CLASS_NAME =
  "px-2 py-1.5 font-medium text-muted-foreground text-xs touch:text-sm";

/**
 * Touch layout folds every control in here, plus "Attach files"; the trigger spells out
 * the state (`summaryLabel`), or is an ellipsis on a phone to keep the footer one row.
 * Permission changes stay two taps deep (open, then pick).
 */
export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  showPermissions?: boolean;
  size?: "sm" | "xs";
  /** Close the portaled popup when its trigger hides. */
  hidden?: boolean;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  /** Touch layout: a big labelled pill that opens upward. */
  touchLayout?: boolean;
  summaryLabel?: string | undefined;
  /** Phone footer: the model picker has no button of its own, so the menu opens it. */
  modelLabel?: string | null | undefined;
  onChooseModel?: (() => void) | undefined;
  attachDisabled?: boolean;
  onAttach?: (() => void) | undefined;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const shortcut =
    [
      props.showPermissions !== false ? "composer.mode" : null,
      props.traitsMenuContent ? "composer.effort" : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => focusRequestedPermission(isOpen, triggerRef.current)}
    >
      <MenuTrigger
        render={
          props.touchLayout ? (
            <ComposerTouchButton
              ref={triggerRef}
              className="min-w-0 shrink justify-start px-4 text-base short:size-11 short:justify-center short:border short:border-input short:bg-popover short:px-0 drive:size-11 drive:justify-center drive:border drive:border-input drive:bg-popover drive:px-0 max-md:size-11 max-md:justify-center max-md:border max-md:border-input max-md:bg-popover max-md:px-0"
              aria-label={
                props.summaryLabel
                  ? `Composer controls: ${props.summaryLabel}`
                  : "More composer controls"
              }
              data-composer-shortcut={shortcut}
            />
          ) : (
            <ComposerControl
              ref={triggerRef}
              size={size}
              className="shrink-0"
              aria-label="More composer controls"
              data-composer-shortcut={shortcut}
            />
          )
        }
      >
        {props.touchLayout ? (
          <>
            <span className="min-w-0 truncate max-md:hidden drive:hidden short:hidden">
              {props.summaryLabel || "Controls"}
            </span>
            <ChevronUpIcon
              aria-hidden="true"
              className="size-5 shrink-0 opacity-60 max-md:hidden drive:hidden short:hidden"
            />
            <EllipsisIcon
              aria-hidden="true"
              className="hidden max-md:block drive:block short:block"
            />
          </>
        ) : (
          <ComposerControlIcon icon={EllipsisIcon} size={size} />
        )}
      </MenuTrigger>
      <MenuPopup
        align="start"
        {...composerFloatingLayerProps}
        {...(props.touchLayout ? { side: "top" as const } : {})}
        className={cn(props.touchLayout && TOUCH_MENU_POPUP_CLASS_NAME)}
      >
        {props.onChooseModel ? (
          <>
            <MenuItem
              className="max-md:flex md:hidden drive:flex short:flex"
              onClick={props.onChooseModel}
            >
              <span className="min-w-0 flex-1 truncate">Model</span>
              {props.modelLabel ? (
                <span className="truncate text-muted-foreground">{props.modelLabel}</span>
              ) : null}
            </MenuItem>
            <MenuDivider className="md:hidden drive:block short:block" />
          </>
        ) : null}
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            {props.showInteractionModeToggle || props.showPermissions !== false ? (
              <MenuDivider />
            ) : null}
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className={SECTION_LABEL_CLASS_NAME}>Mode</div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onToggleInteractionMode();
              }}
            >
              <MenuRadioItem value="default">
                {props.touchLayout ? formatComposerInteractionModeLabel("default") : "Chat"}
              </MenuRadioItem>
              <MenuRadioItem value="plan">Plan</MenuRadioItem>
            </MenuRadioGroup>
            {props.showPermissions !== false ? <MenuDivider /> : null}
          </>
        ) : null}
        {props.showPermissions === false ? null : (
          <ComposerPermissionsSection
            runtimeMode={props.runtimeMode}
            runtimeModeOptions={props.runtimeModeOptions}
            onRuntimeModeChange={props.onRuntimeModeChange}
          />
        )}
        {props.onAttach ? (
          <>
            <MenuDivider />
            <MenuItem disabled={props.attachDisabled ?? false} onClick={props.onAttach}>
              <PaperclipIcon className="size-4 shrink-0" />
              Attach files
            </MenuItem>
          </>
        ) : null}
        {props.touchLayout ? (
          <>
            <MenuDivider />
            <MenuItem onClick={openTouchGestures}>
              <HandIcon className="size-4 shrink-0" />
              Gestures
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
