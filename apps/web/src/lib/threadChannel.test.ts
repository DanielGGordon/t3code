import { describe, expect, it } from "vite-plus/test";

import { getThreadChannel, stripThreadChannelPrefix } from "./threadChannel";

describe("getThreadChannel", () => {
  it("detects a Slack: prefix case-insensitively", () => {
    expect(getThreadChannel("Slack: Can you look at the errors?")).toBe("slack");
    expect(getThreadChannel("slack: lower")).toBe("slack");
    expect(getThreadChannel("  SLACK : spaced")).toBe("slack");
  });

  it("detects a bridged thread by its id once the title has no prefix", () => {
    expect(getThreadChannel("Raise Yeshiva buy cost", "slack-C0BDDUX2BGW-1792361")).toBe("slack");
    expect(getThreadChannel("Raise Yeshiva buy cost", "458861f1-bb90-46a6")).toBeNull();
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

  it("removes a #channel prefix", () => {
    expect(stripThreadChannelPrefix("#jootopia: raise the price")).toBe("raise the price");
  });

  it("keeps the original title when only the prefix is present", () => {
    expect(stripThreadChannelPrefix("Slack:")).toBe("Slack:");
  });

  it("leaves non-channel titles untouched", () => {
    expect(stripThreadChannelPrefix("Fix booking status")).toBe("Fix booking status");
  });
});
