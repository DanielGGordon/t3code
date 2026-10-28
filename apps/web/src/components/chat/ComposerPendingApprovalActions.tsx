import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import { memo } from "react";
import { EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { Button, InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalActionsProps {
  presentation?: "composer" | "inline";
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  disabled?: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  /**
   * Touch layout: a big approve on the driver's (left) side and decline far
   * from it on the right, with the remaining decisions demoted to a smaller
   * secondary row (cancel stays small).
   */
  touchLayout?: boolean;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  presentation = "composer",
  requestId,
  isResponding,
  canRespond,
  disabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  touchLayout = false,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  if (touchLayout) {
    return (
      <TouchComposerPendingApprovalActions
        requestId={requestId}
        isResponding={isResponding}
        canRespond={canRespond}
        disabled={disabled}
        options={options}
        onRespondToApproval={onRespondToApproval}
      />
    );
  }

  const primaryOptions = options.filter(
    (option) => option.decision === "decline" || option.decision === "accept",
  );
  const moreOptions = options.filter(
    (option) => option.decision !== "decline" && option.decision !== "accept",
  );

  return (
    <>
      {primaryOptions.map((option) => {
        const buttonProps = {
          disabled: disabled || isResponding || !canRespond,
          "aria-description": option.warning,
          onClick: () => {
            if (!disabled && !isResponding && canRespond) {
              void onRespondToApproval(requestId, option.decision);
            }
          },
        };
        const content = (
          <>
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span className={presentation === "inline" ? "whitespace-normal" : "max-w-40 truncate"}>
              {option.label}
            </span>
          </>
        );
        const button =
          presentation === "inline" ? (
            <InlineButton
              key={option.decision}
              {...buttonProps}
              tone={option.decision === "accept" ? "default" : "muted"}
            >
              {content}
            </InlineButton>
          ) : (
            <Button
              key={option.decision}
              {...buttonProps}
              size="xs"
              variant={option.decision === "accept" ? "default" : "outline"}
            >
              {content}
            </Button>
          );
        return option.warning ? (
          <Tooltip key={option.decision}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top">{option.warning}</TooltipPopup>
          </Tooltip>
        ) : (
          button
        );
      })}
      {moreOptions.length > 0 ? (
        <Menu>
          <MenuTrigger
            disabled={disabled || isResponding || !canRespond}
            render={
              presentation === "inline" ? (
                <InlineButton tone="muted" aria-label="More approval options" />
              ) : (
                <Button size="icon-xs" variant="outline" aria-label="More approval options" />
              )
            }
          >
            {presentation === "inline" ? "More" : <EllipsisIcon />}
          </MenuTrigger>
          <MenuPopup {...composerFloatingLayerProps} side="top" align="end" width="content">
            {moreOptions.map((option) => {
              const item = (
                <MenuItem
                  key={option.decision}
                  disabled={disabled || isResponding || !canRespond}
                  aria-description={option.warning}
                  onClick={() => {
                    if (!disabled && !isResponding && canRespond)
                      void onRespondToApproval(requestId, option.decision);
                  }}
                >
                  {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
                  <span className="min-w-0 whitespace-normal wrap-break-word">{option.label}</span>
                </MenuItem>
              );
              return option.warning ? (
                <Tooltip key={option.decision}>
                  <TooltipTrigger render={item} />
                  <TooltipPopup side="top">{option.warning}</TooltipPopup>
                </Tooltip>
              ) : (
                item
              );
            })}
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
});

function TouchComposerPendingApprovalActions({
  requestId,
  isResponding,
  canRespond,
  disabled = false,
  options,
  onRespondToApproval,
}: Omit<ComposerPendingApprovalActionsProps, "touchLayout"> & {
  options: ReadonlyArray<ProviderApprovalOption>;
}) {
  const acceptOption = options.find((option) => option.decision === "accept");
  const declineOption = options.find((option) => option.decision === "decline");
  const cancelOption = options.find((option) => option.decision === "cancel");
  const alwaysOptions = options.filter(
    (option) => option.decision === "acceptForSession" || option.decision === "acceptAlways",
  );
  const optionProps = (option: ProviderApprovalOption) => ({
    "aria-description": option.warning,
    onClick: () => void onRespondToApproval(requestId, option.decision),
  });

  return (
    <div className="flex w-full min-w-0 flex-col gap-3" data-approval-actions="touch">
      <div className="flex items-center justify-between gap-6">
        {acceptOption ? (
          <Button
            size="2xl"
            variant="default"
            className="min-w-48"
            disabled={disabled || isResponding || !canRespond}
            {...optionProps(acceptOption)}
          >
            <TouchApprovalOptionLabel option={acceptOption} />
          </Button>
        ) : null}
        {declineOption ? (
          <Button
            size="2xl"
            variant="destructive-outline"
            className="ms-auto min-w-36"
            disabled={disabled || isResponding || !canRespond}
            {...optionProps(declineOption)}
          >
            <TouchApprovalOptionLabel option={declineOption} />
          </Button>
        ) : null}
      </div>
      {alwaysOptions.length > 0 || cancelOption ? (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            {alwaysOptions.map((option) => (
              <Button
                key={option.decision}
                size="xl"
                variant="outline"
                className="touch:h-12"
                // Matches the overflow menu outside the touch layout.
                disabled={disabled || isResponding}
                {...optionProps(option)}
              >
                <TouchApprovalOptionLabel option={option} />
              </Button>
            ))}
          </div>
          {cancelOption ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || isResponding}
              {...optionProps(cancelOption)}
            >
              <TouchApprovalOptionLabel option={cancelOption} />
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TouchApprovalOptionLabel({ option }: { option: ProviderApprovalOption }) {
  return (
    <>
      {option.warning ? <TriangleAlertIcon className="text-warning" /> : null}
      <span className="min-w-0 truncate">{option.label}</span>
    </>
  );
}
