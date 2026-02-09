import JSON5 from "json5";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CronStoreFile } from "./types.js";
import { buildS3dbKey, getS3dbStorage } from "../persistence/s3db.js";
import { CONFIG_DIR } from "../utils.js";

export const DEFAULT_CRON_DIR = path.join(CONFIG_DIR, "cron");
export const DEFAULT_CRON_STORE_PATH = path.join(DEFAULT_CRON_DIR, "jobs.json");
const CRON_STORE_NAMESPACE = "cron/store";

export function resolveCronStorePath(storePath?: string) {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(raw.replace("~", os.homedir()));
    }
    return path.resolve(raw);
  }
  return DEFAULT_CRON_STORE_PATH;
}

function resolveCronStoreKey(storePath: string): string {
  return buildS3dbKey(CRON_STORE_NAMESPACE, storePath);
}

function coerceCronStore(raw: unknown): CronStoreFile | null {
  const parsedRecord =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const jobs = Array.isArray(parsedRecord.jobs) ? (parsedRecord.jobs as never[]) : [];
  return {
    version: 1,
    jobs: jobs.filter(Boolean) as never as CronStoreFile["jobs"],
  };
}

async function readCronStoreFromDisk(storePath: string): Promise<CronStoreFile | null> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON5.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse cron store at ${storePath}: ${String(err)}`, {
        cause: err,
      });
    }
    return coerceCronStore(parsed);
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  const storage = await getS3dbStorage();
  const key = resolveCronStoreKey(storePath);
  const raw = await storage.get(key);
  const fromS3db = coerceCronStore(raw);
  if (fromS3db) {
    return fromS3db;
  }

  const legacy = await readCronStoreFromDisk(storePath);
  if (legacy) {
    await storage.set(key, legacy as unknown as Record<string, unknown>, { behavior: "body-only" });
    try {
      await fs.promises.rm(storePath, { force: true });
      await fs.promises.rm(`${storePath}.bak`, { force: true });
    } catch {
      // best-effort cleanup
    }
    return legacy;
  }

  return { version: 1, jobs: [] };
}

export async function saveCronStore(storePath: string, store: CronStoreFile) {
  const storage = await getS3dbStorage();
  const key = resolveCronStoreKey(storePath);
  await storage.set(key, store as unknown as Record<string, unknown>, { behavior: "body-only" });
}
