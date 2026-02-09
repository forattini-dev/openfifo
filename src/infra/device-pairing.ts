import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { buildS3dbKey, getS3dbStorage } from "../persistence/s3db.js";

export type DevicePairingPendingRequest = {
  requestId: string;
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  silent?: boolean;
  isRepair?: boolean;
  ts: number;
};

export type DeviceAuthToken = {
  token: string;
  role: string;
  scopes: string[];
  createdAtMs: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
};

export type DeviceAuthTokenSummary = {
  role: string;
  scopes: string[];
  createdAtMs: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
};

export type PairedDevice = {
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  tokens?: Record<string, DeviceAuthToken>;
  createdAtMs: number;
  approvedAtMs: number;
};

export type DevicePairingList = {
  pending: DevicePairingPendingRequest[];
  paired: PairedDevice[];
};

type DevicePairingStateFile = {
  version: 1;
  pendingById: Record<string, DevicePairingPendingRequest>;
  pairedByDeviceId: Record<string, PairedDevice>;
};

const PENDING_TTL_MS = 5 * 60 * 1000;
const DEVICE_PAIRING_NAMESPACE = "device-pairing";

function resolvePaths(baseDir?: string) {
  const root = baseDir ?? resolveStateDir();
  const dir = path.join(root, "devices");
  return {
    dir,
    pendingPath: path.join(dir, "pending.json"),
    pairedPath: path.join(dir, "paired.json"),
  };
}

function resolveStateKey(baseDir?: string): string {
  return buildS3dbKey(`${DEVICE_PAIRING_NAMESPACE}/state`, baseDir ?? "default");
}

function resolveLockName(baseDir?: string): string {
  const scope = (baseDir ?? "default").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${DEVICE_PAIRING_NAMESPACE}:lock:${scope}`;
}

function coerceState(raw: unknown): DevicePairingStateFile | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Partial<DevicePairingStateFile>;
  if (!record.pendingById || !record.pairedByDeviceId) {
    return null;
  }
  return {
    version: 1,
    pendingById: record.pendingById ?? {},
    pairedByDeviceId: record.pairedByDeviceId ?? {},
  };
}

async function readJSON<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readLegacyState(baseDir?: string): Promise<DevicePairingStateFile | null> {
  const { pendingPath, pairedPath } = resolvePaths(baseDir);
  const [pending, paired] = await Promise.all([
    readJSON<Record<string, DevicePairingPendingRequest>>(pendingPath),
    readJSON<Record<string, PairedDevice>>(pairedPath),
  ]);
  if (!pending && !paired) {
    return null;
  }
  return {
    version: 1,
    pendingById: pending ?? {},
    pairedByDeviceId: paired ?? {},
  };
}

function pruneExpiredPending(
  pendingById: Record<string, DevicePairingPendingRequest>,
  nowMs: number,
) {
  for (const [id, req] of Object.entries(pendingById)) {
    if (nowMs - req.ts > PENDING_TTL_MS) {
      delete pendingById[id];
    }
  }
}

async function withLock<T>(baseDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const storage = await getS3dbStorage();
  const lockName = resolveLockName(baseDir);
  const lock = await storage.acquireLock(lockName, { timeout: 10_000, ttl: 30 });
  if (!lock) {
    throw new Error(`timeout acquiring device pairing lock: ${lockName}`);
  }
  try {
    return await fn();
  } finally {
    await storage.releaseLock(lock);
  }
}

async function loadState(baseDir?: string): Promise<DevicePairingStateFile> {
  const storage = await getS3dbStorage();
  const key = resolveStateKey(baseDir);
  const raw = await storage.get(key);
  const state = coerceState(raw);
  if (state) {
    pruneExpiredPending(state.pendingById, Date.now());
    return state;
  }

  const legacy = await readLegacyState(baseDir);
  if (legacy) {
    pruneExpiredPending(legacy.pendingById, Date.now());
    await storage.set(key, legacy as unknown as Record<string, unknown>, { behavior: "body-only" });
    try {
      const { pendingPath, pairedPath } = resolvePaths(baseDir);
      await fs.rm(pendingPath, { force: true });
      await fs.rm(pairedPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    return legacy;
  }

  return {
    version: 1,
    pendingById: {},
    pairedByDeviceId: {},
  };
}

async function persistState(state: DevicePairingStateFile, baseDir?: string) {
  const storage = await getS3dbStorage();
  const key = resolveStateKey(baseDir);
  await storage.set(key, state as unknown as Record<string, unknown>, { behavior: "body-only" });
}

function normalizeDeviceId(deviceId: string) {
  return deviceId.trim();
}

function normalizeRole(role: string | undefined): string | null {
  const trimmed = role?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function normalizeRoles(roles: string[] | undefined): string[] | undefined {
  if (!Array.isArray(roles)) {
    return undefined;
  }
  const next = roles.map((entry) => normalizeRole(entry)).filter(Boolean) as string[];
  return next.length > 0 ? Array.from(new Set(next)) : undefined;
}

function normalizeScopes(scopes: string[] | undefined): string[] | undefined {
  if (!Array.isArray(scopes)) {
    return undefined;
  }
  const next = scopes.map((entry) => entry.trim()).filter(Boolean);
  return next.length > 0 ? Array.from(new Set(next)).toSorted() : undefined;
}

function scopesContainAll(granted: string[] | undefined, required: string[]): boolean {
  if (required.length === 0) {
    return true;
  }
  if (!Array.isArray(granted) || granted.length === 0) {
    return false;
  }
  const allowed = new Set(granted);
  return required.every((scope) => allowed.has(scope));
}

function scopesEqual(a?: string[], b?: string[]): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function newToken() {
  return randomUUID().replaceAll("-", "");
}

export async function listDevicePairing(baseDir?: string): Promise<DevicePairingList> {
  const state = await loadState(baseDir);
  const pending = Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts);
  const paired = Object.values(state.pairedByDeviceId).toSorted(
    (a, b) => b.approvedAtMs - a.approvedAtMs,
  );
  return { pending, paired };
}

export async function getPairedDevice(
  deviceId: string,
  baseDir?: string,
): Promise<PairedDevice | null> {
  const state = await loadState(baseDir);
  return state.pairedByDeviceId[normalizeDeviceId(deviceId)] ?? null;
}

export async function requestDevicePairing(
  req: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">,
  baseDir?: string,
): Promise<{
  status: "pending";
  request: DevicePairingPendingRequest;
  created: boolean;
}> {
  return await withLock(baseDir, async () => {
    const state = await loadState(baseDir);
    const deviceId = normalizeDeviceId(req.deviceId);
    if (!deviceId) {
      throw new Error("deviceId required");
    }

    const existing = Object.values(state.pendingById).find((p) => p.deviceId === deviceId);
    if (existing) {
      return { status: "pending", request: existing, created: false };
    }

    const isRepair = Boolean(state.pairedByDeviceId[deviceId]);
    const request: DevicePairingPendingRequest = {
      requestId: randomUUID(),
      deviceId,
      publicKey: req.publicKey,
      displayName: req.displayName,
      platform: req.platform,
      clientId: req.clientId,
      clientMode: req.clientMode,
      role: req.role,
      roles: normalizeRoles(req.roles),
      scopes: normalizeScopes(req.scopes),
      remoteIp: req.remoteIp,
      silent: req.silent,
      isRepair,
      ts: Date.now(),
    };
    state.pendingById[request.requestId] = request;
    await persistState(state, baseDir);
    return { status: "pending", request, created: true };
  });
}

export async function approveDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<{
  status: "approved";
  device: PairedDevice;
} | null> {
  return await withLock(baseDir, async () => {
    const state = await loadState(baseDir);
    const req = state.pendingById[requestId];
    if (!req) {
      return null;
    }
    const deviceId = normalizeDeviceId(req.deviceId);
    if (!deviceId) {
      return null;
    }
    const now = Date.now();
    const prev = state.pairedByDeviceId[deviceId];
    const token = newToken();
    const role = normalizeRole(req.role);
    const scopes = normalizeScopes(req.scopes);
    const roleKey = role ?? prev?.role ?? "operator";
    const device: PairedDevice = {
      deviceId,
      publicKey: req.publicKey,
      displayName: req.displayName,
      platform: req.platform,
      clientId: req.clientId,
      clientMode: req.clientMode,
      role: roleKey,
      roles: normalizeRoles(req.roles) ?? prev?.roles,
      scopes: scopes ?? prev?.scopes,
      remoteIp: req.remoteIp,
      tokens: {
        ...prev?.tokens,
        [roleKey]: {
          token,
          role: roleKey,
          scopes: scopes ?? prev?.scopes ?? [],
          createdAtMs: now,
        },
      },
      createdAtMs: prev?.createdAtMs ?? now,
      approvedAtMs: now,
    };
    state.pairedByDeviceId[deviceId] = device;
    delete state.pendingById[requestId];
    await persistState(state, baseDir);
    return { status: "approved", device };
  });
}

export async function rejectDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ status: "rejected"; deviceId: string } | null> {
  return await withLock(baseDir, async () => {
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) {
      return null;
    }
    const deviceId = normalizeDeviceId(pending.deviceId);
    delete state.pendingById[requestId];
    await persistState(state, baseDir);
    return { status: "rejected", deviceId };
  });
}

export async function revokeDevicePairing(
  deviceId: string,
  baseDir?: string,
): Promise<{ status: "revoked" } | null> {
  return await withLock(baseDir, async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeDeviceId(deviceId);
    if (!state.pairedByDeviceId[normalized]) {
      return null;
    }
    delete state.pairedByDeviceId[normalized];
    await persistState(state, baseDir);
    return { status: "revoked" };
  });
}

export async function updatePairedDeviceMetadata(
  deviceId: string,
  data: {
    displayName?: string;
    platform?: string;
    clientId?: string;
    clientMode?: string;
    role?: string;
    roles?: string[];
    scopes?: string[];
    remoteIp?: string;
  },
  baseDir?: string,
): Promise<PairedDevice | null> {
  return await withLock(baseDir, async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeDeviceId(deviceId);
    const existing = state.pairedByDeviceId[normalized];
    if (!existing) {
      return null;
    }
    const role = normalizeRole(data.role) ?? existing.role;
    const scopes = normalizeScopes(data.scopes) ?? existing.scopes;
    const updated: PairedDevice = {
      ...existing,
      displayName: data.displayName ?? existing.displayName,
      platform: data.platform ?? existing.platform,
      clientId: data.clientId ?? existing.clientId,
      clientMode: data.clientMode ?? existing.clientMode,
      role,
      roles: normalizeRoles(data.roles) ?? existing.roles,
      scopes,
      remoteIp: data.remoteIp ?? existing.remoteIp,
    };
    state.pairedByDeviceId[normalized] = updated;
    await persistState(state, baseDir);
    return updated;
  });
}

export async function verifyDeviceToken(params: {
  deviceId: string;
  token: string;
  role: string;
  scopes?: string[];
  baseDir?: string;
}): Promise<{ ok: boolean; token?: DeviceAuthToken }> {
  const state = await loadState(params.baseDir);
  const normalized = normalizeDeviceId(params.deviceId);
  const device = state.pairedByDeviceId[normalized];
  const role = normalizeRole(params.role);
  if (!device || !role) {
    return { ok: false };
  }
  const entry = device.tokens?.[role];
  if (!entry || entry.revokedAtMs) {
    return { ok: false };
  }
  const requiredScopes = normalizeScopes(params.scopes) ?? [];
  const scopesOk = scopesContainAll(entry.scopes, requiredScopes);
  const tokenOk = entry.token === params.token;
  if (!tokenOk || !scopesOk) {
    return { ok: false };
  }
  entry.lastUsedAtMs = Date.now();
  await persistState(state, params.baseDir);
  return { ok: true, token: entry };
}

export async function ensureDeviceToken(params: {
  deviceId: string;
  role: string;
  scopes?: string[];
  baseDir?: string;
}): Promise<DeviceAuthToken | null> {
  return await withLock(params.baseDir, async () => {
    const state = await loadState(params.baseDir);
    const normalized = normalizeDeviceId(params.deviceId);
    const device = state.pairedByDeviceId[normalized];
    if (!device) {
      return null;
    }
    const role = normalizeRole(params.role) ?? device.role ?? "operator";
    const desiredScopes = normalizeScopes(params.scopes) ?? device.scopes ?? [];
    let entry = device.tokens?.[role];
    const hasScopeCoverage = entry ? scopesContainAll(entry.scopes, desiredScopes) : false;
    if (!entry || entry.revokedAtMs || !hasScopeCoverage) {
      entry = {
        token: newToken(),
        role,
        scopes: desiredScopes,
        createdAtMs: Date.now(),
        rotatedAtMs: Date.now(),
      };
    } else if (!scopesEqual(entry.scopes, desiredScopes)) {
      entry = {
        ...entry,
        scopes: desiredScopes,
      };
    }
    const tokens = { ...device.tokens };
    tokens[role] = entry;
    state.pairedByDeviceId[normalized] = {
      ...device,
      role,
      scopes: desiredScopes,
      tokens,
    };
    await persistState(state, params.baseDir);
    return entry;
  });
}

export async function rotateDeviceToken(params: {
  deviceId: string;
  role: string;
  scopes?: string[];
  baseDir?: string;
}): Promise<DeviceAuthToken | null> {
  return await withLock(params.baseDir, async () => {
    const state = await loadState(params.baseDir);
    const normalized = normalizeDeviceId(params.deviceId);
    const device = state.pairedByDeviceId[normalized];
    if (!device) {
      return null;
    }
    const role = normalizeRole(params.role) ?? device.role ?? "operator";
    const scopes = normalizeScopes(params.scopes) ?? device.scopes ?? [];
    const now = Date.now();
    const tokenValue = newToken();
    const entry: DeviceAuthToken = {
      token: tokenValue,
      role,
      scopes,
      createdAtMs: now,
      rotatedAtMs: now,
    };
    const tokens = { ...device.tokens };
    tokens[role] = entry;
    state.pairedByDeviceId[normalized] = { ...device, role, scopes, tokens };
    await persistState(state, params.baseDir);
    return entry;
  });
}

export async function revokeDeviceToken(params: {
  deviceId: string;
  role: string;
  baseDir?: string;
}): Promise<DeviceAuthToken | null> {
  return await withLock(params.baseDir, async () => {
    const state = await loadState(params.baseDir);
    const normalized = normalizeDeviceId(params.deviceId);
    const device = state.pairedByDeviceId[normalized];
    const role = normalizeRole(params.role);
    if (!device || !role || !device.tokens?.[role]) {
      return null;
    }
    const entry = { ...device.tokens[role], revokedAtMs: Date.now() };
    const tokens = { ...device.tokens, [role]: entry };
    state.pairedByDeviceId[normalized] = { ...device, tokens };
    await persistState(state, params.baseDir);
    return entry;
  });
}

export async function updateDeviceTokenUsage(params: {
  deviceId: string;
  role: string;
  baseDir?: string;
}): Promise<DeviceAuthToken | null> {
  const state = await loadState(params.baseDir);
  const normalized = normalizeDeviceId(params.deviceId);
  const device = state.pairedByDeviceId[normalized];
  const role = normalizeRole(params.role);
  const entry = role ? device?.tokens?.[role] : undefined;
  if (!entry) {
    return null;
  }
  entry.lastUsedAtMs = Date.now();
  await persistState(state, params.baseDir);
  return entry;
}

export async function listDeviceTokens(
  deviceId: string,
  baseDir?: string,
): Promise<DeviceAuthTokenSummary[]> {
  const state = await loadState(baseDir);
  const normalized = normalizeDeviceId(deviceId);
  const device = state.pairedByDeviceId[normalized];
  return summarizeDeviceTokens(device?.tokens);
}

export function summarizeDeviceTokens(
  tokens?: Record<string, DeviceAuthToken>,
): DeviceAuthTokenSummary[] {
  if (!tokens) {
    return [];
  }
  return Object.values(tokens)
    .map((entry) => ({
      role: entry.role,
      scopes: entry.scopes,
      createdAtMs: entry.createdAtMs,
      rotatedAtMs: entry.rotatedAtMs,
      revokedAtMs: entry.revokedAtMs,
      lastUsedAtMs: entry.lastUsedAtMs,
    }))
    .toSorted((a, b) => b.createdAtMs - a.createdAtMs);
}
