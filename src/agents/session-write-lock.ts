import crypto from "node:crypto";
import fsSync from "node:fs";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getS3dbStorage } from "../persistence/s3db.js";

type HeldLock = {
  count: number;
  lock: {
    name: string;
    token: string;
  };
};

const HELD_LOCKS = new Map<string, HeldLock>();
const log = createSubsystemLogger("session-lock");

/**
 * Synchronously release all held locks.
 * Used during process exit when async operations aren't reliable.
 */
function releaseAllLocksSync(): void {
  HELD_LOCKS.clear();
}

let cleanupRegistered = false;

function registerCleanupHandlers(): void {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;
  process.on("exit", () => {
    releaseAllLocksSync();
  });
}

function lockNameForSessionFile(sessionFile: string): string {
  let normalized = sessionFile.trim();
  try {
    normalized = fsSync.realpathSync(normalized);
  } catch {
    // best-effort normalization
  }
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `session-file:${hash}`;
}

export async function acquireSessionWriteLock(params: {
  sessionFile: string;
  timeoutMs?: number;
  staleMs?: number;
}): Promise<{
  release: () => Promise<void>;
}> {
  registerCleanupHandlers();
  const timeoutMs = params.timeoutMs ?? 10_000;
  const staleMs = params.staleMs ?? 30 * 60 * 1000;
  const lockName = lockNameForSessionFile(params.sessionFile);

  const held = HELD_LOCKS.get(lockName);
  if (held) {
    held.count += 1;
    return {
      release: async () => {
        const current = HELD_LOCKS.get(lockName);
        if (!current) {
          return;
        }
        current.count -= 1;
        if (current.count > 0) {
          return;
        }
        HELD_LOCKS.delete(lockName);
        try {
          const storage = await getS3dbStorage();
          await storage.releaseLock(current.lock.name, current.lock.token);
        } catch (err) {
          log.warn({ err: String(err) }, "failed releasing session write lock");
        }
      },
    };
  }

  const storage = await getS3dbStorage();
  const ttlSeconds = Math.max(10, Math.ceil(staleMs / 1000));
  const lock = await storage.acquireLock(lockName, {
    timeout: timeoutMs,
    ttl: ttlSeconds,
    workerId: String(process.pid),
  });
  if (!lock) {
    throw new Error(`session file locked (timeout ${timeoutMs}ms): ${lockName}`);
  }

  HELD_LOCKS.set(lockName, {
    count: 1,
    lock: {
      name: lock.name,
      token: lock.token,
    },
  });

  return {
    release: async () => {
      const current = HELD_LOCKS.get(lockName);
      if (!current) {
        return;
      }
      current.count -= 1;
      if (current.count > 0) {
        return;
      }
      HELD_LOCKS.delete(lockName);
      try {
        await storage.releaseLock(current.lock.name, current.lock.token);
      } catch (err) {
        log.warn({ err: String(err) }, "failed releasing session write lock");
      }
    },
  };
}

export const __testing = {
  releaseAllLocksSync,
};
