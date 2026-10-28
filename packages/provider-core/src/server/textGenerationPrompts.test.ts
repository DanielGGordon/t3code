import { describe, expect, it } from "vite-plus/test";

import {
  cleanThreadTitleSeed,
  isUsableThreadTitle,
  MAX_THREAD_TITLE_CHARS,
  normalizeCliError,
  sanitizeThreadTitle,
} from "./textGenerationUtils.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("sanitizeThreadTitle", () => {
  it("cuts long titles at a word boundary to fit the sidebar", () => {
    const title = sanitizeThreadTitle(
      '  "Reconnect failures after restart because the session state does not recover"  ',
    );
    expect(title).toBe("Reconnect failures after restart because");
    expect(title.length).toBeLessThanOrEqual(MAX_THREAD_TITLE_CHARS);
  });

  it("hard-cuts a long title with no usable word boundary", () => {
    expect(sanitizeThreadTitle("x".repeat(80))).toBe("x".repeat(MAX_THREAD_TITLE_CHARS));
  });
});

describe("isUsableThreadTitle", () => {
  it.each(["Slack Context Size Warning (200k)", "Fix Project Delete With Archived Chats"])(
    "accepts a normal title: %s",
    (title) => {
      expect(isUsableThreadTitle(title)).toBe(true);
    },
  );

  it.each([
    "",
    "New thread",
    "$backlog-grab",
    "/compact the thread",
    "#jootopia: buy the yeshiva",
    "Slack: tell me what",
    "<@U0BDHRS3TEV> booking is down",
    "<<<EXTERNAL_UNTRUSTED_CONTENT source='slack'>>>",
  ])("rejects structural garbage: %s", (title) => {
    expect(isUsableThreadTitle(title)).toBe(false);
  });
});

describe("cleanThreadTitleSeed", () => {
  it("strips bridge markup from a Slack opener", () => {
    expect(
      cleanThreadTitleSeed(
        "<<<EXTERNAL_UNTRUSTED_CONTENT source='slack' user='U0AES282YF2'>>>\n<@U0BDHRS3TEV> let's make buying the Yeshiva more expensive",
      ),
    ).toBe("let's make buying the Yeshiva more");
    expect(cleanThreadTitleSeed("#jootopia: &lt;@U0BDHRS3TEV&gt; raise the price")).toBe(
      "raise the price",
    );
    expect(cleanThreadTitleSeed("Slack: <@U0BDHRS3TEV> Hi there")).toBe("Hi there");
  });

  it("falls back to the placeholder when nothing is left", () => {
    expect(cleanThreadTitleSeed("<@U0BDHRS3TEV>")).toBe("New thread");
  });
});
