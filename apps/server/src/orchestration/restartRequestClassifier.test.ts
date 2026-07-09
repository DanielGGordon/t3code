import { describe, expect, it } from "vite-plus/test";

import { classifyRestartRequest } from "./restartRequestClassifier.ts";

describe("classifyRestartRequest", () => {
  it("matches explicit requests to restart the server/service", () => {
    for (const text of [
      "Please restart the dev server so the new env var takes effect.",
      "Could you restart the backend? I changed the config.",
      "You'll need to restart the service for this to apply.",
      "This change requires a restart of the API process.",
      "The database connection is stale — restart the database and let me know.",
    ]) {
      expect(classifyRestartRequest(text).matched, text).toBe(true);
    }
  });

  it("extracts a best-effort target/reason", () => {
    expect(classifyRestartRequest("Please restart the dev server to pick up changes.").reason).toBe(
      "dev server",
    );
    expect(classifyRestartRequest("You need to restart the backend now.").reason).toBe("backend");
  });

  it("matches when negation appears in a separate clause from the restart verb", () => {
    for (const text of [
      "Not sure what went wrong, but please restart the server.",
      "I didn't change the config; restart the backend to pick up the fix.",
    ]) {
      expect(classifyRestartRequest(text).matched, text).toBe(true);
    }
  });

  it("ignores past-tense and negated mentions", () => {
    for (const text of [
      "I restarted the server for you, everything is back up.",
      "No need to restart the server — it hot-reloads automatically.",
      "You don't have to restart the service; the change is live.",
      "We've already restarted the backend.",
    ]) {
      expect(classifyRestartRequest(text).matched, text).toBe(false);
    }
  });

  it("ignores unrelated text", () => {
    expect(classifyRestartRequest("I refactored the auth module and added tests.").matched).toBe(
      false,
    );
    expect(classifyRestartRequest("").matched).toBe(false);
  });
});
