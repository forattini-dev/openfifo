import { describe, expect, it } from "vitest";
import { authorizeGatewayConnect } from "./auth.js";

describe("gateway auth", () => {
  it("does not throw when req is missing socket", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "secret" },
      // Regression: avoid crashing on req.socket.remoteAddress when callers pass a non-IncomingMessage.
      req: {} as never,
    });
    expect(res.ok).toBe(true);
  });

  it("reports missing and mismatched token reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("token_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token_mismatch");
  });

  it("reports missing token config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", allowTailscale: false },
      connectAuth: { token: "anything" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing_config");
  });

  it("reports missing and mismatched password reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("password_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("password_mismatch");
  });

  it("reports missing password config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "password", allowTailscale: false },
      connectAuth: { password: "secret" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_missing_config");
  });

  it("reports missing and mismatched basic auth reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "basic", basic: { user: "alice", password: "secret" }, allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("basic_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "basic", basic: { user: "alice", password: "secret" }, allowTailscale: false },
      connectAuth: { basic: { user: "alice", password: "wrong" } },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("basic_mismatch");
  });

  it("reports missing basic auth config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "basic", allowTailscale: false },
      connectAuth: { basic: { user: "alice", password: "secret" } },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("basic_missing_config");
  });

  it("reports missing oauth2 config and missing token reasons", async () => {
    const missingConfig = await authorizeGatewayConnect({
      auth: { mode: "oauth2", allowTailscale: false },
      connectAuth: { token: "secret" },
    });
    expect(missingConfig.ok).toBe(false);
    expect(missingConfig.reason).toBe("oauth2_missing_config");

    const missingToken = await authorizeGatewayConnect({
      auth: {
        mode: "oauth2",
        oauth2: { jwksUrl: "https://example.com/jwks" },
        allowTailscale: false,
      },
      connectAuth: null,
    });
    expect(missingToken.ok).toBe(false);
    expect(missingToken.reason).toBe("oauth2_missing");
  });

  it("treats local tailscale serve hostnames as direct", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: { token: "secret" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "gateway.tailnet-1234.ts.net:443" },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("token");
  });

  it("allows tailscale identity to satisfy token mode auth", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: async () => ({ login: "peter", name: "Peter" }),
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-for": "100.64.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ai-hub.bone-egret.ts.net",
          "tailscale-user-login": "peter",
          "tailscale-user-name": "Peter",
        },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("tailscale");
    expect(res.user).toBe("peter");
  });
});
