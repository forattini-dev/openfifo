import fs from "node:fs/promises";
import path from "node:path";
import type { SubagentRunRecord } from "./subagent-registry.js";
import { STATE_DIR } from "../config/paths.js";
import { buildS3dbKey, getS3dbStorage } from "../persistence/s3db.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";

export type PersistedSubagentRegistryVersion = 1 | 2;

type PersistedSubagentRegistryV1 = {
  version: 1;
  runs: Record<string, LegacySubagentRunRecord>;
};

type PersistedSubagentRegistryV2 = {
  version: 2;
  runs: Record<string, PersistedSubagentRunRecord>;
};

type PersistedSubagentRegistry = PersistedSubagentRegistryV1 | PersistedSubagentRegistryV2;

const REGISTRY_VERSION = 2 as const;
const REGISTRY_NAMESPACE = "subagent-registry";

type PersistedSubagentRunRecord = SubagentRunRecord;

type LegacySubagentRunRecord = PersistedSubagentRunRecord & {
  announceCompletedAt?: unknown;
  announceHandled?: unknown;
  requesterChannel?: unknown;
  requesterAccountId?: unknown;
};

export function resolveSubagentRegistryPath(): string {
  return path.join(STATE_DIR, "subagents", "runs.json");
}

function resolveSubagentRegistryKey(): string {
  return buildS3dbKey(REGISTRY_NAMESPACE, resolveSubagentRegistryPath());
}

async function readLegacyRegistry(): Promise<unknown> {
  const pathname = resolveSubagentRegistryPath();
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export async function loadSubagentRegistryFromDisk(): Promise<Map<string, SubagentRunRecord>> {
  const storage = await getS3dbStorage();
  const key = resolveSubagentRegistryKey();
  let raw = await storage.get(key);
  if (!raw) {
    raw = await readLegacyRegistry();
    if (raw && typeof raw === "object") {
      await storage.set(key, raw as Record<string, unknown>, { behavior: "body-only" });
      try {
        await fs.rm(resolveSubagentRegistryPath(), { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }

  if (!raw || typeof raw !== "object") {
    return new Map();
  }
  const record = raw as Partial<PersistedSubagentRegistry>;
  if (record.version !== 1 && record.version !== 2) {
    return new Map();
  }
  const runsRaw = record.runs;
  if (!runsRaw || typeof runsRaw !== "object") {
    return new Map();
  }
  const out = new Map<string, SubagentRunRecord>();
  const isLegacy = record.version === 1;
  let migrated = false;
  for (const [runId, entry] of Object.entries(runsRaw)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const typed = entry as LegacySubagentRunRecord;
    if (!typed.runId || typeof typed.runId !== "string") {
      continue;
    }
    const legacyCompletedAt =
      isLegacy && typeof typed.announceCompletedAt === "number"
        ? typed.announceCompletedAt
        : undefined;
    const cleanupCompletedAt =
      typeof typed.cleanupCompletedAt === "number" ? typed.cleanupCompletedAt : legacyCompletedAt;
    const cleanupHandled =
      typeof typed.cleanupHandled === "boolean"
        ? typed.cleanupHandled
        : isLegacy
          ? Boolean(typed.announceHandled ?? cleanupCompletedAt)
          : undefined;
    const requesterOrigin = normalizeDeliveryContext(
      typed.requesterOrigin ?? {
        channel: typeof typed.requesterChannel === "string" ? typed.requesterChannel : undefined,
        accountId:
          typeof typed.requesterAccountId === "string" ? typed.requesterAccountId : undefined,
      },
    );
    const {
      announceCompletedAt: _announceCompletedAt,
      announceHandled: _announceHandled,
      requesterChannel: _channel,
      requesterAccountId: _accountId,
      ...rest
    } = typed;
    out.set(runId, {
      ...rest,
      requesterOrigin,
      cleanupCompletedAt,
      cleanupHandled,
    });
    if (isLegacy) {
      migrated = true;
    }
  }
  if (migrated) {
    try {
      await saveSubagentRegistryToDisk(out);
    } catch {
      // ignore migration write failures
    }
  }
  return out;
}

export async function saveSubagentRegistryToDisk(
  runs: Map<string, SubagentRunRecord>,
): Promise<void> {
  const storage = await getS3dbStorage();
  const serialized: Record<string, PersistedSubagentRunRecord> = {};
  for (const [runId, entry] of runs.entries()) {
    serialized[runId] = entry;
  }
  const out: PersistedSubagentRegistry = {
    version: REGISTRY_VERSION,
    runs: serialized,
  };
  const key = resolveSubagentRegistryKey();
  await storage.set(key, out as unknown as Record<string, unknown>, { behavior: "body-only" });
}
