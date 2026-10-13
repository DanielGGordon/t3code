import { describe, expect, it } from "vite-plus/test";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import { isSecureRequest } from "./browserOrigin.ts";

const request = (headers: Record<string, string>) =>
  ({ headers }) as unknown as HttpServerRequest.HttpServerRequest;

describe("isSecureRequest", () => {
  it("trusts the proxy's first X-Forwarded-Proto", () => {
    expect(isSecureRequest(request({ "x-forwarded-proto": "https" }))).toBe(true);
    expect(isSecureRequest(request({ "x-forwarded-proto": "https, http" }))).toBe(true);
    expect(isSecureRequest(request({ "x-forwarded-proto": "http" }))).toBe(false);
    expect(isSecureRequest(request({}))).toBe(false);
  });
});
