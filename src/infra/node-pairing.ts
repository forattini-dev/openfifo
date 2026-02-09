import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { buildS3dbKey, getS3dbStorage } from "../persistence/s3db.js";

export type NodePairingPendingRequest = {
  requestId: string;
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  remoteIp?: string;
  silent?: boolean;
  isRepair?: boolean;
  ts: number;
};

export type NodePairingPairedNode = {
  nodeId: string;
  token: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  bins?: string[];
  permissions?: Record<string, boolean>;
  remoteIp?: string;
  createdAtMs: number;
  approvedAtMs: number;
  lastConnectedAtMs?: number;
};

export type NodePairingList = {
  pending: NodePairingPendingRequest[];
  paired: NodePairingPairedNode[];
};

type NodePairingStateFile = {
  version: 1;
  pendingById: Record<string, NodePairingPendingRequest>;
  pairedByNodeId: Record<string, NodePairingPairedNode>;
};

const PENDING_TTL_MS = 5 * 60 * 1000;
const NODE_PAIRING_NAMESPACE = "node-pairing";

function resolvePaths(baseDir?: string) {
  const root = baseDir ?? resolveStateDir();
  const dir = path.join(root, "nodes");
  return {
    dir,
    pendingPath: path.join(dir, "pending.json"),
    pairedPath: path.join(dir, "paired.json"),
  };
}

function resolveStateKey(baseDir?: string): string {
  return buildS3dbKey(`${NODE_PAIRING_NAMESPACE}/state`, baseDir ?? "default");
}

function resolveLockName(baseDir?: string): string {
  const scope = (baseDir ?? "default").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${NODE_PAIRING_NAMESPACE}:lock:${scope}`;
}

function coerceState(raw: unknown): NodePairingStateFile | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Partial<NodePairingStateFile>;
  if (!record.pendingById || !record.pairedByNodeId) {
    return null;
  }
  return {
    version: 1,
    pendingById: record.pendingById ?? {},
    pairedByNodeId: record.pairedByNodeId ?? {},
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

async function readLegacyState(baseDir?: string): Promise<NodePairingStateFile | null> {
  const { pendingPath, pairedPath } = resolvePaths(baseDir);
  const [pending, paired] = await Promise.all([
    readJSON<Record<string, NodePairingPendingRequest>>(pendingPath),
    readJSON<Record<string, NodePairingPairedNode>>(pairedPath),
  ]);
  if (!pending && !paired) {
    return null;
  }
  return {
    version: 1,
    pendingById: pending ?? {},
    pairedByNodeId: paired ?? {},
  };
}

function pruneExpiredPending(
  pendingById: Record<string, NodePairingPendingRequest>,
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
    throw new Error(`timeout acquiring node pairing lock: ${lockName}`);
  }
  try {
    return await fn();
  } finally {
    await storage.releaseLock(lock);
  }
}

async function loadState(baseDir?: string): Promise<NodePairingStateFile> {
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
    pairedByNodeId: {},
  };
}

async function persistState(state: NodePairingStateFile, baseDir?: string) {
  const storage = await getS3dbStorage();
  const key = resolveStateKey(baseDir);
  await storage.set(key, state as unknown as Record<string, unknown>, { behavior: "body-only" });
}

function normalizeNodeId(nodeId: string) {
  return nodeId.trim();
}

function newToken() {
  return randomUUID().replaceAll("-", "");
}

export async function listNodePairing(baseDir?: string): Promise<NodePairingList> {
  const state = await loadState(baseDir);
  const pending = Object.values(state.pendingById).toSorted((a, b) => b.ts - a.ts);
  const paired = Object.values(state.pairedByNodeId).toSorted(
    (a, b) => b.approvedAtMs - a.approvedAtMs,
  );
  return { pending, paired };
}

export async function getPairedNode(
  nodeId: string,
  baseDir?: string,
): Promise<NodePairingPairedNode | null> {
  const state = await loadState(baseDir);
  return state.pairedByNodeId[normalizeNodeId(nodeId)] ?? null;
}

export async function requestNodePairing(
  req: Omit<NodePairingPendingRequest, "requestId" | "ts" | "isRepair">,
  baseDir?: string,
): Promise<{
  status: "pending";
  request: NodePairingPendingRequest;
  created: boolean;
}> {
  return await withLock(baseDir, async () => {
    const state = await loadState(baseDir);
    const nodeId = normalizeNodeId(req.nodeId);
    if (!nodeId) {
      throw new Error("nodeId required");
    }

    const existing = Object.values(state.pendingById).find((p) => p.nodeId === nodeId);
    if (existing) {
      return { status: "pending", request: existing, created: false };
    }

    const isRepair = Boolean(state.pairedByNodeId[nodeId]);
    const request: NodePairingPendingRequest = {
      requestId: randomUUID(),
      nodeId,
      displayName: req.displayName,
      platform: req.platform,
      version: req.version,
      coreVersion: req.coreVersion,
      uiVersion: req.uiVersion,
      deviceFamily: req.deviceFamily,
      modelIdentifier: req.modelIdentifier,
      caps: req.caps,
      commands: req.commands,
      permissions: req.permissions,
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

export async function approveNodePairing(
  requestId: string,
  baseDir?: string,
): Promise<{
  status: "approved";
  node: NodePairingPairedNode;
} | null> {
  return await withLock(baseDir, async () => {
    const state = await loadState(baseDir);
    const req = state.pendingById[requestId];
    if (!req) {
      return null;
    }
    const nodeId = normalizeNodeId(req.nodeId);
    if (!nodeId) {
      return null;
    }
    const now = Date.now();
    const token = newToken();
    const prev = state.pairedByNodeId[nodeId];
    const node: NodePairingPairedNode = {
      nodeId,
      token,
      displayName: req.displayName ?? prev?.displayName,
      platform: req.platform ?? prev?.platform,
      version: req.version ?? prev?.version,
      coreVersion: req.coreVersion ?? prev?.coreVersion,
      uiVersion: req.uiVersion ?? prev?.uiVersion,
      deviceFamily: req.deviceFamily ?? prev?.deviceFamily,
      modelIdentifier: req.modelIdentifier ?? prev?.modelIdentifier,
      caps: req.caps ?? prev?.caps,
      commands: req.commands ?? prev?.commands,
      bins: prev?.bins,
      permissions: req.permissions ?? prev?.permissions,
      remoteIp: req.remoteIp ?? prev?.remoteIp,
      createdAtMs: prev?.createdAtMs ?? now,
      approvedAtMs: now,
      lastConnectedAtMs: prev?.lastConnectedAtMs,
    };
    state.pairedByNodeId[nodeId] = node;
    delete state.pendingById[requestId];
    await persistState(state, baseDir);
    return { status: "approved", node };
  });
}

export async function rejectNodePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ status: "rejected"; nodeId: string } | null> {
  return await withLock(baseDir, async () => {
    const state = await loadState(baseDir);
    const pending = state.pendingById[requestId];
    if (!pending) {
      return null;
    }
    const nodeId = normalizeNodeId(pending.nodeId);
    delete state.pendingById[requestId];
    await persistState(state, baseDir);
    return { status: "rejected", nodeId };
  });
}

export async function revokeNodePairing(
  nodeId: string,
  baseDir?: string,
): Promise<{ status: "revoked" } | null> {
  return await withLock(baseDir, async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeNodeId(nodeId);
    if (!state.pairedByNodeId[normalized]) {
      return null;
    }
    delete state.pairedByNodeId[normalized];
    await persistState(state, baseDir);
    return { status: "revoked" };
  });
}

export async function renamePairedNode(
  nodeId: string,
  displayName: string,
  baseDir?: string,
): Promise<NodePairingPairedNode | null> {
  const trimmed = displayName.trim();
  if (!trimmed) {
    return null;
  }
  return await withLock(baseDir, async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeNodeId(nodeId);
    const existing = state.pairedByNodeId[normalized];
    if (!existing) {
      return null;
    }
    const updated: NodePairingPairedNode = {
      ...existing,
      displayName: trimmed,
    };
    state.pairedByNodeId[normalized] = updated;
    await persistState(state, baseDir);
    return updated;
  });
}

export async function verifyNodeToken(
  nodeId: string,
  token: string,
  baseDir?: string,
): Promise<{ ok: boolean; node?: NodePairingPairedNode }> {
  const state = await loadState(baseDir);
  const normalized = normalizeNodeId(nodeId);
  const node = state.pairedByNodeId[normalized];
  if (!node) {
    return { ok: false };
  }
  const match = node.token === token;
  return match ? { ok: true, node } : { ok: false };
}

export async function updatePairedNodeMetadata(
  nodeId: string,
  data: {
    displayName?: string;
    platform?: string;
    version?: string;
    coreVersion?: string;
    uiVersion?: string;
    deviceFamily?: string;
    modelIdentifier?: string;
    caps?: string[];
    commands?: string[];
    permissions?: Record<string, boolean>;
    remoteIp?: string;
    bins?: string[];
    lastConnectedAtMs?: number;
  },
  baseDir?: string,
): Promise<NodePairingPairedNode | null> {
  return await withLock(baseDir, async () => {
    const state = await loadState(baseDir);
    const normalized = normalizeNodeId(nodeId);
    const existing = state.pairedByNodeId[normalized];
    if (!existing) {
      return null;
    }
    const updated: NodePairingPairedNode = {
      ...existing,
      displayName: data.displayName ?? existing.displayName,
      platform: data.platform ?? existing.platform,
      version: data.version ?? existing.version,
      coreVersion: data.coreVersion ?? existing.coreVersion,
      uiVersion: data.uiVersion ?? existing.uiVersion,
      deviceFamily: data.deviceFamily ?? existing.deviceFamily,
      modelIdentifier: data.modelIdentifier ?? existing.modelIdentifier,
      caps: data.caps ?? existing.caps,
      commands: data.commands ?? existing.commands,
      permissions: data.permissions ?? existing.permissions,
      remoteIp: data.remoteIp ?? existing.remoteIp,
      bins: data.bins ?? existing.bins,
      lastConnectedAtMs:
        typeof data.lastConnectedAtMs === "number"
          ? data.lastConnectedAtMs
          : existing.lastConnectedAtMs,
    };
    state.pairedByNodeId[normalized] = updated;
    await persistState(state, baseDir);
    return updated;
  });
}
