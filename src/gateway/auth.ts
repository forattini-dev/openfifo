import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { GatewayAuthConfig, GatewayTailscaleMode } from "../config/config.js";
import { readTailscaleWhoisIdentity, type TailscaleWhoisIdentity } from "../infra/tailscale.js";
import { isTrustedProxyAddress, parseForwardedForClientIp, resolveGatewayClientIp } from "./net.js";
export type ResolvedGatewayAuthMode = "token" | "password" | "proxy";

export type ResolvedGatewayAuthProxy = {
  userHeader?: string;
  emailHeader?: string;
  nameHeader?: string;
  roleHeader?: string;
  scopesHeader?: string;
};

export type ResolvedGatewayAuth = {
  mode: ResolvedGatewayAuthMode;
  token?: string;
  password?: string;
  allowTailscale: boolean;
  proxy?: ResolvedGatewayAuthProxy;
};

export type GatewayAuthResult = {
  ok: boolean;
  method?: "token" | "password" | "proxy" | "tailscale" | "device-token";
  user?: string;
  reason?: string;
};

type ConnectAuth = {
  token?: string;
  password?: string;
};

type TailscaleUser = {
  login: string;
  name: string;
  profilePic?: string;
};

type TailscaleWhoisLookup = (ip: string) => Promise<TailscaleWhoisIdentity | null>;

const DEFAULT_PROXY_USER_HEADERS = [
  "x-auth-request-user",
  "x-forwarded-user",
  "x-authenticated-user",
  "x-remote-user",
  "x-auth-request-email",
];
const DEFAULT_PROXY_EMAIL_HEADERS = ["x-auth-request-email"];
const DEFAULT_PROXY_NAME_HEADERS = ["x-auth-request-name", "x-forwarded-name"];
const DEFAULT_PROXY_ROLE_HEADERS = ["x-auth-request-role", "x-forwarded-role"];

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) {
    return false;
  }
  if (ip === "127.0.0.1") {
    return true;
  }
  if (ip.startsWith("127.")) {
    return true;
  }
  if (ip === "::1") {
    return true;
  }
  if (ip.startsWith("::ffff:127.")) {
    return true;
  }
  return false;
}

function getHostName(hostHeader?: string): string {
  const host = (hostHeader ?? "").trim().toLowerCase();
  if (!host) {
    return "";
  }
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end !== -1) {
      return host.slice(1, end);
    }
  }
  const [name] = host.split(":");
  return name ?? "";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeHeaderName(value: string): string {
  return value.trim().toLowerCase();
}

function readHeader(req: IncomingMessage, headerName: string): string | undefined {
  const key = normalizeHeaderName(headerName);
  if (!key) {
    return undefined;
  }
  const raw = req.headers[key];
  const value = headerValue(raw);
  return value?.trim() || undefined;
}

function resolveHeaderValue(
  req: IncomingMessage,
  primary: string | undefined,
  fallbacks: string[],
): string | undefined {
  const fromPrimary = primary ? readHeader(req, primary) : undefined;
  if (fromPrimary) {
    return fromPrimary;
  }
  for (const header of fallbacks) {
    const value = readHeader(req, header);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function resolveTailscaleClientIp(req?: IncomingMessage): string | undefined {
  if (!req) {
    return undefined;
  }
  const forwardedFor = headerValue(req.headers?.["x-forwarded-for"]);
  return forwardedFor ? parseForwardedForClientIp(forwardedFor) : undefined;
}

function resolveRequestClientIp(
  req?: IncomingMessage,
  trustedProxies?: string[],
): string | undefined {
  if (!req) {
    return undefined;
  }
  return resolveGatewayClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
    realIp: headerValue(req.headers?.["x-real-ip"]),
    trustedProxies,
  });
}

export function isLocalDirectRequest(req?: IncomingMessage, trustedProxies?: string[]): boolean {
  if (!req) {
    return false;
  }
  const clientIp = resolveRequestClientIp(req, trustedProxies) ?? "";
  if (!isLoopbackAddress(clientIp)) {
    return false;
  }

  const host = getHostName(req.headers?.host);
  const hostIsLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const hostIsTailscaleServe = host.endsWith(".ts.net");

  const hasForwarded = Boolean(
    req.headers?.["x-forwarded-for"] ||
    req.headers?.["x-real-ip"] ||
    req.headers?.["x-forwarded-host"],
  );

  const remoteIsTrustedProxy = isTrustedProxyAddress(req.socket?.remoteAddress, trustedProxies);
  return (hostIsLocal || hostIsTailscaleServe) && (!hasForwarded || remoteIsTrustedProxy);
}

function getTailscaleUser(req?: IncomingMessage): TailscaleUser | null {
  if (!req) {
    return null;
  }
  const login = req.headers["tailscale-user-login"];
  if (typeof login !== "string" || !login.trim()) {
    return null;
  }
  const nameRaw = req.headers["tailscale-user-name"];
  const profilePic = req.headers["tailscale-user-profile-pic"];
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : login.trim();
  return {
    login: login.trim(),
    name,
    profilePic: typeof profilePic === "string" && profilePic.trim() ? profilePic.trim() : undefined,
  };
}

function hasTailscaleProxyHeaders(req?: IncomingMessage): boolean {
  if (!req) {
    return false;
  }
  return Boolean(
    req.headers["x-forwarded-for"] &&
    req.headers["x-forwarded-proto"] &&
    req.headers["x-forwarded-host"],
  );
}

function isTailscaleProxyRequest(req?: IncomingMessage): boolean {
  if (!req) {
    return false;
  }
  return isLoopbackAddress(req.socket?.remoteAddress) && hasTailscaleProxyHeaders(req);
}

async function resolveVerifiedTailscaleUser(params: {
  req?: IncomingMessage;
  tailscaleWhois: TailscaleWhoisLookup;
}): Promise<{ ok: true; user: TailscaleUser } | { ok: false; reason: string }> {
  const { req, tailscaleWhois } = params;
  const tailscaleUser = getTailscaleUser(req);
  if (!tailscaleUser) {
    return { ok: false, reason: "tailscale_user_missing" };
  }
  if (!isTailscaleProxyRequest(req)) {
    return { ok: false, reason: "tailscale_proxy_missing" };
  }
  const clientIp = resolveTailscaleClientIp(req);
  if (!clientIp) {
    return { ok: false, reason: "tailscale_whois_failed" };
  }
  const whois = await tailscaleWhois(clientIp);
  if (!whois?.login) {
    return { ok: false, reason: "tailscale_whois_failed" };
  }
  if (normalizeLogin(whois.login) !== normalizeLogin(tailscaleUser.login)) {
    return { ok: false, reason: "tailscale_user_mismatch" };
  }
  return {
    ok: true,
    user: {
      login: whois.login,
      name: whois.name ?? tailscaleUser.name,
      profilePic: tailscaleUser.profilePic,
    },
  };
}

export function resolveGatewayAuth(params: {
  authConfig?: GatewayAuthConfig | null;
  env?: NodeJS.ProcessEnv;
  tailscaleMode?: GatewayTailscaleMode;
}): ResolvedGatewayAuth {
  const authConfig = params.authConfig ?? {};
  const env = params.env ?? process.env;
  const token =
    authConfig.token ?? env.OPENCLAW_GATEWAY_TOKEN ?? env.CLAWDBOT_GATEWAY_TOKEN ?? undefined;
  const password =
    authConfig.password ??
    env.OPENCLAW_GATEWAY_PASSWORD ??
    env.CLAWDBOT_GATEWAY_PASSWORD ??
    undefined;
  const hasProxyConfig =
    authConfig.proxy &&
    typeof authConfig.proxy === "object" &&
    Object.values(authConfig.proxy).some((value) => typeof value === "string" && value.trim());
  const mode: ResolvedGatewayAuth["mode"] =
    authConfig.mode ??
    (password ? "password" : token ? "token" : hasProxyConfig ? "proxy" : "token");
  const allowTailscale =
    authConfig.allowTailscale ?? (params.tailscaleMode === "serve" && mode !== "password");
  return {
    mode,
    token,
    password,
    allowTailscale,
    proxy: authConfig.proxy ? { ...authConfig.proxy } : undefined,
  };
}

export function assertGatewayAuthConfigured(auth: ResolvedGatewayAuth): void {
  if (auth.mode === "token" && !auth.token) {
    if (auth.allowTailscale) {
      return;
    }
    throw new Error(
      "gateway auth mode is token, but no token was configured (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)",
    );
  }
  if (auth.mode === "password" && !auth.password) {
    throw new Error("gateway auth mode is password, but no password was configured");
  }
  if (auth.mode === "proxy" && auth.proxy === undefined) {
    return;
  }
}

export async function authorizeGatewayConnect(params: {
  auth: ResolvedGatewayAuth;
  connectAuth?: ConnectAuth | null;
  req?: IncomingMessage;
  trustedProxies?: string[];
  tailscaleWhois?: TailscaleWhoisLookup;
}): Promise<GatewayAuthResult> {
  const { auth, connectAuth, req, trustedProxies } = params;
  const tailscaleWhois = params.tailscaleWhois ?? readTailscaleWhoisIdentity;
  const localDirect = isLocalDirectRequest(req, trustedProxies);

  if (auth.allowTailscale && !localDirect) {
    const tailscaleCheck = await resolveVerifiedTailscaleUser({
      req,
      tailscaleWhois,
    });
    if (tailscaleCheck.ok) {
      return {
        ok: true,
        method: "tailscale",
        user: tailscaleCheck.user.login,
      };
    }
  }

  if (auth.mode === "proxy") {
    if (!req) {
      return { ok: false, reason: "proxy_missing_request" };
    }
    const isTrustedProxy = isTrustedProxyAddress(req.socket?.remoteAddress, trustedProxies);
    if (!isTrustedProxy) {
      return { ok: false, reason: "proxy_untrusted" };
    }
    const proxy = auth.proxy ?? {};
    const user = resolveHeaderValue(req, proxy.userHeader, DEFAULT_PROXY_USER_HEADERS);
    if (!user) {
      return { ok: false, reason: "proxy_user_missing" };
    }
    const email = resolveHeaderValue(req, proxy.emailHeader, DEFAULT_PROXY_EMAIL_HEADERS);
    const name = resolveHeaderValue(req, proxy.nameHeader, DEFAULT_PROXY_NAME_HEADERS);
    const role = resolveHeaderValue(req, proxy.roleHeader, DEFAULT_PROXY_ROLE_HEADERS);
    const identityParts = [user, email, name, role].filter(Boolean);
    return {
      ok: true,
      method: "proxy",
      user: identityParts.length > 0 ? identityParts.join(" ") : user,
    };
  }

  if (auth.mode === "token") {
    if (!auth.token) {
      return { ok: false, reason: "token_missing_config" };
    }
    if (!connectAuth?.token) {
      return { ok: false, reason: "token_missing" };
    }
    if (!safeEqual(connectAuth.token, auth.token)) {
      return { ok: false, reason: "token_mismatch" };
    }
    return { ok: true, method: "token" };
  }

  if (auth.mode === "password") {
    const password = connectAuth?.password;
    if (!auth.password) {
      return { ok: false, reason: "password_missing_config" };
    }
    if (!password) {
      return { ok: false, reason: "password_missing" };
    }
    if (!safeEqual(password, auth.password)) {
      return { ok: false, reason: "password_mismatch" };
    }
    return { ok: true, method: "password" };
  }

  return { ok: false, reason: "unauthorized" };
}
