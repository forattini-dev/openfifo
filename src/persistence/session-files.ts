import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildS3dbKey, getS3dbStorage } from "./s3db.js";

const log = createSubsystemLogger("session-files");
const SESSION_FILES_NAMESPACE = "sessions/files";

type SessionFileRecord = {
  content: string;
  updatedAt: number;
  path: string;
};

function resolveSessionFileKey(sessionFile: string): string {
  return buildS3dbKey(SESSION_FILES_NAMESPACE, sessionFile);
}

function coerceSessionFileRecord(raw: Record<string, unknown> | null): SessionFileRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const content = typeof raw.content === "string" ? raw.content : null;
  const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : 0;
  const storedPath = typeof raw.path === "string" ? raw.path : "";
  if (content === null) {
    return null;
  }
  return {
    content,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    path: storedPath,
  };
}

export async function readSessionFileFromS3db(
  sessionFile: string,
): Promise<SessionFileRecord | null> {
  const storage = await getS3dbStorage();
  const key = resolveSessionFileKey(sessionFile);
  const raw = await storage.get(key);
  return coerceSessionFileRecord(raw);
}

export async function ensureSessionFileCached(sessionFile: string): Promise<{
  ok: boolean;
  fromS3db: boolean;
  updatedAt?: number;
}> {
  const record = await readSessionFileFromS3db(sessionFile);
  if (!record) {
    return { ok: false, fromS3db: false };
  }

  let localMtime = 0;
  try {
    const stat = await fs.stat(sessionFile);
    localMtime = stat.mtimeMs ?? 0;
  } catch {
    localMtime = 0;
  }

  if (localMtime >= record.updatedAt && localMtime > 0) {
    return { ok: true, fromS3db: false, updatedAt: record.updatedAt };
  }

  await fs.mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(sessionFile, record.content, { encoding: "utf-8", mode: 0o600 });
  try {
    const ts = record.updatedAt / 1000;
    if (Number.isFinite(ts) && ts > 0) {
      await fs.utimes(sessionFile, ts, ts);
    }
  } catch {
    // best-effort
  }

  return { ok: true, fromS3db: true, updatedAt: record.updatedAt };
}

export async function persistSessionFileToS3db(sessionFile: string): Promise<void> {
  let content = "";
  try {
    content = await fs.readFile(sessionFile, "utf-8");
  } catch {
    return;
  }
  const storage = await getS3dbStorage();
  const key = resolveSessionFileKey(sessionFile);
  const updatedAt = Date.now();
  await storage.set(
    key,
    {
      content,
      updatedAt,
      path: sessionFile,
    },
    { behavior: "body-only" },
  );
}

export async function writeSessionFileContent(params: {
  sessionFile: string;
  content: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(params.sessionFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(params.sessionFile, params.content, { encoding: "utf-8", mode: 0o600 });
  await persistSessionFileToS3db(params.sessionFile);
}

export async function deleteSessionFileFromS3db(sessionFile: string): Promise<void> {
  const storage = await getS3dbStorage();
  const key = resolveSessionFileKey(sessionFile);
  await storage.delete(key).catch(() => undefined);
}

export async function archiveSessionFile(params: {
  sessionFile: string;
  reason: string;
}): Promise<string | null> {
  const storage = await getS3dbStorage();
  const originalKey = resolveSessionFileKey(params.sessionFile);
  const suffix = new Date().toISOString().replaceAll(":", "-");
  const archivedKey = buildS3dbKey(
    `${SESSION_FILES_NAMESPACE}/archive`,
    `${params.sessionFile}.${params.reason}.${suffix}`,
  );
  const record = await storage.get(originalKey);
  if (!record) {
    return null;
  }
  await storage.set(archivedKey, record as Record<string, unknown>, { behavior: "body-only" });
  await storage.delete(originalKey).catch(() => undefined);
  try {
    if (fsSync.existsSync(params.sessionFile)) {
      await fs.rm(params.sessionFile, { force: true });
    }
  } catch (err) {
    log.warn({ err: String(err) }, "failed to remove local session file after archive");
  }
  return archivedKey;
}
