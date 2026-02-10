import type { OpenClawConfig } from "../../config/config.js";
import type { CronQueueRole } from "../../config/types.cron.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { startCronQueueRuntime } from "./runtime.js";

export async function runCronQueueProcess(params: { cfg: OpenClawConfig; roles: CronQueueRole[] }) {
  const logger = createSubsystemLogger("cron-queue");
  const runtime = await startCronQueueRuntime({ cfg: params.cfg, roles: params.roles });
  if (!runtime) {
    logger.warn({ roles: params.roles }, "cron queue: nothing to run (check roles/config)");
    return;
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "cron queue: shutting down");
    await runtime.stop().catch((err) => {
      logger.warn({ err: String(err) }, "cron queue: stop failed");
    });
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await new Promise<void>(() => {});
}
