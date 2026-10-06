import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import { memo } from "react";
import { EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalActionsProps {
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
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
  requestId,
  isResponding,
  canRespond,
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
        const button = (
          <Button
            key={option.decision}
            size="xs"
            variant={option.decision === "accept" ? "default" : "outline"}
            disabled={isResponding || !canRespond}
            aria-description={option.warning}
            onClick={() => void onRespondToApproval(requestId, option.decision)}
          >
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span className="max-w-40 truncate">{option.label}</span>
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
            disabled={isResponding}
            render={<Button size="icon-xs" variant="outline" aria-label="More approval options" />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup {...composerFloatingLayerProps} side="top" align="end">
            {moreOptions.map((option) => {
              const item = (
                <MenuItem
                  key={option.decision}
                  disabled={isResponding}
                  aria-description={option.warning}
                  onClick={() => void onRespondToApproval(requestId, option.decision)}
                  variant="ghost"
                  className="mb-1 last:mb-0"
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
            disabled={isResponding || !canRespond}
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
            disabled={isResponding || !canRespond}
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
                disabled={isResponding}
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
              disabled={isResponding}
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
