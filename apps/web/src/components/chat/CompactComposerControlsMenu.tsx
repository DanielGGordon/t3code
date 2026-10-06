import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { ChevronUpIcon, EllipsisIcon, PaperclipIcon } from "lucide-react";
import { cn } from "~/lib/utils";
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
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import { formatComposerInteractionModeLabel } from "./composerTouchLayout";

// Touch layout: every row in the popup (including the traits rows rendered by
// TraitsMenuContent) becomes a >=48px target.
const TOUCH_MENU_POPUP_CLASS_NAME =
  "touch:min-w-72 touch:[&_[data-slot=menu-item]]:min-h-12 touch:[&_[data-slot=menu-radio-item]]:min-h-12 touch:[&_[data-slot=menu-checkbox-item]]:min-h-12";
const SECTION_LABEL_CLASS_NAME =
  "px-2 py-1.5 font-medium text-muted-foreground text-xs touch:text-sm";

/**
 * The composer's folded controls: traits, interaction mode and access. Used
 * for whichever blocks the footer has no room for, and in the touch layout for
 * all of them, where it also takes "Attach files" and its trigger spells out
 * the current state (`summaryLabel`) instead of an ellipsis. Access changes
 * stay two taps deep (open, then pick).
 */
export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<{
    readonly mode: RuntimeMode;
    readonly label: string;
  }>;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  size?: "sm" | "xs";
  /**
   * The resting strip keeps this menu mounted out of flow while every block
   * fits inline. Its portaled popup would outlive that transition, so an
   * open menu closes when its trigger hides.
   */
  hidden?: boolean;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  /** Touch layout: a big labelled pill that opens upward. */
  touchLayout?: boolean;
  summaryLabel?: string | undefined;
  attachDisabled?: boolean;
  onAttach?: (() => void) | undefined;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const shortcut = props.traitsMenuContent ? "composer.mode composer.effort" : "composer.mode";

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          props.touchLayout ? (
            <ComposerTouchButton
              className="min-w-0 shrink justify-start px-4 text-base"
              aria-label={
                props.summaryLabel
                  ? `Composer controls: ${props.summaryLabel}`
                  : "More composer controls"
              }
              data-composer-shortcut={shortcut}
            />
          ) : (
            <ComposerControl
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
            <span className="min-w-0 truncate">{props.summaryLabel || "Controls"}</span>
            <ChevronUpIcon aria-hidden="true" className="size-5 shrink-0 opacity-60" />
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
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
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
            <MenuDivider />
          </>
        ) : null}
        <div className={SECTION_LABEL_CLASS_NAME}>Access</div>
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            if (!value || value === props.runtimeMode) return;
            props.onRuntimeModeChange(value as RuntimeMode);
          }}
        >
          {props.runtimeModeOptions.map((option) => (
            <MenuRadioItem key={option.mode} value={option.mode}>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {props.onAttach ? (
          <>
            <MenuDivider />
            <MenuItem disabled={props.attachDisabled ?? false} onClick={props.onAttach}>
              <PaperclipIcon className="size-4 shrink-0" />
              Attach files
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
