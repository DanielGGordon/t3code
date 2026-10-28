import { describe, expect, it } from "vite-plus/test";

import {
  deriveAuthClientMetadata,
  resolveClientIpAddress,
  resolveSessionCookieName,
} from "./utils.ts";

const requestFrom = (remoteAddress: string, headers: Record<string, string> = {}) =>
  ({ headers, source: { socket: { remoteAddress } } }) as never;

describe("resolveClientIpAddress", () => {
  it("takes the client from the local reverse proxy's X-Real-IP", () => {
    expect(
      resolveClientIpAddress(
        requestFrom("::ffff:127.0.0.1", {
          "x-real-ip": "203.0.113.7",
          "x-forwarded-for": "198.51.100.1",
        }),
      ),
    ).toBe("203.0.113.7");
  });

  it("falls back to the right-most X-Forwarded-For entry, which the proxy appended", () => {
    expect(
      resolveClientIpAddress(
        requestFrom("::1", { "x-forwarded-for": "10.9.9.9, 198.51.100.4 , 203.0.113.9" }),
      ),
    ).toBe("203.0.113.9");
  });

  it("uses the loopback peer itself when no proxy header is present", () => {
    expect(resolveClientIpAddress(requestFrom("127.0.0.1"))).toBe("127.0.0.1");
  });

  it("skips a forwarding header that is not an address", () => {
    expect(
      resolveClientIpAddress(
        requestFrom("127.0.0.1", {
          "x-real-ip": "<!channel>",
          "x-forwarded-for": "198.51.100.4, unknown",
        }),
      ),
    ).toBe("127.0.0.1");
  });

  it("ignores forwarding headers from a non-loopback peer", () => {
    expect(
      resolveClientIpAddress(
        requestFrom("::ffff:192.168.1.20", {
          "x-real-ip": "127.0.0.1",
          "x-forwarded-for": "127.0.0.1",
        }),
      ),
    ).toBe("192.168.1.20");
  });
});

describe("deriveAuthClientMetadata", () => {
  it("labels Electron user agents as Electron instead of Chrome", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) t3code/0.0.15 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36",
        },
        source: {
          remoteAddress: "::ffff:127.0.0.1",
        },
      } as never,
    });

    expect(metadata).toMatchObject({
      browser: "Electron",
      deviceType: "desktop",
      ipAddress: "127.0.0.1",
      os: "macOS",
    });
  });

  it("applies client-presented display identity without replacing transport metadata", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36",
        },
        source: {
          remoteAddress: "::ffff:192.168.213.72",
        },
      } as never,
      presented: {
        label: "T3 Code Mobile",
        deviceType: "mobile",
        os: "iOS",
      },
    });

    expect(metadata).toMatchObject({
      label: "T3 Code Mobile",
      browser: "Electron",
      deviceType: "mobile",
      ipAddress: "192.168.213.72",
      os: "iOS",
    });
    expect(metadata.userAgent).toContain("Electron/36.3.2");
  });
});

describe("session cookie isolation", () => {
  it("isolates loopback web servers by port and server state", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "127.0.0.1",
      instanceKey: "/tmp/t3-agent-one",
      environmentId: "environment-one",
      development: true,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "127.0.0.1",
      instanceKey: "/tmp/t3-agent-two",
      environmentId: "environment-two",
      development: true,
    });

    expect(first).toMatch(/^t3_session_5775_[a-f0-9]{12}$/);
    expect(second).toMatch(/^t3_session_5775_[a-f0-9]{12}$/);
    expect(first).not.toBe(second);
  });

  // regression: #8085 isolate remote web session cookies
  it("isolates remote web servers by server state", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 3773,
      host: "192.168.1.50",
      instanceKey: "/srv/t3-one",
      environmentId: "environment-one",
      development: false,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "192.168.1.50",
      instanceKey: "/srv/t3-two",
      environmentId: "environment-two",
      development: false,
    });

    expect(first).toMatch(/^t3_session_[a-f0-9]{12}$/);
    expect(second).toMatch(/^t3_session_[a-f0-9]{12}$/);
    expect(first).not.toBe(second);
  });

  it("keeps a remote web server cookie stable across port changes", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 8080,
      host: "0.0.0.0",
      instanceKey: "/srv/t3",
      environmentId: "environment-one",
      development: false,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 9090,
      host: "app.example.com",
      instanceKey: "/srv/t3",
      environmentId: "environment-one",
      development: false,
    });

    expect(first).toBe(second);
  });
});
