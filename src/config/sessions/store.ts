import JSON5 from "json5";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { SessionMaintenanceConfig, SessionMaintenanceMode } from "../types.base.js";
import { parseByteSize } from "../../cli/parse-bytes.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildS3dbKey, getS3dbStorage } from "../../persistence/s3db.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
  type DeliveryContext,
} from "../../utils/delivery-context.js";
import { getFileMtimeMs, isCacheEnabled, resolveCacheTtlMs } from "../cache-utils.js";
import { loadConfig } from "../config.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import { mergeSessionEntry, type SessionEntry } from "./types.js";

const log = createSubsystemLogger("sessions/store");

// ============================================================================
// Session Store Cache with TTL Support
// ============================================================================

type SessionStoreCacheEntry = {
  store: Record<string, SessionEntry>;
  loadedAt: number;
  storePath: string;
  mtimeMs?: number;
};

const SESSION_STORE_CACHE = new Map<string, SessionStoreCacheEntry>();
const DEFAULT_SESSION_STORE_TTL_MS = 45_000; // 45 seconds (between 30-60s)
const SESSION_STORE_NAMESPACE = "sessions/store";

function isSessionStoreRecord(value: unknown): value is Record<string, SessionEntry> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getSessionStoreTtl(): number {
  return resolveCacheTtlMs({
    envValue: process.env.OPENCLAW_SESSION_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_SESSION_STORE_TTL_MS,
  });
}

function isSessionStoreCacheEnabled(): boolean {
  return isCacheEnabled(getSessionStoreTtl());
}

function isSessionStoreCacheValid(entry: SessionStoreCacheEntry): boolean {
  const now = Date.now();
  const ttl = getSessionStoreTtl();
  return now - entry.loadedAt <= ttl;
}

function invalidateSessionStoreCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
}

function setSessionStoreCache(
  storePath: string,
  store: Record<string, SessionEntry>,
  mtimeMs?: number,
): void {
  if (!isSessionStoreCacheEnabled()) {
    return;
  }
  SESSION_STORE_CACHE.set(storePath, {
    store: structuredClone(store),
    loadedAt: Date.now(),
    storePath,
    mtimeMs,
  });
}

function normalizeSessionEntryDelivery(entry: SessionEntry): SessionEntry {
  const normalized = normalizeSessionDeliveryFields({
    channel: entry.channel,
    lastChannel: entry.lastChannel,
    lastTo: entry.lastTo,
    lastAccountId: entry.lastAccountId,
    lastThreadId: entry.lastThreadId ?? entry.deliveryContext?.threadId ?? entry.origin?.threadId,
    deliveryContext: entry.deliveryContext,
  });
  const nextDelivery = normalized.deliveryContext;
  const sameDelivery =
    (entry.deliveryContext?.channel ?? undefined) === nextDelivery?.channel &&
    (entry.deliveryContext?.to ?? undefined) === nextDelivery?.to &&
    (entry.deliveryContext?.accountId ?? undefined) === nextDelivery?.accountId &&
    (entry.deliveryContext?.threadId ?? undefined) === nextDelivery?.threadId;
  const sameLast =
    entry.lastChannel === normalized.lastChannel &&
    entry.lastTo === normalized.lastTo &&
    entry.lastAccountId === normalized.lastAccountId &&
    entry.lastThreadId === normalized.lastThreadId;
  if (sameDelivery && sameLast) {
    return entry;
  }
  return {
    ...entry,
    deliveryContext: nextDelivery,
    lastChannel: normalized.lastChannel,
    lastTo: normalized.lastTo,
    lastAccountId: normalized.lastAccountId,
    lastThreadId: normalized.lastThreadId,
  };
}

function removeThreadFromDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context || context.threadId == null) {
    return context;
  }
  const next: DeliveryContext = { ...context };
  delete next.threadId;
  return next;
}

function normalizeSessionStore(store: Record<string, SessionEntry>): void {
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    const normalized = normalizeSessionEntryDelivery(entry);
    if (normalized !== entry) {
      store[key] = normalized;
    }
  }
}

function migrateLegacySessionStoreEntries(store: Record<string, SessionEntry>): boolean {
  let mutated = false;
  for (const entry of Object.values(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const rec = entry as unknown as Record<string, unknown>;
    if (typeof rec.channel !== "string" && typeof rec.provider === "string") {
      rec.channel = rec.provider;
      delete rec.provider;
      mutated = true;
    }
    if (typeof rec.lastChannel !== "string" && typeof rec.lastProvider === "string") {
      rec.lastChannel = rec.lastProvider;
      delete rec.lastProvider;
      mutated = true;
    }

    // Best-effort migration: legacy `room` field → `groupChannel`.
    if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
      rec.groupChannel = rec.room;
      delete rec.room;
      mutated = true;
    } else if ("room" in rec) {
      delete rec.room;
      mutated = true;
    }
  }
  return mutated;
}

export function clearSessionStoreCacheForTest(): void {
  SESSION_STORE_CACHE.clear();
}

function resolveSessionStoreKey(storePath: string): string {
  return buildS3dbKey(SESSION_STORE_NAMESPACE, storePath);
}

type SessionStoreEnvelope = {
  version: 1;
  updatedAt: number;
  store: Record<string, SessionEntry>;
};

function coerceSessionStoreEnvelope(
  raw: Record<string, unknown> | null,
): SessionStoreEnvelope | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const store =
    raw.store && typeof raw.store === "object" && !Array.isArray(raw.store)
      ? (raw.store as Record<string, SessionEntry>)
      : isSessionStoreRecord(raw)
        ? (raw as Record<string, SessionEntry>)
        : null;
  if (!store) {
    return null;
  }
  const updatedAt =
    typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
  return {
    version: 1,
    updatedAt,
    store,
  };
}

async function readSessionStoreFromDisk(
  storePath: string,
): Promise<{ store: Record<string, SessionEntry>; mtimeMs?: number } | null> {
  let raw = "";
  try {
    raw = await fs.promises.readFile(storePath, "utf-8");
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;
    if (code === "ENOENT") {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON5.parse(raw);
  } catch {
    return null;
  }

  if (!isSessionStoreRecord(parsed)) {
    return null;
  }

  const store = parsed as Record<string, SessionEntry>;
  migrateLegacySessionStoreEntries(store);
  normalizeSessionStore(store);
  return { store, mtimeMs: getFileMtimeMs(storePath) ?? undefined };
}

async function readSessionStoreFromS3db(storePath: string): Promise<SessionStoreEnvelope | null> {
  const storage = await getS3dbStorage();
  const key = resolveSessionStoreKey(storePath);
  const raw = await storage.get(key);
  return coerceSessionStoreEnvelope(raw);
}

async function persistSessionStoreToS3db(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  const storage = await getS3dbStorage();
  const key = resolveSessionStoreKey(storePath);
  const payload: SessionStoreEnvelope = {
    version: 1,
    updatedAt: Date.now(),
    store,
  };
  await storage.set(key, payload, { behavior: "body-only" });
}

async function loadSessionStoreForWrite(storePath: string): Promise<Record<string, SessionEntry>> {
  const remote = await readSessionStoreFromS3db(storePath);
  if (remote?.store) {
    const store = structuredClone(remote.store);
    const mutated = migrateLegacySessionStoreEntries(store);
    normalizeSessionStore(store);
    if (mutated) {
      await persistSessionStoreToS3db(storePath, store);
    }
    return store;
  }

  const legacy = await readSessionStoreFromDisk(storePath);
  if (legacy?.store) {
    await persistSessionStoreToS3db(storePath, legacy.store);
    return legacy.store;
  }

  return {};
}

async function writeSessionStoreToFile(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  invalidateSessionStoreCache(storePath);
  migrateLegacySessionStoreEntries(store);
  normalizeSessionStore(store);
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);

  if (process.platform === "win32") {
    try {
      await fs.promises.writeFile(storePath, json, "utf-8");
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOENT") {
        return;
      }
      throw err;
    }
    return;
  }

  const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
    await fs.promises.rename(tmp, storePath);
    await fs.promises.chmod(storePath, 0o600);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;

    if (code === "ENOENT") {
      try {
        await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
        await fs.promises.writeFile(storePath, json, { mode: 0o600, encoding: "utf-8" });
        await fs.promises.chmod(storePath, 0o600);
      } catch (err2) {
        const code2 =
          err2 && typeof err2 === "object" && "code" in err2
            ? String((err2 as { code?: unknown }).code)
            : null;
        if (code2 === "ENOENT") {
          return;
        }
        throw err2;
      }
      return;
    }

    throw err;
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

// ============================================================================
// Session Store Pruning, Capping & File Rotation
// ============================================================================

const DEFAULT_SESSION_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_MAX_ENTRIES = 500;
const DEFAULT_SESSION_ROTATE_BYTES = 10_485_760; // 10 MB
const DEFAULT_SESSION_MAINTENANCE_MODE: SessionMaintenanceMode = "warn";

export type SessionMaintenanceWarning = {
  activeSessionKey: string;
  activeUpdatedAt?: number;
  totalEntries: number;
  pruneAfterMs: number;
  maxEntries: number;
  wouldPrune: boolean;
  wouldCap: boolean;
};

type ResolvedSessionMaintenanceConfig = {
  mode: SessionMaintenanceMode;
  pruneAfterMs: number;
  maxEntries: number;
  rotateBytes: number;
};

function resolvePruneAfterMs(maintenance?: SessionMaintenanceConfig): number {
  const raw = maintenance?.pruneAfter ?? maintenance?.pruneDays;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_SESSION_PRUNE_AFTER_MS;
  }
  try {
    return parseDurationMs(String(raw).trim(), { defaultUnit: "d" });
  } catch {
    return DEFAULT_SESSION_PRUNE_AFTER_MS;
  }
}

function resolveRotateBytes(maintenance?: SessionMaintenanceConfig): number {
  const raw = maintenance?.rotateBytes;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_SESSION_ROTATE_BYTES;
  }
  try {
    return parseByteSize(String(raw).trim(), { defaultUnit: "b" });
  } catch {
    return DEFAULT_SESSION_ROTATE_BYTES;
  }
}

/**
 * Resolve maintenance settings from openclaw.json (`session.maintenance`).
 * Falls back to built-in defaults when config is missing or unset.
 */
export function resolveMaintenanceConfig(): ResolvedSessionMaintenanceConfig {
  let maintenance: SessionMaintenanceConfig | undefined;
  try {
    maintenance = loadConfig().session?.maintenance;
  } catch {
    // Config may not be available (e.g. in tests). Use defaults.
  }
  return {
    mode: maintenance?.mode ?? DEFAULT_SESSION_MAINTENANCE_MODE,
    pruneAfterMs: resolvePruneAfterMs(maintenance),
    maxEntries: maintenance?.maxEntries ?? DEFAULT_SESSION_MAX_ENTRIES,
    rotateBytes: resolveRotateBytes(maintenance),
  };
}

/**
 * Remove entries whose `updatedAt` is older than the configured threshold.
 * Entries without `updatedAt` are kept (cannot determine staleness).
 * Mutates `store` in-place.
 */
export function pruneStaleEntries(
  store: Record<string, SessionEntry>,
  overrideMaxAgeMs?: number,
  opts: { log?: boolean } = {},
): number {
  const maxAgeMs = overrideMaxAgeMs ?? resolveMaintenanceConfig().pruneAfterMs;
  const cutoffMs = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const [key, entry] of Object.entries(store)) {
    if (entry?.updatedAt != null && entry.updatedAt < cutoffMs) {
      delete store[key];
      pruned++;
    }
  }
  if (pruned > 0 && opts.log !== false) {
    log.info("pruned stale session entries", { pruned, maxAgeMs });
  }
  return pruned;
}

/**
 * Cap the store to the N most recently updated entries.
 * Entries without `updatedAt` are sorted last (removed first when over limit).
 * Mutates `store` in-place.
 */
function getEntryUpdatedAt(entry?: SessionEntry): number {
  return entry?.updatedAt ?? Number.NEGATIVE_INFINITY;
}

export function getActiveSessionMaintenanceWarning(params: {
  store: Record<string, SessionEntry>;
  activeSessionKey: string;
  pruneAfterMs: number;
  maxEntries: number;
  nowMs?: number;
}): SessionMaintenanceWarning | null {
  const activeSessionKey = params.activeSessionKey.trim();
  if (!activeSessionKey) {
    return null;
  }
  const activeEntry = params.store[activeSessionKey];
  if (!activeEntry) {
    return null;
  }
  const now = params.nowMs ?? Date.now();
  const cutoffMs = now - params.pruneAfterMs;
  const wouldPrune = activeEntry.updatedAt != null ? activeEntry.updatedAt < cutoffMs : false;
  const keys = Object.keys(params.store);
  const wouldCap =
    keys.length > params.maxEntries &&
    keys
      .toSorted((a, b) => getEntryUpdatedAt(params.store[b]) - getEntryUpdatedAt(params.store[a]))
      .slice(params.maxEntries)
      .includes(activeSessionKey);

  if (!wouldPrune && !wouldCap) {
    return null;
  }

  return {
    activeSessionKey,
    activeUpdatedAt: activeEntry.updatedAt,
    totalEntries: keys.length,
    pruneAfterMs: params.pruneAfterMs,
    maxEntries: params.maxEntries,
    wouldPrune,
    wouldCap,
  };
}

export function capEntryCount(
  store: Record<string, SessionEntry>,
  overrideMax?: number,
  opts: { log?: boolean } = {},
): number {
  const maxEntries = overrideMax ?? resolveMaintenanceConfig().maxEntries;
  const keys = Object.keys(store);
  if (keys.length <= maxEntries) {
    return 0;
  }

  // Sort by updatedAt descending; entries without updatedAt go to the end (removed first).
  const sorted = keys.toSorted((a, b) => {
    const aTime = getEntryUpdatedAt(store[a]);
    const bTime = getEntryUpdatedAt(store[b]);
    return bTime - aTime;
  });

  const toRemove = sorted.slice(maxEntries);
  for (const key of toRemove) {
    delete store[key];
  }
  if (opts.log !== false) {
    log.info("capped session entry count", { removed: toRemove.length, maxEntries });
  }
  return toRemove.length;
}

async function getSessionFileSize(storePath: string): Promise<number | null> {
  try {
    const stat = await fs.promises.stat(storePath);
    return stat.size;
  } catch {
    return null;
  }
}

/**
 * Rotate the sessions file if it exceeds the configured size threshold.
 * Renames the current file to `sessions.json.bak.{timestamp}` and cleans up
 * old rotation backups, keeping only the 3 most recent `.bak.*` files.
 */
export async function rotateSessionFile(
  storePath: string,
  overrideBytes?: number,
): Promise<boolean> {
  const maxBytes = overrideBytes ?? resolveMaintenanceConfig().rotateBytes;

  // Check current file size (file may not exist yet).
  const fileSize = await getSessionFileSize(storePath);
  if (fileSize == null) {
    return false;
  }

  if (fileSize <= maxBytes) {
    return false;
  }

  // Rotate: rename current file to .bak.{timestamp}
  const backupPath = `${storePath}.bak.${Date.now()}`;
  try {
    await fs.promises.rename(storePath, backupPath);
    log.info("rotated session store file", {
      backupPath: path.basename(backupPath),
      sizeBytes: fileSize,
    });
  } catch {
    // If rename fails (e.g. file disappeared), skip rotation.
    return false;
  }

  // Clean up old backups — keep only the 3 most recent .bak.* files.
  try {
    const dir = path.dirname(storePath);
    const baseName = path.basename(storePath);
    const files = await fs.promises.readdir(dir);
    const backups = files
      .filter((f) => f.startsWith(`${baseName}.bak.`))
      .toSorted()
      .toReversed();

    const maxBackups = 3;
    if (backups.length > maxBackups) {
      const toDelete = backups.slice(maxBackups);
      for (const old of toDelete) {
        await fs.promises.unlink(path.join(dir, old)).catch(() => undefined);
      }
      log.info("cleaned up old session store backups", { deleted: toDelete.length });
    }
  } catch {
    // Best-effort cleanup; don't fail the write.
  }

  return true;
}

type SaveSessionStoreOptions = {
  /** Skip pruning, capping, and rotation (e.g. during one-time migrations). */
  skipMaintenance?: boolean;
  /** Active session key for warn-only maintenance. */
  activeSessionKey?: string;
  /** Optional callback for warn-only maintenance. */
  onWarn?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
};

async function saveSessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
): Promise<void> {
  invalidateSessionStoreCache(storePath);
  migrateLegacySessionStoreEntries(store);
  normalizeSessionStore(store);

  if (!opts?.skipMaintenance) {
    // Resolve maintenance config once (avoids repeated loadConfig() calls).
    const maintenance = resolveMaintenanceConfig();
    const shouldWarnOnly = maintenance.mode === "warn";

    if (shouldWarnOnly) {
      const activeSessionKey = opts?.activeSessionKey?.trim();
      if (activeSessionKey) {
        const warning = getActiveSessionMaintenanceWarning({
          store,
          activeSessionKey,
          pruneAfterMs: maintenance.pruneAfterMs,
          maxEntries: maintenance.maxEntries,
        });
        if (warning) {
          log.warn("session maintenance would evict active session; skipping enforcement", {
            activeSessionKey: warning.activeSessionKey,
            wouldPrune: warning.wouldPrune,
            wouldCap: warning.wouldCap,
            pruneAfterMs: warning.pruneAfterMs,
            maxEntries: warning.maxEntries,
          });
          await opts?.onWarn?.(warning);
        }
      }
    } else {
      // Prune stale entries and cap total count before serializing.
      pruneStaleEntries(store, maintenance.pruneAfterMs);
      capEntryCount(store, maintenance.maxEntries);

      // Rotate the on-disk file if it exceeds the size threshold.
      await rotateSessionFile(storePath, maintenance.rotateBytes);
    }
  }

  let writeError: unknown = null;
  try {
    await writeSessionStoreToFile(storePath, store);
  } catch (err) {
    writeError = err;
  }

  await persistSessionStoreToS3db(storePath, store);

  if (writeError) {
    setSessionStoreCache(storePath, store, undefined);
    log.warn(
      { err: String(writeError), storePath },
      "failed to persist session store to local disk; s3db write succeeded",
    );
  }
}

export async function hydrateSessionStoreFromS3db(storePath: string): Promise<boolean> {
  const remote = await readSessionStoreFromS3db(storePath);
  if (remote?.store) {
    const localMtime = getFileMtimeMs(storePath) ?? 0;
    if (localMtime >= remote.updatedAt && localMtime > 0) {
      return true;
    }
    let writeError: unknown = null;
    try {
      await writeSessionStoreToFile(storePath, remote.store);
    } catch (err) {
      writeError = err;
    }
    const mtimeMs = writeError ? undefined : (getFileMtimeMs(storePath) ?? remote.updatedAt);
    setSessionStoreCache(storePath, remote.store, mtimeMs);
    if (writeError) {
      log.warn(
        { err: String(writeError), storePath },
        "failed to hydrate session store to local disk; using in-memory snapshot",
      );
    }
    return true;
  }

  const legacy = await readSessionStoreFromDisk(storePath);
  if (legacy?.store) {
    await persistSessionStoreToS3db(storePath, legacy.store);
    setSessionStoreCache(storePath, legacy.store, legacy.mtimeMs);
    return true;
  }

  return false;
}

async function refreshSessionStoreFromS3db(storePath: string): Promise<void> {
  const remote = await readSessionStoreFromS3db(storePath);
  if (!remote) {
    return;
  }
  const localMtime = getFileMtimeMs(storePath) ?? 0;
  if (localMtime >= remote.updatedAt && localMtime > 0) {
    return;
  }
  let writeError: unknown = null;
  try {
    await writeSessionStoreToFile(storePath, remote.store);
  } catch (err) {
    writeError = err;
  }
  const mtimeMs = writeError ? undefined : (getFileMtimeMs(storePath) ?? remote.updatedAt);
  setSessionStoreCache(storePath, remote.store, mtimeMs);
  if (writeError) {
    log.warn(
      { err: String(writeError), storePath },
      "failed to refresh session store cache on disk; using in-memory snapshot",
    );
  }
}

type LoadSessionStoreOptions = {
  skipCache?: boolean;
};

export function loadSessionStore(
  storePath: string,
  opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  // Check cache first if enabled
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    const cached = SESSION_STORE_CACHE.get(storePath);
    if (cached && isSessionStoreCacheValid(cached)) {
      if (cached.mtimeMs === undefined) {
        return structuredClone(cached.store);
      }
      const currentMtimeMs = getFileMtimeMs(storePath);
      if (currentMtimeMs === cached.mtimeMs) {
        // Return a deep copy to prevent external mutations affecting cache
        return structuredClone(cached.store);
      }
      invalidateSessionStoreCache(storePath);
    }
  }

  // Cache miss or disabled - load from disk
  let store: Record<string, SessionEntry> = {};
  let mtimeMs = getFileMtimeMs(storePath);
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON5.parse(raw);
    if (isSessionStoreRecord(parsed)) {
      store = parsed;
    }
    mtimeMs = getFileMtimeMs(storePath) ?? mtimeMs;
  } catch {
    // ignore missing/invalid store; we'll recreate it
  }

  // Best-effort migration: legacy field names.
  migrateLegacySessionStoreEntries(store);

  // Cache the result if caching is enabled
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    setSessionStoreCache(storePath, store, mtimeMs);
  }

  if (!opts.skipCache) {
    void refreshSessionStoreFromS3db(storePath).catch(() => undefined);
  }

  return structuredClone(store);
}

export function readSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): number | undefined {
  try {
    const store = loadSessionStore(params.storePath);
    return store[params.sessionKey]?.updatedAt;
  } catch {
    return undefined;
  }
}

async function saveSessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  let writeError: unknown = null;
  try {
    await writeSessionStoreToFile(storePath, store);
  } catch (err) {
    writeError = err;
  }

  await persistSessionStoreToS3db(storePath, store);

  if (writeError) {
    setSessionStoreCache(storePath, store, undefined);
    log.warn(
      { err: String(writeError), storePath },
      "failed to persist session store to local disk; s3db write succeeded",
    );
  }
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
): Promise<void> {
  await withSessionStoreLock(storePath, async () => {
    await saveSessionStoreUnlocked(storePath, store, opts);
  });
}

export async function updateSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  opts?: SaveSessionStoreOptions,
): Promise<T> {
  return await withSessionStoreLock(storePath, async () => {
    // Always re-read inside the lock to avoid clobbering concurrent writers.
    const store = await loadSessionStoreForWrite(storePath);
    const result = await mutator(store);
    await saveSessionStoreUnlocked(storePath, store, opts);
    return result;
  });
}

type SessionStoreLockOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
};

async function withSessionStoreLock<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: SessionStoreLockOptions = {},
): Promise<T> {
  const storage = await getS3dbStorage();
  const normalized = storePath.replace(/\\/g, "/");
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  const lockName = `session-store:${hash}`;
  const lock = await storage.acquireLock(lockName, {
    timeout: Math.max(1, Math.floor(opts.timeoutMs ?? 10_000)),
    ttl: 30,
  });
  if (!lock) {
    throw new Error(`timeout acquiring session store lock: ${lockName}`);
  }

  try {
    return await fn();
  } finally {
    await storage.releaseLock(lock).catch(() => undefined);
  }
}

export async function updateSessionStoreEntry(params: {
  storePath: string;
  sessionKey: string;
  update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, update } = params;
  return await withSessionStoreLock(storePath, async () => {
    const store = await loadSessionStoreForWrite(storePath);
    const existing = store[sessionKey];
    if (!existing) {
      return null;
    }
    const patch = await update(existing);
    if (!patch) {
      return existing;
    }
    const next = mergeSessionEntry(existing, patch);
    store[sessionKey] = next;
    await saveSessionStoreUnlocked(storePath, store, { activeSessionKey: sessionKey });
    return next;
  });
}

export async function recordSessionMetaFromInbound(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  return await updateSessionStore(
    storePath,
    (store) => {
      const existing = store[sessionKey];
      const patch = deriveSessionMetaPatch({
        ctx,
        sessionKey,
        existing,
        groupResolution: params.groupResolution,
      });
      if (!patch) {
        return existing ?? null;
      }
      if (!existing && !createIfMissing) {
        return null;
      }
      const next = mergeSessionEntry(existing, patch);
      store[sessionKey] = next;
      return next;
    },
    { activeSessionKey: sessionKey },
  );
}

export async function updateLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
}) {
  const { storePath, sessionKey, channel, to, accountId, threadId, ctx } = params;
  return await withSessionStoreLock(storePath, async () => {
    const store = await loadSessionStoreForWrite(storePath);
    const existing = store[sessionKey];
    const now = Date.now();
    const explicitContext = normalizeDeliveryContext(params.deliveryContext);
    const inlineContext = normalizeDeliveryContext({
      channel,
      to,
      accountId,
      threadId,
    });
    const mergedInput = mergeDeliveryContext(explicitContext, inlineContext);
    const explicitDeliveryContext = params.deliveryContext;
    const explicitThreadFromDeliveryContext =
      explicitDeliveryContext != null &&
      Object.prototype.hasOwnProperty.call(explicitDeliveryContext, "threadId")
        ? explicitDeliveryContext.threadId
        : undefined;
    const explicitThreadValue =
      explicitThreadFromDeliveryContext ??
      (threadId != null && threadId !== "" ? threadId : undefined);
    const explicitRouteProvided = Boolean(
      explicitContext?.channel ||
      explicitContext?.to ||
      inlineContext?.channel ||
      inlineContext?.to,
    );
    const clearThreadFromFallback = explicitRouteProvided && explicitThreadValue == null;
    const fallbackContext = clearThreadFromFallback
      ? removeThreadFromDeliveryContext(deliveryContextFromSession(existing))
      : deliveryContextFromSession(existing);
    const merged = mergeDeliveryContext(mergedInput, fallbackContext);
    const normalized = normalizeSessionDeliveryFields({
      deliveryContext: {
        channel: merged?.channel,
        to: merged?.to,
        accountId: merged?.accountId,
        threadId: merged?.threadId,
      },
    });
    const metaPatch = ctx
      ? deriveSessionMetaPatch({
          ctx,
          sessionKey,
          existing,
          groupResolution: params.groupResolution,
        })
      : null;
    const basePatch: Partial<SessionEntry> = {
      updatedAt: Math.max(existing?.updatedAt ?? 0, now),
      deliveryContext: normalized.deliveryContext,
      lastChannel: normalized.lastChannel,
      lastTo: normalized.lastTo,
      lastAccountId: normalized.lastAccountId,
      lastThreadId: normalized.lastThreadId,
    };
    const next = mergeSessionEntry(
      existing,
      metaPatch ? { ...basePatch, ...metaPatch } : basePatch,
    );
    store[sessionKey] = next;
    await saveSessionStoreUnlocked(storePath, store, { activeSessionKey: sessionKey });
    return next;
  });
}
