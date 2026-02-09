import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import { hydrateAuthProfileStoreFromS3db } from "../agents/auth-profiles/store.js";
import { loadConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { hydrateSessionStoreFromS3db } from "../config/sessions/store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";

const log = createSubsystemLogger("persistence");

function listConfiguredAgentIds(cfg: ReturnType<typeof loadConfig>): string[] {
  const agents = cfg.agents?.list ?? [];
  const ids = new Set<string>();
  for (const entry of agents) {
    if (entry?.id) {
      ids.add(normalizeAgentId(entry.id));
    }
  }
  ids.add(normalizeAgentId(resolveDefaultAgentId(cfg)));
  return Array.from(ids).filter(Boolean);
}

export async function initS3dbPersistence(): Promise<void> {
  const cfg = loadConfig();
  const storeConfig = cfg.session?.store;
  const agentIds = listConfiguredAgentIds(cfg);
  const storePaths: string[] = [];

  if (typeof storeConfig === "string" && !storeConfig.includes("{agentId}")) {
    storePaths.push(resolveStorePath(storeConfig));
  } else {
    for (const agentId of agentIds) {
      storePaths.push(resolveStorePath(storeConfig, { agentId }));
    }
  }

  await Promise.all(
    storePaths.map(async (storePath) => {
      try {
        await hydrateSessionStoreFromS3db(storePath);
      } catch (err) {
        log.warn({ err: String(err), storePath }, "failed to hydrate session store from s3db");
      }
    }),
  );

  const authPaths = new Set<string>();
  authPaths.add(resolveAuthStorePath());
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
  for (const entry of agents) {
    if (entry?.agentDir) {
      authPaths.add(resolveAuthStorePath(entry.agentDir));
    }
  }

  await Promise.all(
    [...authPaths].map(async (authPath) => {
      try {
        await hydrateAuthProfileStoreFromS3db(authPath);
      } catch (err) {
        log.warn({ err: String(err), authPath }, "failed to hydrate auth profile store from s3db");
      }
    }),
  );
}
