import type * as HttpServerRequest from "effect/http/HttpServerRequest";

const firstHeaderValue = (value: string | undefined) => value?.split(",")[0]?.trim() || undefined;

/**
 * Whether the browser reached this server over HTTPS. The server itself speaks
 * plain HTTP behind a TLS-terminating proxy, so this trusts the proxy's
 * `X-Forwarded-Proto`. A forged value only changes whether the session cookie
 * is marked `Secure`.
 *
 * Fork (#65). The same-origin check for cookie sessions that lived here is now
 * upstream's `isBrowserOriginAllowed` in EnvironmentAuth.ts, which covers
 * WebSocket upgrades and HTTP requests alike.
 */
export const isSecureRequest = (request: HttpServerRequest.HttpServerRequest): boolean =>
  firstHeaderValue(request.headers["x-forwarded-proto"])?.toLowerCase() === "https";
