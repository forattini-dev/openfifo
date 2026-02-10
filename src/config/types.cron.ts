export type CronQueueRole = "gateway" | "scheduler" | "worker";

export type CronQueueGatewayConfig = {
  url?: string;
  token?: string;
  password?: string;
  basic?: {
    user?: string;
    password?: string;
  };
  tlsFingerprint?: string;
  timeoutMs?: number;
};

export type CronQueueSchedulerConfig = {
  enabled?: boolean;
  /** Cron expression for the s3db SchedulerPlugin (5-field). */
  schedule?: string;
  timezone?: string;
  /** Max number of cron jobs to enqueue per scheduler tick. */
  batchLimit?: number;
  /** Treat enqueue markers as stale after this many milliseconds. */
  staleEnqueueMs?: number;
};

export type CronQueueWorkerConfig = {
  enabled?: boolean;
  concurrency?: number;
};

export type CronQueueStateMachineConfig = {
  enabled?: boolean;
  /** Field on the queue resource that should mirror state machine transitions. */
  stateField?: string;
  transitionLogResource?: string;
  stateResource?: string;
};

export type CronQueueConfig = {
  roles?: CronQueueRole[];
  resource?: string;
  deadLetterResource?: string;
  maxAttempts?: number;
  visibilityTimeoutMs?: number;
  pollIntervalMs?: number;
  concurrency?: number;
  orderingMode?: "fifo" | "lifo";
  enableCoordinator?: boolean;
  scheduler?: CronQueueSchedulerConfig;
  worker?: CronQueueWorkerConfig;
  gateway?: CronQueueGatewayConfig;
  stateMachine?: CronQueueStateMachineConfig;
};

export type CronConfig = {
  enabled?: boolean;
  store?: string;
  maxConcurrentRuns?: number;
  mode?: "local" | "queue";
  queue?: CronQueueConfig;
};
