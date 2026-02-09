import crypto from "node:crypto";
import type { ChannelId, ChannelPairingAdapter } from "../channels/plugins/types.js";
import { getPairingAdapter } from "../channels/plugins/pairing.js";
import { buildS3dbKey, getS3dbStorage } from "../persistence/s3db.js";

const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_PENDING_TTL_MS = 60 * 60 * 1000;
const PAIRING_PENDING_MAX = 3;
const PAIRING_STORE_NAMESPACE = "pairing";

export type PairingChannel = ChannelId;

export type PairingRequest = {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, string>;
};

type PairingStore = {
  version: 1;
  requests: PairingRequest[];
};

type AllowFromStore = {
  version: 1;
  allowFrom: string[];
};

/** Sanitize channel ID for use in store keys. */
function safeChannelKey(channel: PairingChannel): string {
  const raw = String(channel).trim().toLowerCase();
  if (!raw) {
    throw new Error("invalid pairing channel");
  }
  const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") {
    throw new Error("invalid pairing channel");
  }
  return safe;
}

function resolvePairingKey(channel: PairingChannel): string {
  return buildS3dbKey(`${PAIRING_STORE_NAMESPACE}/requests`, safeChannelKey(channel));
}

function resolveAllowFromKey(channel: PairingChannel): string {
  return buildS3dbKey(`${PAIRING_STORE_NAMESPACE}/allowFrom`, safeChannelKey(channel));
}

async function withPairingLock<T>(channel: PairingChannel, fn: () => Promise<T>): Promise<T> {
  const storage = await getS3dbStorage();
  const lockName = `pairing:${safeChannelKey(channel)}`;
  const lock = await storage.acquireLock(lockName, { timeout: 10_000, ttl: 30 });
  if (!lock) {
    throw new Error(`timeout acquiring pairing lock: ${lockName}`);
  }
  try {
    return await fn();
  } finally {
    await storage.releaseLock(lock);
  }
}

async function readStore<T>(key: string, fallback: T): Promise<T> {
  const storage = await getS3dbStorage();
  const raw = await storage.get(key);
  if (!raw || typeof raw !== "object") {
    return fallback;
  }
  return raw as T;
}

async function writeStore(key: string, value: unknown): Promise<void> {
  const storage = await getS3dbStorage();
  await storage.set(key, value as Record<string, unknown>, { behavior: "body-only" });
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function isExpired(entry: PairingRequest, nowMs: number): boolean {
  const createdAt = parseTimestamp(entry.createdAt);
  if (!createdAt) {
    return true;
  }
  return nowMs - createdAt > PAIRING_PENDING_TTL_MS;
}

function pruneExpiredRequests(reqs: PairingRequest[], nowMs: number) {
  const kept: PairingRequest[] = [];
  let removed = false;
  for (const req of reqs) {
    if (isExpired(req, nowMs)) {
      removed = true;
      continue;
    }
    kept.push(req);
  }
  return { requests: kept, removed };
}

function resolveLastSeenAt(entry: PairingRequest): number {
  return parseTimestamp(entry.lastSeenAt) ?? parseTimestamp(entry.createdAt) ?? 0;
}

function pruneExcessRequests(reqs: PairingRequest[], maxPending: number) {
  if (maxPending <= 0 || reqs.length <= maxPending) {
    return { requests: reqs, removed: false };
  }
  const sorted = reqs.slice().toSorted((a, b) => resolveLastSeenAt(a) - resolveLastSeenAt(b));
  return { requests: sorted.slice(-maxPending), removed: true };
}

function randomCode(): string {
  // Human-friendly: 8 chars, upper, no ambiguous chars (0O1I).
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    const idx = crypto.randomInt(0, PAIRING_CODE_ALPHABET.length);
    out += PAIRING_CODE_ALPHABET[idx];
  }
  return out;
}

function generateUniqueCode(existing: Set<string>): string {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const code = randomCode();
    if (!existing.has(code)) {
      return code;
    }
  }
  throw new Error("failed to generate unique pairing code");
}

function normalizeId(value: string | number): string {
  return String(value).trim();
}

function normalizeAllowEntry(channel: PairingChannel, entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "";
  }
  const adapter = getPairingAdapter(channel);
  const normalized = adapter?.normalizeAllowEntry ? adapter.normalizeAllowEntry(trimmed) : trimmed;
  return String(normalized).trim();
}

export async function readChannelAllowFromStore(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  void env;
  const key = resolveAllowFromKey(channel);
  const value = await readStore<AllowFromStore>(key, {
    version: 1,
    allowFrom: [],
  });
  const list = Array.isArray(value.allowFrom) ? value.allowFrom : [];
  return list.map((v) => normalizeAllowEntry(channel, String(v))).filter(Boolean);
}

export async function addChannelAllowFromStoreEntry(params: {
  channel: PairingChannel;
  entry: string | number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changed: boolean; allowFrom: string[] }> {
  void params.env;
  const key = resolveAllowFromKey(params.channel);
  return await withPairingLock(params.channel, async () => {
    const value = await readStore<AllowFromStore>(key, {
      version: 1,
      allowFrom: [],
    });
    const current = (Array.isArray(value.allowFrom) ? value.allowFrom : [])
      .map((v) => normalizeAllowEntry(params.channel, String(v)))
      .filter(Boolean);
    const normalized = normalizeAllowEntry(params.channel, normalizeId(params.entry));
    if (!normalized) {
      return { changed: false, allowFrom: current };
    }
    if (current.includes(normalized)) {
      return { changed: false, allowFrom: current };
    }
    const next = [...current, normalized];
    await writeStore(key, {
      version: 1,
      allowFrom: next,
    } satisfies AllowFromStore);
    return { changed: true, allowFrom: next };
  });
}

export async function removeChannelAllowFromStoreEntry(params: {
  channel: PairingChannel;
  entry: string | number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changed: boolean; allowFrom: string[] }> {
  void params.env;
  const key = resolveAllowFromKey(params.channel);
  return await withPairingLock(params.channel, async () => {
    const value = await readStore<AllowFromStore>(key, {
      version: 1,
      allowFrom: [],
    });
    const current = (Array.isArray(value.allowFrom) ? value.allowFrom : [])
      .map((v) => normalizeAllowEntry(params.channel, String(v)))
      .filter(Boolean);
    const normalized = normalizeAllowEntry(params.channel, normalizeId(params.entry));
    if (!normalized) {
      return { changed: false, allowFrom: current };
    }
    const next = current.filter((entry) => entry !== normalized);
    if (next.length === current.length) {
      return { changed: false, allowFrom: current };
    }
    await writeStore(key, {
      version: 1,
      allowFrom: next,
    } satisfies AllowFromStore);
    return { changed: true, allowFrom: next };
  });
}

export async function listChannelPairingRequests(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PairingRequest[]> {
  void env;
  const key = resolvePairingKey(channel);
  return await withPairingLock(channel, async () => {
    const value = await readStore<PairingStore>(key, {
      version: 1,
      requests: [],
    });
    const reqs = Array.isArray(value.requests) ? value.requests : [];
    const nowMs = Date.now();
    const { requests: prunedExpired, removed: expiredRemoved } = pruneExpiredRequests(reqs, nowMs);
    const { requests: pruned, removed: cappedRemoved } = pruneExcessRequests(
      prunedExpired,
      PAIRING_PENDING_MAX,
    );
    if (expiredRemoved || cappedRemoved) {
      await writeStore(key, {
        version: 1,
        requests: pruned,
      } satisfies PairingStore);
    }
    return pruned
      .filter(
        (r) =>
          r &&
          typeof r.id === "string" &&
          typeof r.code === "string" &&
          typeof r.createdAt === "string",
      )
      .slice()
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  });
}

export async function upsertChannelPairingRequest(params: {
  channel: PairingChannel;
  id: string | number;
  meta?: Record<string, string | undefined | null>;
  env?: NodeJS.ProcessEnv;
  /** Extension channels can pass their adapter directly to bypass registry lookup. */
  pairingAdapter?: ChannelPairingAdapter;
}): Promise<{ code: string; created: boolean }> {
  void params.env;
  const key = resolvePairingKey(params.channel);
  return await withPairingLock(params.channel, async () => {
    const value = await readStore<PairingStore>(key, {
      version: 1,
      requests: [],
    });
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const id = normalizeId(params.id);
    const meta =
      params.meta && typeof params.meta === "object"
        ? Object.fromEntries(
            Object.entries(params.meta)
              .map(([k, v]) => [k, String(v ?? "").trim()] as const)
              .filter(([_, v]) => Boolean(v)),
          )
        : undefined;

    let reqs = Array.isArray(value.requests) ? value.requests : [];
    const { requests: prunedExpired, removed: expiredRemoved } = pruneExpiredRequests(reqs, nowMs);
    reqs = prunedExpired;
    const existingIdx = reqs.findIndex((r) => r.id === id);
    const existingCodes = new Set(
      reqs.map((req) =>
        String(req.code ?? "")
          .trim()
          .toUpperCase(),
      ),
    );

    if (existingIdx >= 0) {
      const existing = reqs[existingIdx];
      const existingCode =
        existing && typeof existing.code === "string" ? existing.code.trim() : "";
      const code = existingCode || generateUniqueCode(existingCodes);
      const next: PairingRequest = {
        id,
        code,
        createdAt: existing?.createdAt ?? now,
        lastSeenAt: now,
        meta: meta ?? existing?.meta,
      };
      reqs[existingIdx] = next;
      const { requests: capped } = pruneExcessRequests(reqs, PAIRING_PENDING_MAX);
      await writeStore(key, {
        version: 1,
        requests: capped,
      } satisfies PairingStore);
      return { code, created: false };
    }

    const { requests: capped, removed: cappedRemoved } = pruneExcessRequests(
      reqs,
      PAIRING_PENDING_MAX,
    );
    reqs = capped;
    if (PAIRING_PENDING_MAX > 0 && reqs.length >= PAIRING_PENDING_MAX) {
      if (expiredRemoved || cappedRemoved) {
        await writeStore(key, {
          version: 1,
          requests: reqs,
        } satisfies PairingStore);
      }
      return { code: "", created: false };
    }
    const code = generateUniqueCode(existingCodes);
    const next: PairingRequest = {
      id,
      code,
      createdAt: now,
      lastSeenAt: now,
      ...(meta ? { meta } : {}),
    };
    await writeStore(key, {
      version: 1,
      requests: [...reqs, next],
    } satisfies PairingStore);
    return { code, created: true };
  });
}

export async function approveChannelPairingCode(params: {
  channel: PairingChannel;
  code: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ id: string; entry?: PairingRequest } | null> {
  void params.env;
  const code = params.code.trim().toUpperCase();
  if (!code) {
    return null;
  }

  const key = resolvePairingKey(params.channel);
  return await withPairingLock(params.channel, async () => {
    const value = await readStore<PairingStore>(key, {
      version: 1,
      requests: [],
    });
    const reqs = Array.isArray(value.requests) ? value.requests : [];
    const nowMs = Date.now();
    const { requests: pruned, removed } = pruneExpiredRequests(reqs, nowMs);
    const idx = pruned.findIndex((r) => String(r.code ?? "").toUpperCase() === code);
    if (idx < 0) {
      if (removed) {
        await writeStore(key, {
          version: 1,
          requests: pruned,
        } satisfies PairingStore);
      }
      return null;
    }
    const entry = pruned[idx];
    if (!entry) {
      return null;
    }
    pruned.splice(idx, 1);
    await writeStore(key, {
      version: 1,
      requests: pruned,
    } satisfies PairingStore);
    await addChannelAllowFromStoreEntry({
      channel: params.channel,
      entry: entry.id,
    });
    return { id: entry.id, entry };
  });
}
