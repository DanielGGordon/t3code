import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { ChevronUpIcon, EllipsisIcon, ImagePlusIcon, ListTodoIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { formatComposerInteractionModeLabel } from "./composerTouchLayout";

// Touch layout: every row in the popup (including the traits rows rendered by
// TraitsMenuContent) becomes a >=48px target with readable text.
const TOUCH_MENU_POPUP_CLASS_NAME =
  "touch:min-w-64 touch:[&_[data-slot=menu-item]]:min-h-12 touch:[&_[data-slot=menu-item]]:text-base touch:[&_[data-slot=menu-radio-item]]:min-h-12 touch:[&_[data-slot=menu-radio-item]]:text-base";
const SECTION_LABEL_CLASS_NAME =
  "px-2 py-1.5 font-medium text-muted-foreground text-xs touch:text-sm";

/**
 * The composer's folded controls: traits, interaction mode, access and the
 * plan sidebar. Used when the footer is narrow, and always in the touch / car
 * layout, where it also takes "Attach image" and its trigger spells out the
 * current state (`summaryLabel`) instead of an ellipsis. Access changes stay
 * two taps deep (open, then pick).
 */
export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  touchLayout?: boolean;
  summaryLabel?: string | undefined;
  attachImageDisabled?: boolean;
  onAttachImage?: () => void;
  interactionMode: ProviderInteractionMode;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  showAutoRuntimeMode: boolean;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          props.touchLayout ? (
            <Button
              size="2xl"
              variant="ghost"
              className="min-w-0 shrink justify-start rounded-full px-4 text-base text-muted-foreground hover:text-foreground sm:text-base"
              aria-label={
                props.summaryLabel
                  ? `Composer controls: ${props.summaryLabel}`
                  : "More composer controls"
              }
            />
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
              aria-label="More composer controls"
            />
          )
        }
      >
        {props.touchLayout ? (
          <>
            <span className="min-w-0 truncate">{props.summaryLabel || "Controls"}</span>
            <ChevronUpIcon aria-hidden="true" className="size-4 shrink-0 opacity-60" />
          </>
        ) : (
          <EllipsisIcon aria-hidden="true" className="size-4" />
        )}
      </MenuTrigger>
      <MenuPopup
        align="start"
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
          <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
          <MenuRadioItem value="auto-accept-edits">Auto-accept edits</MenuRadioItem>
          {props.showAutoRuntimeMode || props.runtimeMode === "auto" ? (
            <MenuRadioItem value="auto">Auto</MenuRadioItem>
          ) : null}
          <MenuRadioItem value="full-access">Full access</MenuRadioItem>
        </MenuRadioGroup>
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen
                ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
                : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`}
            </MenuItem>
          </>
        ) : null}
        {props.onAttachImage ? (
          <>
            <MenuDivider />
            <MenuItem disabled={props.attachImageDisabled ?? false} onClick={props.onAttachImage}>
              <ImagePlusIcon className="size-4 shrink-0" />
              Attach image
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
