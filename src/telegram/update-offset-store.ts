import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { buildS3dbKey, getS3dbStorage } from "../persistence/s3db.js";

const STORE_VERSION = 1;
const TELEGRAM_OFFSET_NAMESPACE = "telegram/update-offset";

type TelegramUpdateOffsetState = {
  version: number;
  lastUpdateId: number | null;
};

function normalizeAccountId(accountId?: string) {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function resolveTelegramUpdateOffsetPath(
  accountId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = resolveStateDir(env, os.homedir);
  const normalized = normalizeAccountId(accountId);
  return path.join(stateDir, "telegram", `update-offset-${normalized}.json`);
}

function resolveTelegramUpdateOffsetKey(accountId?: string): string {
  return buildS3dbKey(TELEGRAM_OFFSET_NAMESPACE, normalizeAccountId(accountId));
}

function safeParseState(raw: string): TelegramUpdateOffsetState | null {
  try {
    const parsed = JSON.parse(raw) as TelegramUpdateOffsetState;
    if (parsed?.version !== STORE_VERSION) {
      return null;
    }
    if (parsed.lastUpdateId !== null && typeof parsed.lastUpdateId !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function readTelegramUpdateOffset(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<number | null> {
  const storage = await getS3dbStorage();
  const key = resolveTelegramUpdateOffsetKey(params.accountId);
  const raw = await storage.get(key);
  if (raw && typeof raw === "object") {
    const record = raw as TelegramUpdateOffsetState;
    if (record?.version === STORE_VERSION) {
      return typeof record.lastUpdateId === "number" ? record.lastUpdateId : null;
    }
  }

  const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
  try {
    const rawFile = await fs.readFile(filePath, "utf-8");
    const parsed = safeParseState(rawFile);
    if (!parsed) {
      return null;
    }
    await storage.set(key, parsed as unknown as Record<string, unknown>, { behavior: "body-only" });
    await fs.rm(filePath, { force: true });
    return parsed.lastUpdateId ?? null;
  } catch {
    return null;
  }
}

export async function writeTelegramUpdateOffset(params: {
  accountId?: string;
  updateId: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const payload: TelegramUpdateOffsetState = {
    version: STORE_VERSION,
    lastUpdateId: params.updateId,
  };
  const storage = await getS3dbStorage();
  const key = resolveTelegramUpdateOffsetKey(params.accountId);
  await storage.set(key, payload as unknown as Record<string, unknown>, { behavior: "body-only" });
  void params.env;
}
