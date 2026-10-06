import { RuntimeRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

describe("ComposerPendingApprovalActions", () => {
  it("keeps the main decisions visible and secondary decisions in the menu", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={RuntimeRequestId.make("approval-1")}
        canRespond
        isResponding={false}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain(">Decline<");
    expect(markup).toContain(">Approve<");
    expect(markup).not.toContain(">Cancel<");
    expect(markup).not.toContain("Always allow this session");
  });

  it("keeps secondary provider labels out of the compact action row", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={RuntimeRequestId.make("approval-safari")}
        canRespond
        isResponding={false}
        options={[
          { decision: "decline", label: "Decline" },
          { decision: "acceptAlways", label: "Always allow Safari" },
          { decision: "accept", label: "Approve" },
        ]}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).not.toContain("Always allow Safari");
    expect(markup).toContain(">Approve<");
    expect(markup).not.toContain("Always allow this session");
  });

  it("preserves provider labels for the main decisions", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={RuntimeRequestId.make("approval-1")}
        canRespond
        isResponding={false}
        options={[
          { decision: "accept", label: "Allow once" },
          { decision: "decline", label: "Deny" },
        ]}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain("Allow once");
    expect(markup).toContain("Deny");
    expect(markup).not.toContain(">Approve<");
    expect(markup).not.toContain(">Decline<");
  });

  it("puts approve on the driver side and demotes the rest in the touch layout", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={RuntimeRequestId.make("approval-touch")}
        canRespond
        isResponding={false}
        touchLayout
        onRespondToApproval={async () => undefined}
      />,
    );
    const labels = [">Approve<", ">Decline<", ">Always allow this session<", ">Cancel<"];

    expect(markup).toContain('data-approval-actions="touch"');
    expect(markup).not.toContain("More approval options");
    expect(labels.map((label) => markup.indexOf(label))).toEqual(
      labels.map((label) => markup.indexOf(label)).toSorted((left, right) => left - right),
    );
    expect(labels.every((label) => markup.includes(label))).toBe(true);
    const buttonFor = (label: string) =>
      markup.slice(markup.lastIndexOf("<button", markup.indexOf(label)), markup.indexOf(label));
    // The primary row is 56px; cancel stays small.
    expect(buttonFor(">Approve<")).toContain("h-14");
    expect(buttonFor(">Decline<")).toContain("h-14");
    expect(buttonFor(">Cancel<")).not.toContain("h-14");
  });
});
