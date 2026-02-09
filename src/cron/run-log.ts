import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildS3dbKey, getS3dbStorage } from "../persistence/s3db.js";

export type CronRunLogEntry = {
  ts: number;
  jobId: string;
  action: "finished";
  status?: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
};

export function resolveCronRunLogPath(params: { storePath: string; jobId: string }) {
  const storePath = path.resolve(params.storePath);
  const dir = path.dirname(storePath);
  return path.join(dir, "runs", `${params.jobId}.jsonl`);
}

const CRON_RUN_LOG_NAMESPACE = "cron/run-log";
const CRON_RUN_LOG_LOCK_PREFIX = "cron-run-log";

type CronRunLogEnvelope = {
  version: 1;
  entries: CronRunLogEntry[];
};

function resolveCronRunLogKey(filePath: string): string {
  return buildS3dbKey(CRON_RUN_LOG_NAMESPACE, filePath);
}

function resolveCronRunLogLockName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${CRON_RUN_LOG_LOCK_PREFIX}:${hash}`;
}

function coerceCronRunLogEnvelope(raw: unknown): CronRunLogEnvelope | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const entries = Array.isArray(record.entries) ? (record.entries as CronRunLogEntry[]) : [];
  return { version: 1, entries };
}

function pruneEntries(entries: CronRunLogEntry[], opts: { maxBytes: number; keepLines: number }) {
  let pruned = entries.slice();
  if (opts.keepLines > 0 && pruned.length > opts.keepLines) {
    pruned = pruned.slice(-opts.keepLines);
  }
  if (opts.maxBytes > 0) {
    const estimateLine = (entry: CronRunLogEntry) => JSON.stringify(entry).length + 1;
    let total = pruned.reduce((acc, entry) => acc + estimateLine(entry), 0);
    while (total > opts.maxBytes && pruned.length > 1) {
      total -= estimateLine(pruned[0]);
      pruned = pruned.slice(1);
    }
  }
  return pruned;
}

async function readLegacyCronRunLog(filePath: string): Promise<CronRunLogEntry[]> {
  const raw = await fs.readFile(path.resolve(filePath), "utf-8").catch(() => "");
  if (!raw.trim()) {
    return [];
  }
  const parsed: CronRunLogEntry[] = [];
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }
    try {
      const obj = JSON.parse(line) as Partial<CronRunLogEntry> | null;
      if (!obj || typeof obj !== "object") {
        continue;
      }
      if (obj.action !== "finished") {
        continue;
      }
      if (typeof obj.jobId !== "string" || obj.jobId.trim().length === 0) {
        continue;
      }
      if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) {
        continue;
      }
      const entry: CronRunLogEntry = {
        ts: obj.ts,
        jobId: obj.jobId,
        action: "finished",
        status: obj.status,
        error: obj.error,
        summary: obj.summary,
        runAtMs: obj.runAtMs,
        durationMs: obj.durationMs,
        nextRunAtMs: obj.nextRunAtMs,
      };
      if (typeof obj.sessionId === "string" && obj.sessionId.trim().length > 0) {
        entry.sessionId = obj.sessionId;
      }
      if (typeof obj.sessionKey === "string" && obj.sessionKey.trim().length > 0) {
        entry.sessionKey = obj.sessionKey;
      }
      parsed.push(entry);
    } catch {
      // ignore invalid lines
    }
  }
  return parsed.toReversed();
}

export async function appendCronRunLog(
  filePath: string,
  entry: CronRunLogEntry,
  opts?: { maxBytes?: number; keepLines?: number },
) {
  const resolved = path.resolve(filePath);
  const storage = await getS3dbStorage();
  const key = resolveCronRunLogKey(resolved);
  const lockName = resolveCronRunLogLockName(resolved);
  const lock = await storage.acquireLock(lockName, { timeout: 10_000, ttl: 30 });
  if (!lock) {
    throw new Error(`timeout acquiring cron run log lock: ${lockName}`);
  }
  try {
    const raw = await storage.get(key);
    const envelope = coerceCronRunLogEnvelope(raw);
    const existing = envelope?.entries ?? [];
    const next = pruneEntries([...existing, entry], {
      maxBytes: opts?.maxBytes ?? 2_000_000,
      keepLines: opts?.keepLines ?? 2_000,
    });
    await storage.set(key, { version: 1, entries: next } satisfies CronRunLogEnvelope, {
      behavior: "body-only",
    });
  } finally {
    await storage.releaseLock(lock);
  }
}

export async function readCronRunLogEntries(
  filePath: string,
  opts?: { limit?: number; jobId?: string },
): Promise<CronRunLogEntry[]> {
  const limit = Math.max(1, Math.min(5000, Math.floor(opts?.limit ?? 200)));
  const jobId = opts?.jobId?.trim() || undefined;
  const resolved = path.resolve(filePath);
  const storage = await getS3dbStorage();
  const key = resolveCronRunLogKey(resolved);
  let raw = await storage.get(key);
  let envelope = coerceCronRunLogEnvelope(raw);
  if (!envelope) {
    const legacyEntries = await readLegacyCronRunLog(resolved);
    if (legacyEntries.length > 0) {
      envelope = { version: 1, entries: legacyEntries };
      await storage.set(key, envelope as unknown as Record<string, unknown>, {
        behavior: "body-only",
      });
      try {
        await fs.rm(resolved, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
  const entries = envelope?.entries ?? [];
  const filtered = jobId ? entries.filter((entry) => entry.jobId === jobId) : entries;
  return filtered.slice(Math.max(0, filtered.length - limit));
}
