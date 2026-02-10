import type { OpenClawConfig } from "../../config/config.js";
import type { CronQueueGatewayConfig, CronQueueRole } from "../../config/types.cron.js";

export const DEFAULT_CRON_QUEUE_RESOURCE = "cron_tasks";
export const DEFAULT_CRON_QUEUE_SCHEDULER_CRON = "* * * * *";

const ROLE_SYNONYMS: Record<string, CronQueueRole | "all"> = {
  all: "all",
  single: "all",
  gateway: "gateway",
  scheduler: "scheduler",
  worker: "worker",
  sched: "scheduler",
};

function normalizeRole(raw: string): CronQueueRole | "all" | null {
  const key = raw.trim().toLowerCase();
  return ROLE_SYNONYMS[key] ?? null;
}

function parseRoles(raw: string): CronQueueRole[] {
  const parts = raw
    .split(/[\n\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return [];
  }
  const roles = new Set<CronQueueRole>();
  for (const part of parts) {
    const normalized = normalizeRole(part);
    if (!normalized) {
      continue;
    }
    if (normalized === "all") {
      return ["gateway", "scheduler", "worker"];
    }
    roles.add(normalized);
  }
  return Array.from(roles);
}

export function resolveCronMode(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): "local" | "queue" {
  const envMode = env.OPENCLAW_CRON_MODE?.trim().toLowerCase();
  if (envMode === "queue") {
    return "queue";
  }
  if (envMode === "local") {
    return "local";
  }
  return cfg.cron?.mode === "queue" ? "queue" : "local";
}

export function resolveCronQueueRoles(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  mode?: "local" | "queue",
): CronQueueRole[] {
  const envRaw = env.OPENCLAW_CRON_ROLES?.trim() || env.OPENCLAW_CRON_ROLE?.trim();
  const envRoles = envRaw ? parseRoles(envRaw) : [];
  if (envRoles.length > 0) {
    return envRoles;
  }

  const cfgRoles = Array.isArray(cfg.cron?.queue?.roles) ? cfg.cron?.queue?.roles : [];
  const normalized = cfgRoles
    .map((role) => (typeof role === "string" ? normalizeRole(role) : null))
    .filter((role): role is CronQueueRole => !!role && role !== "all");
  if (normalized.length > 0) {
    return Array.from(new Set(normalized));
  }

  const resolvedMode = mode ?? resolveCronMode(cfg, env);
  if (resolvedMode === "queue") {
    return ["gateway", "scheduler", "worker"];
  }

  return [];
}

export function resolveCronQueueGateway(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): CronQueueGatewayConfig {
  const gateway = cfg.cron?.queue?.gateway ?? {};
  const basicCfg = gateway.basic ?? {};
  const envUrl = env.OPENCLAW_CRON_GATEWAY_URL?.trim();
  const envToken = env.OPENCLAW_CRON_GATEWAY_TOKEN?.trim();
  const envPassword = env.OPENCLAW_CRON_GATEWAY_PASSWORD?.trim();
  const envBasicUser = env.OPENCLAW_CRON_GATEWAY_BASIC_USER?.trim();
  const envBasicPassword = env.OPENCLAW_CRON_GATEWAY_BASIC_PASSWORD?.trim();
  const envFingerprint = env.OPENCLAW_CRON_GATEWAY_TLS_FINGERPRINT?.trim();
  const envTimeoutRaw = env.OPENCLAW_CRON_GATEWAY_TIMEOUT_MS?.trim();
  const envTimeout =
    envTimeoutRaw && Number.isFinite(Number(envTimeoutRaw))
      ? Math.max(1, Math.floor(Number(envTimeoutRaw)))
      : undefined;

  return {
    url: envUrl || gateway.url,
    token: envToken || gateway.token,
    password: envPassword || gateway.password,
    basic: {
      user: envBasicUser || basicCfg.user,
      password: envBasicPassword || basicCfg.password,
    },
    tlsFingerprint: envFingerprint || gateway.tlsFingerprint,
    timeoutMs: envTimeout ?? gateway.timeoutMs,
  };
}
