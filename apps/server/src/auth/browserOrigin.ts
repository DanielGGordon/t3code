import type * as HttpServerRequest from "effect/http/HttpServerRequest";

/** Custom-protocol origins of the Electron renderer (packaged and dev). */
export const DESKTOP_RENDERER_ORIGINS: ReadonlyArray<string> = ["t3code://app", "t3code-dev://app"];

const firstHeaderValue = (value: string | undefined) => value?.split(",")[0]?.trim() || undefined;

/**
 * Whether the browser reached this server over HTTPS. The server itself speaks
 * plain HTTP behind a TLS-terminating proxy, so this trusts the proxy's
 * `X-Forwarded-Proto`. A forged value only changes whether the session cookie
 * is marked `Secure`.
 */
export const isSecureRequest = (request: HttpServerRequest.HttpServerRequest): boolean =>
  firstHeaderValue(request.headers["x-forwarded-proto"])?.toLowerCase() === "https";

/**
 * The origin the browser used to reach this server. Proxies that rewrite
 * `Host` (Caddy's `header_up Host {host}` drops the port) still forward the
 * original in `X-Forwarded-Host`, and the port is what separates this origin
 * from other apps on the same IP.
 */
const requestOrigin = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
  const host = firstHeaderValue(request.headers["x-forwarded-host"]) ?? request.headers.host;
  if (!host) return undefined;
  try {
    return new URL(`${isSecureRequest(request) ? "https" : "http"}://${host}`).origin;
  } catch {
    return undefined;
  }
};

/**
 * Whether a browser on another origin initiated this request. Cookies are scoped
 * by host, not port or subdomain, so any page on the same IP (or a sibling
 * subdomain) can open a WebSocket that carries the session cookie. A request
 * without `Origin` is not from a browser page and is never cross-origin here.
 */
export const isCrossOriginBrowserRequest = (
  request: HttpServerRequest.HttpServerRequest,
  allowedOrigins: ReadonlyArray<string>,
): boolean => {
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  return origin !== requestOrigin(request) && !allowedOrigins.includes(origin);
};
