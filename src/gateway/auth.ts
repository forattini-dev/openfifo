import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { timingSafeEqual } from "node:crypto";
import type { GatewayAuthConfig, GatewayTailscaleMode } from "../config/config.js";
import { readTailscaleWhoisIdentity, type TailscaleWhoisIdentity } from "../infra/tailscale.js";
import { getBasicAuth, getBearerToken } from "./http-utils.js";
import { isTrustedProxyAddress, parseForwardedForClientIp, resolveGatewayClientIp } from "./net.js";
export type ResolvedGatewayAuthMode = "token" | "password" | "proxy" | "basic" | "oauth2";

export type ResolvedGatewayAuthBasic = {
  user?: string;
  password?: string;
};

export type ResolvedGatewayAuthOauth2 = {
  issuer?: string;
  audience?: string[];
  jwksUrl?: string;
  requiredScopes?: string[];
  requiredRoles?: string[];
  userClaim?: string;
  scopesClaim?: string;
  rolesClaim?: string;
};

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
  basic?: ResolvedGatewayAuthBasic;
  oauth2?: ResolvedGatewayAuthOauth2;
};

export type GatewayAuthResult = {
  ok: boolean;
  method?: "token" | "password" | "proxy" | "basic" | "oauth2" | "tailscale" | "device-token";
  user?: string;
  reason?: string;
};

type ConnectAuth = {
  token?: string;
  password?: string;
  bearer?: string;
  basic?: { user: string; password: string };
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

const OIDC_CONFIG_CACHE = new Map<string, Promise<string>>();
const JWKS_CACHE = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

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

function normalizeOptionalString(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalList(value?: string[] | string): string[] | undefined {
  if (Array.isArray(value)) {
    const list = value.map((item) => item.trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  if (typeof value === "string") {
    const list = value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  return undefined;
}

function readTokenClaim(payload: Record<string, unknown>, claim?: string): unknown {
  const raw = claim?.trim();
  if (!raw) {
    return undefined;
  }
  const parts = raw
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  let current: unknown = payload;
  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolveOauth2Config(
  config: GatewayAuthConfig["oauth2"] | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedGatewayAuthOauth2 | undefined {
  const issuer =
    normalizeOptionalString(config?.issuer) ??
    normalizeOptionalString(env.OPENCLAW_GATEWAY_OAUTH2_ISSUER) ??
    normalizeOptionalString(env.OPENCLAW_GATEWAY_OIDC_ISSUER) ??
    undefined;
  const jwksUrl =
    normalizeOptionalString(config?.jwksUrl) ??
    normalizeOptionalString(env.OPENCLAW_GATEWAY_OAUTH2_JWKS_URL) ??
    normalizeOptionalString(env.OPENCLAW_GATEWAY_OIDC_JWKS_URL) ??
    undefined;
  const audience =
    normalizeOptionalList(config?.audience) ??
    normalizeOptionalList(env.OPENCLAW_GATEWAY_OAUTH2_AUDIENCE) ??
    normalizeOptionalList(env.OPENCLAW_GATEWAY_OIDC_AUDIENCE) ??
    undefined;
  const requiredScopes =
    normalizeOptionalList(config?.requiredScopes) ??
    normalizeOptionalList(env.OPENCLAW_GATEWAY_OAUTH2_SCOPES) ??
    undefined;
  const requiredRoles =
    normalizeOptionalList(config?.requiredRoles) ??
    normalizeOptionalList(env.OPENCLAW_GATEWAY_OAUTH2_ROLES) ??
    undefined;
  const userClaim =
    normalizeOptionalString(config?.userClaim) ??
    normalizeOptionalString(env.OPENCLAW_GATEWAY_OAUTH2_USER_CLAIM) ??
    undefined;
  const scopesClaim =
    normalizeOptionalString(config?.scopesClaim) ??
    normalizeOptionalString(env.OPENCLAW_GATEWAY_OAUTH2_SCOPES_CLAIM) ??
    undefined;
  const rolesClaim =
    normalizeOptionalString(config?.rolesClaim) ??
    normalizeOptionalString(env.OPENCLAW_GATEWAY_OAUTH2_ROLES_CLAIM) ??
    undefined;

  if (
    !issuer &&
    !jwksUrl &&
    !audience &&
    !requiredScopes &&
    !requiredRoles &&
    !userClaim &&
    !scopesClaim &&
    !rolesClaim
  ) {
    return undefined;
  }

  return {
    issuer,
    jwksUrl,
    audience,
    requiredScopes,
    requiredRoles,
    userClaim,
    scopesClaim,
    rolesClaim,
  };
}

async function resolveOauth2JwksUrl(oauth2: ResolvedGatewayAuthOauth2): Promise<string> {
  if (oauth2.jwksUrl) {
    return oauth2.jwksUrl;
  }
  const issuer = oauth2.issuer;
  if (!issuer) {
    throw new Error("oauth2 jwks url missing");
  }
  const normalizedIssuer = issuer.replace(/\/+$/, "");
  const cached = OIDC_CONFIG_CACHE.get(normalizedIssuer);
  if (cached) {
    return cached;
  }
  const discoveryPromise = (async () => {
    const res = await fetch(`${normalizedIssuer}/.well-known/openid-configuration`);
    if (!res.ok) {
      throw new Error(`openid configuration fetch failed (${res.status})`);
    }
    const payload = (await res.json()) as { jwks_uri?: unknown };
    if (typeof payload?.jwks_uri !== "string" || !payload.jwks_uri.trim()) {
      throw new Error("openid configuration missing jwks_uri");
    }
    return payload.jwks_uri.trim();
  })().catch((err) => {
    OIDC_CONFIG_CACHE.delete(normalizedIssuer);
    throw err;
  });
  OIDC_CONFIG_CACHE.set(normalizedIssuer, discoveryPromise);
  return discoveryPromise;
}

async function resolveOauth2Jwks(oauth2: ResolvedGatewayAuthOauth2) {
  const jwksUrl = await resolveOauth2JwksUrl(oauth2);
  const cached = JWKS_CACHE.get(jwksUrl);
  if (cached) {
    return cached;
  }
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  JWKS_CACHE.set(jwksUrl, jwks);
  return jwks;
}

function resolveOauth2Scopes(
  payload: Record<string, unknown>,
  claimOverride?: string,
): Set<string> {
  const raw = readTokenClaim(payload, claimOverride);
  const rawScope = raw ?? payload.scope ?? payload.scp ?? payload.scopes;
  const list: string[] = [];
  if (Array.isArray(rawScope)) {
    for (const entry of rawScope) {
      if (typeof entry === "string") {
        list.push(entry);
      }
    }
  } else if (typeof rawScope === "string") {
    list.push(...rawScope.split(/\s+/));
  }
  return new Set(list.map((item) => item.trim()).filter(Boolean));
}

function resolveOauth2Roles(payload: Record<string, unknown>, claimOverride?: string): Set<string> {
  const raw = readTokenClaim(payload, claimOverride);
  const rawRoles = raw ?? payload.roles ?? payload.role;
  const list: string[] = [];
  if (Array.isArray(rawRoles)) {
    for (const entry of rawRoles) {
      if (typeof entry === "string") {
        list.push(entry);
      }
    }
  } else if (typeof rawRoles === "string") {
    list.push(...rawRoles.split(/[,\s]+/));
  }
  return new Set(list.map((item) => item.trim()).filter(Boolean));
}

function resolveOauth2User(payload: Record<string, unknown>, claimOverride?: string): string {
  const claimValue = readTokenClaim(payload, claimOverride);
  const candidates = claimValue
    ? [claimValue]
    : [payload.preferred_username, payload.email, payload.sub];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "oauth2-user";
}

async function verifyOauth2Token(
  token: string,
  oauth2: ResolvedGatewayAuthOauth2,
): Promise<{ ok: boolean; reason?: string; user?: string }> {
  try {
    const jwks = await resolveOauth2Jwks(oauth2);
    const { payload } = await jwtVerify(token, jwks, {
      issuer: oauth2.issuer,
      audience: oauth2.audience,
    });
    const payloadObj = payload as Record<string, unknown>;
    if (oauth2.requiredScopes && oauth2.requiredScopes.length > 0) {
      const tokenScopes = resolveOauth2Scopes(payloadObj, oauth2.scopesClaim);
      const missing = oauth2.requiredScopes.filter((scope) => !tokenScopes.has(scope));
      if (missing.length > 0) {
        return { ok: false, reason: "oauth2_scopes_missing" };
      }
    }
    if (oauth2.requiredRoles && oauth2.requiredRoles.length > 0) {
      const tokenRoles = resolveOauth2Roles(payloadObj, oauth2.rolesClaim);
      const missing = oauth2.requiredRoles.filter((role) => !tokenRoles.has(role));
      if (missing.length > 0) {
        return { ok: false, reason: "oauth2_roles_missing" };
      }
    }
    return { ok: true, user: resolveOauth2User(payloadObj, oauth2.userClaim) };
  } catch {
    return { ok: false, reason: "oauth2_invalid" };
  }
}

export function resolveGatewayConnectAuthFromRequest(req?: IncomingMessage): ConnectAuth | null {
  if (!req) {
    return null;
  }
  const bearer = getBearerToken(req);
  const basic = getBasicAuth(req);
  if (!bearer && !basic) {
    return null;
  }
  return {
    token: bearer ?? undefined,
    password: bearer ?? undefined,
    bearer: bearer ?? undefined,
    basic: basic ?? undefined,
  };
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
  const basicUser =
    normalizeOptionalString(authConfig.basic?.user) ??
    normalizeOptionalString(env.OPENCLAW_GATEWAY_BASIC_USER) ??
    normalizeOptionalString(env.CLAWDBOT_GATEWAY_BASIC_USER) ??
    undefined;
  const basicPassword =
    normalizeOptionalString(authConfig.basic?.password) ??
    normalizeOptionalString(env.OPENCLAW_GATEWAY_BASIC_PASSWORD) ??
    normalizeOptionalString(env.CLAWDBOT_GATEWAY_BASIC_PASSWORD) ??
    undefined;
  const basic =
    basicUser || basicPassword ? { user: basicUser, password: basicPassword } : undefined;
  const oauth2 = resolveOauth2Config(authConfig.oauth2, env);
  const hasProxyConfig =
    authConfig.proxy &&
    typeof authConfig.proxy === "object" &&
    Object.values(authConfig.proxy).some((value) => typeof value === "string" && value.trim());
  const mode: ResolvedGatewayAuth["mode"] =
    authConfig.mode ??
    (password
      ? "password"
      : token
        ? "token"
        : basic
          ? "basic"
          : oauth2
            ? "oauth2"
            : hasProxyConfig
              ? "proxy"
              : "token");
  const allowTailscale =
    authConfig.allowTailscale ?? (params.tailscaleMode === "serve" && mode !== "password");
  return {
    mode,
    token,
    password,
    allowTailscale,
    proxy: authConfig.proxy ? { ...authConfig.proxy } : undefined,
    basic,
    oauth2,
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
  if (auth.mode === "basic") {
    const user = auth.basic?.user;
    const password = auth.basic?.password;
    if (!user || !password) {
      throw new Error("gateway auth mode is basic, but no username/password was configured");
    }
  }
  if (auth.mode === "oauth2") {
    if (!auth.oauth2 || (!auth.oauth2.issuer && !auth.oauth2.jwksUrl)) {
      throw new Error("gateway auth mode is oauth2, but no issuer or jwks url was configured");
    }
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
  const { auth, req, trustedProxies } = params;
  const connectAuth = params.connectAuth ?? resolveGatewayConnectAuthFromRequest(req);
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

  if (auth.mode === "basic") {
    const credentials = connectAuth?.basic;
    const expectedUser = auth.basic?.user;
    const expectedPassword = auth.basic?.password;
    if (!expectedUser || !expectedPassword) {
      return { ok: false, reason: "basic_missing_config" };
    }
    if (!credentials?.user || !credentials?.password) {
      return { ok: false, reason: "basic_missing" };
    }
    if (
      !safeEqual(credentials.user, expectedUser) ||
      !safeEqual(credentials.password, expectedPassword)
    ) {
      return { ok: false, reason: "basic_mismatch" };
    }
    return { ok: true, method: "basic", user: credentials.user };
  }

  if (auth.mode === "oauth2") {
    const oauth2 = auth.oauth2;
    if (!oauth2 || (!oauth2.issuer && !oauth2.jwksUrl)) {
      return { ok: false, reason: "oauth2_missing_config" };
    }
    const bearer = connectAuth?.bearer ?? connectAuth?.token;
    if (!bearer) {
      return { ok: false, reason: "oauth2_missing" };
    }
    const verification = await verifyOauth2Token(bearer, oauth2);
    if (!verification.ok) {
      return { ok: false, reason: verification.reason ?? "oauth2_invalid" };
    }
    return { ok: true, method: "oauth2", user: verification.user };
  }

  return { ok: false, reason: "unauthorized" };
}
