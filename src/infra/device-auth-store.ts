import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { buildS3dbKey, getS3dbStorage } from "../persistence/s3db.js";

export type DeviceAuthEntry = {
  token: string;
  role: string;
  scopes: string[];
  updatedAtMs: number;
};

type DeviceAuthStore = {
  version: 1;
  deviceId: string;
  tokens: Record<string, DeviceAuthEntry>;
};

const DEVICE_AUTH_FILE = "device-auth.json";
const DEVICE_AUTH_NAMESPACE = "device-auth";

function resolveDeviceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "identity", DEVICE_AUTH_FILE);
}

function resolveDeviceAuthKey(deviceId: string): string {
  return buildS3dbKey(DEVICE_AUTH_NAMESPACE, deviceId);
}

function normalizeRole(role: string): string {
  return role.trim();
}

function normalizeScopes(scopes: string[] | undefined): string[] {
  if (!Array.isArray(scopes)) {
    return [];
  }
  const out = new Set<string>();
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (trimmed) {
      out.add(trimmed);
    }
  }
  return [...out].toSorted();
}

async function readLegacyStore(filePath: string): Promise<DeviceAuthStore | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as DeviceAuthStore;
    if (parsed?.version !== 1 || typeof parsed.deviceId !== "string") {
      return null;
    }
    if (!parsed.tokens || typeof parsed.tokens !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function readStore(
  deviceId: string,
  env?: NodeJS.ProcessEnv,
): Promise<DeviceAuthStore | null> {
  const storage = await getS3dbStorage();
  const key = resolveDeviceAuthKey(deviceId);
  const raw = await storage.get(key);
  if (raw && typeof raw === "object") {
    const parsed = raw as DeviceAuthStore;
    if (parsed?.version === 1 && parsed.deviceId === deviceId && parsed.tokens) {
      return parsed;
    }
  }

  const legacyPath = resolveDeviceAuthPath(env);
  const legacy = await readLegacyStore(legacyPath);
  if (legacy && legacy.deviceId === deviceId) {
    await storage.set(key, legacy as unknown as Record<string, unknown>, { behavior: "body-only" });
    await fs.rm(legacyPath, { force: true });
    return legacy;
  }
  return null;
}

async function writeStore(deviceId: string, store: DeviceAuthStore): Promise<void> {
  const storage = await getS3dbStorage();
  const key = resolveDeviceAuthKey(deviceId);
  await storage.set(key, store as unknown as Record<string, unknown>, { behavior: "body-only" });
}

export async function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DeviceAuthEntry | null> {
  const store = await readStore(params.deviceId, params.env);
  if (!store) {
    return null;
  }
  if (store.deviceId !== params.deviceId) {
    return null;
  }
  const role = normalizeRole(params.role);
  const entry = store.tokens[role];
  if (!entry || typeof entry.token !== "string") {
    return null;
  }
  return entry;
}

export async function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<DeviceAuthEntry> {
  const existing = await readStore(params.deviceId, params.env);
  const role = normalizeRole(params.role);
  const next: DeviceAuthStore = {
    version: 1,
    deviceId: params.deviceId,
    tokens:
      existing && existing.deviceId === params.deviceId && existing.tokens
        ? { ...existing.tokens }
        : {},
  };
  const entry: DeviceAuthEntry = {
    token: params.token,
    role,
    scopes: normalizeScopes(params.scopes),
    updatedAtMs: Date.now(),
  };
  next.tokens[role] = entry;
  await writeStore(params.deviceId, next);
  return entry;
}

export async function clearDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const store = await readStore(params.deviceId, params.env);
  if (!store || store.deviceId !== params.deviceId) {
    return;
  }
  const role = normalizeRole(params.role);
  if (!store.tokens[role]) {
    return;
  }
  const next: DeviceAuthStore = {
    version: 1,
    deviceId: store.deviceId,
    tokens: { ...store.tokens },
  };
  delete next.tokens[role];
  await writeStore(params.deviceId, next);
}
