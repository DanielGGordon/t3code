import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { resolveYoutubeApiKey } from "./ytcomments.ts";

function profile(contents: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ytcomments-"));
  const file = NodePath.join(dir, ".profile");
  NodeFS.writeFileSync(file, contents);
  return file;
}

describe("resolveYoutubeApiKey", () => {
  it("prefers the environment", () => {
    expect(
      resolveYoutubeApiKey({ YOUTUBE_API_KEY: " from-env " }, profile("YOUTUBE_API_KEY=file")),
    ).toBe("from-env");
  });

  it("reads an un-exported assignment from the profile", () => {
    expect(resolveYoutubeApiKey({}, profile("FOO=1\nYOUTUBE_API_KEY=abc123\n"))).toBe("abc123");
  });

  it("is undefined without a key or a profile", () => {
    expect(resolveYoutubeApiKey({}, profile("FOO=1\n"))).toBeUndefined();
    expect(resolveYoutubeApiKey({}, "/nonexistent/.profile")).toBeUndefined();
  });
});
