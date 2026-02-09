import crypto from "node:crypto";
import { S3db, PluginStorage } from "s3db.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("s3db");

const CONNECTION_HINT =
  "Set OPENCLAW_S3DB_URL (or S3DB_URL / S3DB_CONNECTION) to a valid connection string (ex: s3://... or memory://...).";
const DEFAULT_TEST_CONNECTION = "memory://openclaw-test";
const STORAGE_SLUG = "openclaw";

let dbPromise: Promise<S3db> | null = null;
let storagePromise: Promise<PluginStorage> | null = null;

export function isS3dbEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.OPENCLAW_S3DB_URL?.trim() ||
    env.S3DB_URL?.trim() ||
    env.S3DB_CONNECTION?.trim() ||
    env.VITEST === "true" ||
    env.NODE_ENV === "test",
  );
}

export function resolveS3dbConnectionString(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OPENCLAW_S3DB_URL?.trim() || env.S3DB_URL?.trim() || env.S3DB_CONNECTION?.trim();
  if (!raw) {
    if (env.VITEST === "true" || env.NODE_ENV === "test") {
      return DEFAULT_TEST_CONNECTION;
    }
    throw new Error(`OpenClaw s3db persistence requires OPENCLAW_S3DB_URL. ${CONNECTION_HINT}`);
  }
  return raw;
}

export async function getS3db(): Promise<S3db> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = (async () => {
    const connectionString = resolveS3dbConnectionString();
    const db = new S3db({ connectionString });
    try {
      await db.connect();
    } catch (err) {
      dbPromise = null;
      throw err;
    }
    log.info({ connectionString }, "s3db connected");
    return db;
  })();

  return dbPromise;
}

export async function getS3dbStorage(): Promise<PluginStorage> {
  if (storagePromise) {
    return storagePromise;
  }
  storagePromise = (async () => {
    const db = await getS3db();
    return new PluginStorage(
      db.client as unknown as ConstructorParameters<typeof PluginStorage>[0],
      STORAGE_SLUG,
    );
  })();
  return storagePromise;
}

export function s3dbStorageSlug(): string {
  return STORAGE_SLUG;
}

export function buildS3dbKey(namespace: string, raw: string): string {
  const normalized = raw.replace(/\\/g, "/").trim();
  const safe = normalized.replace(/[^a-zA-Z0-9._/-]+/g, "_").slice(-120) || "item";
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `plugin=${STORAGE_SLUG}/${namespace}/${safe}-${hash}`;
}

export function resetS3dbForTest(): void {
  dbPromise = null;
  storagePromise = null;
}
