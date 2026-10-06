import { type ApprovalRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { memo } from "react";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  /**
   * Touch / car layout: big "Approve once" on the driver's (left) side and
   * "Decline" far from it on the right, with "Always allow this session" and
   * "Cancel turn" demoted to a smaller secondary row.
   */
  touchLayout?: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  touchLayout = false,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const respond = (decision: ProviderApprovalDecision) => () =>
    void onRespondToApproval(requestId, decision);

  if (touchLayout) {
    return (
      <div className="flex w-full flex-col gap-3" data-approval-actions="touch">
        <div className="flex items-center justify-between gap-6">
          <Button
            size="2xl"
            variant="default"
            className="min-w-48"
            disabled={isResponding}
            onClick={respond("accept")}
          >
            Approve once
          </Button>
          <Button
            size="2xl"
            variant="destructive-outline"
            className="min-w-36"
            disabled={isResponding}
            onClick={respond("decline")}
          >
            Decline
          </Button>
        </div>
        <div className="flex items-center justify-between gap-6">
          <Button
            size="lg"
            variant="outline"
            disabled={isResponding}
            onClick={respond("acceptForSession")}
          >
            Always allow this session
          </Button>
          <Button size="sm" variant="ghost" disabled={isResponding} onClick={respond("cancel")}>
            Cancel turn
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <Button size="sm" variant="ghost" disabled={isResponding} onClick={respond("cancel")}>
        Cancel turn
      </Button>
      <Button
        size="sm"
        variant="destructive-outline"
        disabled={isResponding}
        onClick={respond("decline")}
      >
        Decline
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={isResponding}
        onClick={respond("acceptForSession")}
      >
        Always allow this session
      </Button>
      <Button size="sm" variant="default" disabled={isResponding} onClick={respond("accept")}>
        Approve once
      </Button>
    </>
  );
});
