import { describe, expect, it } from "vite-plus/test";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import { isCrossOriginBrowserRequest, isSecureRequest } from "./browserOrigin.ts";

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

describe("isCrossOriginBrowserRequest", () => {
  const behindCaddy = (origin: string, port = "7443") =>
    request({
      host: "203.0.113.7",
      "x-forwarded-host": `203.0.113.7:${port}`,
      "x-forwarded-proto": "https",
      origin,
    });

  it("separates apps on the same IP by port", () => {
    expect(isCrossOriginBrowserRequest(behindCaddy("https://203.0.113.7:7443"), [])).toBe(false);
    expect(isCrossOriginBrowserRequest(behindCaddy("https://203.0.113.7:8443"), [])).toBe(true);
    expect(isCrossOriginBrowserRequest(behindCaddy("http://203.0.113.7:7443"), [])).toBe(true);
  });

  it("matches the default HTTPS port without an explicit port", () => {
    expect(isCrossOriginBrowserRequest(behindCaddy("https://203.0.113.7", "443"), [])).toBe(false);
  });

  it("rejects sibling subdomains, which share cookies' site", () => {
    const req = request({
      host: "t3.example.dev",
      "x-forwarded-proto": "https",
      origin: "https://alfred.example.dev",
    });
    expect(isCrossOriginBrowserRequest(req, [])).toBe(true);
  });

  it("accepts direct same-origin, allowlisted, and Origin-less requests", () => {
    expect(
      isCrossOriginBrowserRequest(
        request({ host: "localhost:3773", origin: "http://localhost:3773" }),
        [],
      ),
    ).toBe(false);
    expect(
      isCrossOriginBrowserRequest(
        request({ host: "localhost:3773", origin: "http://localhost:5733" }),
        ["http://localhost:5733"],
      ),
    ).toBe(false);
    expect(isCrossOriginBrowserRequest(request({ host: "localhost:3773" }), [])).toBe(false);
  });
});
