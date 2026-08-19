import { describe, expect, it } from "vite-plus/test";

import { getThreadChannel, stripThreadChannelPrefix } from "./threadChannel";

describe("getThreadChannel", () => {
  it("detects a Slack: prefix case-insensitively", () => {
    expect(getThreadChannel("Slack: Can you look at the errors?")).toBe("slack");
    expect(getThreadChannel("slack: lower")).toBe("slack");
    expect(getThreadChannel("  SLACK : spaced")).toBe("slack");
  });

  it("ignores titles that merely mention Slack", () => {
    expect(getThreadChannel("Add Slack: integration")).toBeNull();
    expect(getThreadChannel("Slackline tricks")).toBeNull();
    expect(getThreadChannel("")).toBeNull();
    expect(getThreadChannel(null)).toBeNull();
  });
});

describe("stripThreadChannelPrefix", () => {
  it("removes the prefix and leading whitespace", () => {
    expect(stripThreadChannelPrefix("Slack: Can you look?")).toBe("Can you look?");
  });

  it("keeps the original title when only the prefix is present", () => {
    expect(stripThreadChannelPrefix("Slack:")).toBe("Slack:");
  });

  it("leaves non-channel titles untouched", () => {
    expect(stripThreadChannelPrefix("Fix booking status")).toBe("Fix booking status");
  });
});
