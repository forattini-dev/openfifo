import { SchedulerPlugin, S3QueuePlugin, StateMachinePlugin } from "s3db.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { CronQueueRole } from "../../config/types.cron.js";
import { callGateway } from "../../gateway/call.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getS3db } from "../../persistence/s3db.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { computeJobNextRunAtMs } from "../service/jobs.js";
import { locked } from "../service/locked.js";
import { createCronServiceState } from "../service/state.js";
import { ensureLoaded, persist } from "../service/store.js";
import { resolveCronStorePath } from "../store.js";
import {
  DEFAULT_CRON_QUEUE_RESOURCE,
  DEFAULT_CRON_QUEUE_SCHEDULER_CRON,
  resolveCronMode,
  resolveCronQueueGateway,
  resolveCronQueueRoles,
} from "./config.js";

const DEFAULT_QUEUE_VISIBILITY_MS = 30_000;
const DEFAULT_QUEUE_POLL_MS = 1_000;
const DEFAULT_QUEUE_MAX_ATTEMPTS = 3;
const DEFAULT_QUEUE_CONCURRENCY = 1;
const DEFAULT_SCHEDULER_BATCH_LIMIT = 25;
const DEFAULT_GATEWAY_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_STATE_FIELD = "status";
const STUCK_RUN_MS = 2 * 60 * 60 * 1000;

export type CronQueueRuntime = {
  roles: CronQueueRole[];
  schedulerEnabled: boolean;
  workerEnabled: boolean;
  stop: () => Promise<void>;
};

type QueueRecord = Record<string, unknown> & {
  id: string;
  jobId?: string;
  runMode?: string;
  runAtMs?: number;
  queuedAtMs?: number;
  maxAttempts?: number;
};

function isCronEnabled(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  return env.OPENCLAW_SKIP_CRON !== "1" && cfg.cron?.enabled !== false;
}

function resolveStaleEnqueueMs(params: { visibilityTimeoutMs: number; maxAttempts: number }) {
  return Math.max(5 * 60_000, params.visibilityTimeoutMs * Math.max(1, params.maxAttempts));
}

function refreshCronStateForScheduler(state: ReturnType<typeof createCronServiceState>): boolean {
  if (!state.store) {
    return false;
  }
  let changed = false;
  const now = state.deps.nowMs();
  for (const job of state.store.jobs) {
    if (!job.state) {
      job.state = {};
      changed = true;
    }
    if (!job.enabled) {
      if (job.state.nextRunAtMs !== undefined) {
        job.state.nextRunAtMs = undefined;
        changed = true;
      }
      if (job.state.runningAtMs !== undefined) {
        job.state.runningAtMs = undefined;
        changed = true;
      }
      continue;
    }
    const runningAt = job.state.runningAtMs;
    if (typeof runningAt === "number" && now - runningAt > STUCK_RUN_MS) {
      job.state.runningAtMs = undefined;
      changed = true;
    }
    if (job.state.nextRunAtMs === undefined) {
      const next = computeJobNextRunAtMs(job, now);
      if (job.state.nextRunAtMs !== next) {
        job.state.nextRunAtMs = next;
        changed = true;
      }
    }
  }
  return changed;
}

async function ensureCronQueueResource(params: {
  db: Awaited<ReturnType<typeof getS3db>>;
  name: string;
  stateField: string;
}) {
  const { db, name, stateField } = params;
  if (db.resourceExists(name)) {
    return db.resources[name] as unknown as {
      enqueue?: (
        data: Record<string, unknown>,
        options?: { maxAttempts?: number },
      ) => Promise<Record<string, unknown>>;
      state?: { initialize?: (id: string, context?: Record<string, unknown>) => Promise<unknown> };
    };
  }

  const attributes: Record<string, string> = {
    jobId: "string|required",
    runMode: "string|default:due",
    runAtMs: "number|required",
    queuedAtMs: "number|required",
    maxAttempts: "number|required",
  };
  attributes[stateField] = "string|required";

  const resource = await db.createResource({
    name,
    attributes,
    behavior: "body-overflow",
    timestamps: true,
    partitions: {
      byJob: { fields: { jobId: "string" } },
      byStatus: { fields: { [stateField]: "string" } },
    },
  });

  return resource as unknown as {
    enqueue?: (
      data: Record<string, unknown>,
      options?: { maxAttempts?: number },
    ) => Promise<Record<string, unknown>>;
    state?: { initialize?: (id: string, context?: Record<string, unknown>) => Promise<unknown> };
  };
}

function buildStateMachineConfig(params: { resource: string; stateField: string }) {
  return {
    initialState: "queued",
    resource: params.resource,
    stateField: params.stateField,
    states: {
      queued: {
        on: {
          START: "running",
          SKIP: "skipped",
          FAIL: "failed",
        },
      },
      running: {
        on: {
          SUCCEED: "succeeded",
          SKIP: "skipped",
          FAIL: "failed",
          RETRY: "queued",
          DEAD: "dead",
        },
      },
      failed: {
        on: {
          RETRY: "queued",
          DEAD: "dead",
        },
      },
      succeeded: {
        type: "final",
      },
      skipped: {
        type: "final",
      },
      dead: {
        type: "final",
      },
    },
  };
}

async function enqueueDueJobs(params: {
  cfg: OpenClawConfig;
  cronState: ReturnType<typeof createCronServiceState>;
  queueResource: {
    enqueue?: (
      data: Record<string, unknown>,
      options?: { maxAttempts?: number },
    ) => Promise<Record<string, unknown>>;
    state?: { initialize?: (id: string, context?: Record<string, unknown>) => Promise<unknown> };
  };
  stateMachineEnabled: boolean;
  stateField: string;
  schedulerBatchLimit: number;
  staleEnqueueMs: number;
  maxAttempts: number;
  logger: ReturnType<typeof createSubsystemLogger>;
}) {
  const {
    cfg,
    cronState,
    queueResource,
    stateMachineEnabled,
    stateField,
    schedulerBatchLimit,
    staleEnqueueMs,
    maxAttempts,
    logger,
  } = params;

  if (!isCronEnabled(cfg, process.env)) {
    return { queued: 0, skipped: 0, errors: 0 };
  }

  const now = Date.now();

  const dueJobs = await locked(cronState, async () => {
    await ensureLoaded(cronState, { forceReload: true, skipRecompute: true });
    if (!cronState.store) {
      return [] as typeof cronState.store.jobs;
    }
    const changed = refreshCronStateForScheduler(cronState);
    if (changed) {
      await persist(cronState);
    }
    return cronState.store.jobs
      .filter((job) => {
        if (!job.enabled) {
          return false;
        }
        if (typeof job.state.runningAtMs === "number") {
          return false;
        }
        const nextRun = job.state.nextRunAtMs;
        if (typeof nextRun !== "number" || nextRun > now) {
          return false;
        }
        const enqueuedAt = job.state.enqueuedAtMs;
        if (typeof enqueuedAt === "number" && now - enqueuedAt < staleEnqueueMs) {
          return false;
        }
        return true;
      })
      .toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));
  });

  if (!queueResource.enqueue || dueJobs.length === 0) {
    return { queued: 0, skipped: dueJobs.length, errors: 0 };
  }

  const queueable = dueJobs.slice(0, schedulerBatchLimit);
  const queuedJobIds: string[] = [];
  let errors = 0;

  for (const job of queueable) {
    try {
      const record = await queueResource.enqueue(
        {
          jobId: job.id,
          runMode: "due",
          runAtMs: job.state.nextRunAtMs ?? now,
          queuedAtMs: now,
          [stateField]: "queued",
          maxAttempts,
        },
        { maxAttempts },
      );

      if (stateMachineEnabled) {
        const state = queueResource.state;
        if (state?.initialize) {
          try {
            await state.initialize(record.id, {
              jobId: job.id,
              runAtMs: job.state.nextRunAtMs ?? now,
            });
          } catch (err) {
            logger.warn({ err: String(err), taskId: record.id }, "cron queue: state init failed");
          }
        }
      }

      queuedJobIds.push(job.id);
    } catch (err) {
      errors += 1;
      logger.warn({ err: String(err), jobId: job.id }, "cron queue: enqueue failed");
    }
  }

  if (queuedJobIds.length > 0) {
    await locked(cronState, async () => {
      await ensureLoaded(cronState, { forceReload: true, skipRecompute: true });
      if (!cronState.store) {
        return;
      }
      for (const jobId of queuedJobIds) {
        const job = cronState.store.jobs.find((entry) => entry.id === jobId);
        if (job) {
          job.state.enqueuedAtMs = now;
        }
      }
      await persist(cronState);
    });
  }

  return { queued: queuedJobIds.length, skipped: dueJobs.length - queueable.length, errors };
}

export async function startCronQueueRuntime(params: {
  cfg: OpenClawConfig;
  roles?: CronQueueRole[];
  env?: NodeJS.ProcessEnv;
}): Promise<CronQueueRuntime | null> {
  const env = params.env ?? process.env;
  const cfg = params.cfg;
  const mode = resolveCronMode(cfg, env);
  if (mode !== "queue") {
    return null;
  }
  if (!isCronEnabled(cfg, env)) {
    return null;
  }

  const roles = params.roles ?? resolveCronQueueRoles(cfg, env, mode);
  const schedulerEnabled =
    roles.includes("scheduler") && cfg.cron?.queue?.scheduler?.enabled !== false;
  const workerEnabled = roles.includes("worker") && cfg.cron?.queue?.worker?.enabled !== false;
  if (!schedulerEnabled && !workerEnabled) {
    return null;
  }

  const logger = createSubsystemLogger("cron-queue");
  const queueCfg = cfg.cron?.queue ?? {};
  const resourceName = queueCfg.resource?.trim() || DEFAULT_CRON_QUEUE_RESOURCE;
  const stateField = queueCfg.stateMachine?.stateField?.trim() || DEFAULT_STATE_FIELD;
  const maxAttempts = Math.max(1, queueCfg.maxAttempts ?? DEFAULT_QUEUE_MAX_ATTEMPTS);
  const visibilityTimeoutMs = Math.max(
    1,
    queueCfg.visibilityTimeoutMs ?? DEFAULT_QUEUE_VISIBILITY_MS,
  );
  const pollIntervalMs = Math.max(1, queueCfg.pollIntervalMs ?? DEFAULT_QUEUE_POLL_MS);
  const baseConcurrency =
    queueCfg.concurrency ?? cfg.cron?.maxConcurrentRuns ?? DEFAULT_QUEUE_CONCURRENCY;
  const workerConcurrency = Math.max(1, queueCfg.worker?.concurrency ?? baseConcurrency);
  const orderingMode = queueCfg.orderingMode ?? "fifo";
  const enableCoordinator = queueCfg.enableCoordinator ?? true;
  const deadLetterEnabled = Boolean(queueCfg.deadLetterResource?.trim());
  const schedulerSchedule =
    queueCfg.scheduler?.schedule?.trim() || DEFAULT_CRON_QUEUE_SCHEDULER_CRON;
  const schedulerBatchLimit = Math.max(
    1,
    queueCfg.scheduler?.batchLimit ?? DEFAULT_SCHEDULER_BATCH_LIMIT,
  );
  const staleEnqueueMs =
    queueCfg.scheduler?.staleEnqueueMs ??
    resolveStaleEnqueueMs({ visibilityTimeoutMs, maxAttempts });
  const stateMachineEnabled = queueCfg.stateMachine?.enabled !== false;
  const gatewayConfig = resolveCronQueueGateway(cfg, env);
  const gatewayTimeoutMs =
    typeof gatewayConfig.timeoutMs === "number" && Number.isFinite(gatewayConfig.timeoutMs)
      ? gatewayConfig.timeoutMs
      : DEFAULT_GATEWAY_TIMEOUT_MS;

  const db = await getS3db();
  const queueResource = await ensureCronQueueResource({
    db,
    name: resourceName,
    stateField,
  });

  let stateMachine: StateMachinePlugin | null = null;
  const stateMachineId = "cronQueue";
  if (stateMachineEnabled) {
    stateMachine = new StateMachinePlugin({
      stateMachines: {
        [stateMachineId]: buildStateMachineConfig({ resource: resourceName, stateField }),
      },
      transitionLogResource: queueCfg.stateMachine?.transitionLogResource,
      stateResource: queueCfg.stateMachine?.stateResource,
    });
    await db.usePlugin(stateMachine, "openclaw-cron-queue-state");
    await stateMachine.start();
  }

  const onMessage = workerEnabled
    ? async (
        record: Record<string, unknown>,
        context: {
          queueId: string;
          attempts: number;
          workerId: string;
          lockToken: string;
          visibleUntil: number;
          renewLock: (extra?: number) => Promise<boolean>;
        },
      ) => {
        const task = record as QueueRecord;
        const jobId = typeof task.jobId === "string" ? task.jobId.trim() : "";
        if (!jobId) {
          throw new Error("cron queue record missing jobId");
        }
        const runMode = task.runMode === "force" ? "force" : "due";
        const maxAttemptsValue =
          typeof task.maxAttempts === "number" && Number.isFinite(task.maxAttempts)
            ? task.maxAttempts
            : maxAttempts;

        const state = (queueResource as any).state;
        const sendState = async (event: string, extra?: Record<string, unknown>) => {
          if (!stateMachineEnabled || !state?.send) {
            return;
          }
          try {
            await state.send(task.id, event, {
              jobId,
              queueId: context.queueId,
              attempts: context.attempts,
              ...extra,
            });
          } catch (err) {
            logger.warn(
              { err: String(err), taskId: task.id, event },
              "cron queue: state transition failed",
            );
          }
        };

        await sendState("START");

        try {
          const result = await callGateway({
            config: cfg,
            url: gatewayConfig.url,
            token: gatewayConfig.token,
            password: gatewayConfig.password,
            basicUser: gatewayConfig.basic?.user,
            basicPassword: gatewayConfig.basic?.password,
            tlsFingerprint: gatewayConfig.tlsFingerprint,
            timeoutMs: gatewayTimeoutMs,
            method: "cron.run",
            params: { id: jobId, mode: runMode },
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          });

          const payload = result as unknown as { ok?: boolean; ran?: boolean; reason?: string };
          if (payload.ok === true) {
            if (payload.ran) {
              await sendState("SUCCEED");
            } else {
              await sendState("SKIP", { reason: payload.reason ?? "not-due" });
            }
            return result;
          }
          throw new Error(payload.reason ?? "cron.run failed");
        } catch (err) {
          const shouldRetry = context.attempts < maxAttemptsValue;
          const finalEvent = shouldRetry ? "RETRY" : deadLetterEnabled ? "DEAD" : "FAIL";
          await sendState(finalEvent, { error: String(err) });
          throw err;
        }
      }
    : undefined;

  const queuePlugin = new S3QueuePlugin({
    resource: resourceName,
    deadLetterResource: queueCfg.deadLetterResource ?? null,
    visibilityTimeout: visibilityTimeoutMs,
    pollInterval: pollIntervalMs,
    maxAttempts,
    concurrency: workerConcurrency,
    orderingMode,
    enableCoordinator,
    autoStart: workerEnabled,
    onMessage,
  });
  await db.usePlugin(queuePlugin, "openclaw-cron-queue");

  let schedulerPlugin: SchedulerPlugin | null = null;
  if (schedulerEnabled) {
    const cronState = createCronServiceState({
      log: createSubsystemLogger("cron-queue-store"),
      storePath: resolveCronStorePath(cfg.cron?.store),
      cronEnabled: true,
      enqueueSystemEvent: () => {},
      requestHeartbeatNow: () => {},
      runIsolatedAgentJob: async () => ({ status: "skipped" }),
    });

    schedulerPlugin = new SchedulerPlugin({
      timezone: queueCfg.scheduler?.timezone,
      jobs: {
        cron_queue_dispatch: {
          schedule: schedulerSchedule,
          action: async () =>
            await enqueueDueJobs({
              cfg,
              cronState,
              queueResource,
              stateMachineEnabled,
              stateField,
              schedulerBatchLimit,
              staleEnqueueMs,
              maxAttempts,
              logger,
            }),
        },
      },
    });

    await db.usePlugin(schedulerPlugin, "openclaw-cron-scheduler");
    await schedulerPlugin.start();
  }

  logger.info(
    {
      schedulerEnabled,
      workerEnabled,
      resource: resourceName,
      roles,
    },
    "cron queue: started",
  );

  return {
    roles,
    schedulerEnabled,
    workerEnabled,
    stop: async () => {
      if (schedulerPlugin) {
        await schedulerPlugin.stop();
      }
      if (workerEnabled) {
        await queuePlugin.stopProcessing();
      }
      if (stateMachine) {
        await stateMachine.stop();
      }
    },
  };
}
