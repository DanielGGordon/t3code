import type * as HttpServerRequest from "effect/http/HttpServerRequest";

const firstHeaderValue = (value: string | undefined) => value?.split(",")[0]?.trim() || undefined;

/**
 * Whether the browser reached this server over HTTPS: trusts the TLS-terminating proxy's
 * `X-Forwarded-Proto`; a forged value only changes whether the session cookie is `Secure`.
 * Fork (#65): the same-origin check now lives upstream (`isBrowserOriginAllowed`, EnvironmentAuth.ts).
 */
export const isSecureRequest = (request: HttpServerRequest.HttpServerRequest): boolean =>
  firstHeaderValue(request.headers["x-forwarded-proto"])?.toLowerCase() === "https";
