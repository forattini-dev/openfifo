---
summary: "Queue-backed cron using s3db scheduler + queue + state machine (container-friendly)."
read_when:
  - You want cron jobs to survive container restarts
  - You need gateway/scheduler/worker split roles
  - You are deploying with s3db
---

## Overview

OpenFIFO can run cron via s3db’s **SchedulerPlugin + S3QueuePlugin + StateMachinePlugin**. This mode persists cron tasks in s3db and lets you split the runtime into **gateway**, **scheduler**, and **worker** roles.

Key benefits:

- Cron tasks are persisted in s3db (no in-container state loss).
- You can scale workers separately from the gateway.
- If the gateway restarts, queued tasks are still there and will retry.

## Requirements

- `OPENCLAW_S3DB_URL` (or `S3DB_URL` / `S3DB_CONNECTION`) must be set.
- `cron.mode: "queue"` in `openclaw.json` or `OPENCLAW_CRON_MODE=queue`.

## Role Selection

Queue mode supports three roles:

- `gateway` (serves API + runs `cron.run` when asked)
- `scheduler` (enqueues due cron jobs into s3db)
- `worker` (consumes queue and calls `cron.run` on the gateway)

If `cron.mode=queue` **and no roles are specified**, the process runs **all roles** (single container).

Override roles per container using env:

- `OPENCLAW_CRON_ROLES=gateway`
- `OPENCLAW_CRON_ROLES=scheduler`
- `OPENCLAW_CRON_ROLES=worker`

## Config Example

```jsonc
{
  "cron": {
    "mode": "queue",
    "queue": {
      "roles": ["gateway", "scheduler", "worker"],
      "resource": "cron_tasks",
      "maxAttempts": 3,
      "visibilityTimeoutMs": 30000,
      "pollIntervalMs": 1000,
      "concurrency": 1,
      "scheduler": {
        "schedule": "* * * * *",
        "batchLimit": 25,
      },
      "worker": {
        "concurrency": 1,
      },
      "stateMachine": {
        "enabled": true,
      },
      "gateway": {
        "url": "ws://gateway:18789",
        "token": "${OPENCLAW_GATEWAY_TOKEN}",
      },
    },
  },
}
```

Notes:

- `scheduler.schedule` is a 5-field cron expression (minute resolution).
- If you use multiple containers, use `OPENCLAW_CRON_ROLES` to avoid running all roles everywhere.

## Docker Compose Pattern

```yaml
services:
  openclaw-gateway:
    image: openclaw:local
    command: ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
    environment:
      OPENCLAW_CRON_MODE: queue
      OPENCLAW_CRON_ROLES: gateway
      OPENCLAW_S3DB_URL: ${OPENCLAW_S3DB_URL}
      OPENCLAW_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN}
    volumes:
      - ./openclaw.json:/home/node/.openclaw/openclaw.json:ro
    ports:
      - "18789:18789"

  openclaw-cron-scheduler:
    image: openclaw:local
    command: ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
    environment:
      OPENCLAW_CRON_MODE: queue
      OPENCLAW_CRON_ROLES: scheduler
      OPENCLAW_S3DB_URL: ${OPENCLAW_S3DB_URL}
    volumes:
      - ./openclaw.json:/home/node/.openclaw/openclaw.json:ro

  openclaw-cron-worker:
    image: openclaw:local
    command: ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
    environment:
      OPENCLAW_CRON_MODE: queue
      OPENCLAW_CRON_ROLES: worker
      OPENCLAW_S3DB_URL: ${OPENCLAW_S3DB_URL}
      OPENCLAW_CRON_GATEWAY_URL: ws://openclaw-gateway:18789
      OPENCLAW_CRON_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN}
    volumes:
      - ./openclaw.json:/home/node/.openclaw/openclaw.json:ro
```

## Environment Overrides (Worker)

Use these to avoid changing `openclaw.json` per container:

- `OPENCLAW_CRON_GATEWAY_URL`
- `OPENCLAW_CRON_GATEWAY_TOKEN`
- `OPENCLAW_CRON_GATEWAY_PASSWORD`
- `OPENCLAW_CRON_GATEWAY_BASIC_USER`
- `OPENCLAW_CRON_GATEWAY_BASIC_PASSWORD`
- `OPENCLAW_CRON_GATEWAY_TLS_FINGERPRINT`
- `OPENCLAW_CRON_GATEWAY_TIMEOUT_MS`

## Notes

- Cron queue mode disables the in-process cron timer on the gateway.
- Jobs are executed via `cron.run` on the gateway. If the gateway is down, the worker retries.
- If you update cron queue config, restart the affected containers to apply changes.
