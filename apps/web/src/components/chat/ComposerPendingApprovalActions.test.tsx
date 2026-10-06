import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

const LABELS = ["Cancel turn", "Decline", "Always allow this session", "Approve once"];

function renderActions(touchLayout: boolean) {
  return renderToStaticMarkup(
    <ComposerPendingApprovalActions
      requestId={ApprovalRequestId.make("approval-1")}
      isResponding={false}
      touchLayout={touchLayout}
      onRespondToApproval={async () => undefined}
    />,
  );
}

function labelOrder(markup: string) {
  return LABELS.toSorted((left, right) => markup.indexOf(left) - markup.indexOf(right));
}

describe("ComposerPendingApprovalActions", () => {
  it("keeps the default single-row order outside the touch layout", () => {
    const markup = renderActions(false);
    expect(labelOrder(markup)).toEqual(LABELS);
    expect(markup).not.toContain('data-approval-actions="touch"');
  });

  it("puts Approve once on the driver side and demotes secondary actions in the touch layout", () => {
    const markup = renderActions(true);
    expect(markup).toContain('data-approval-actions="touch"');
    expect(labelOrder(markup)).toEqual([
      "Approve once",
      "Decline",
      "Always allow this session",
      "Cancel turn",
    ]);
    // The primary row is 56px; Cancel turn stays small.
    const cancelButton = markup.slice(markup.lastIndexOf("<button", markup.indexOf("Cancel turn")));
    expect(cancelButton).not.toContain("h-14");
    const approveButton = markup.slice(
      markup.lastIndexOf("<button", markup.indexOf("Approve once")),
      markup.indexOf("Approve once"),
    );
    expect(approveButton).toContain("h-14");
  });
});
