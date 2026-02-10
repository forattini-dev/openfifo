---
summary: "What OpenFIFO changes relative to OpenClaw: persistence, defaults, and container-first ops."
read_when:
  - You want to know what OpenFIFO adds or changes
  - You are migrating from OpenClaw
title: "OpenFIFO vs OpenClaw"
---

## What OpenFIFO is

OpenFIFO is our OpenClaw variant tuned for container-first deployments, s3db-only persistence, and more cost-aware defaults. It keeps the same core architecture and capabilities, but changes several defaults and ops assumptions to fit how we run it in production.

## Differences at a glance

| Area                 | OpenClaw              | OpenFIFO                                            |
| -------------------- | --------------------- | --------------------------------------------------- |
| Persistence          | Multiple options      | **s3db only**                                       |
| Default model        | Opus-leaning examples | **Haiku** (`claude-haiku-4-5`)                      |
| Context default      | Varies                | **200k tokens**                                     |
| Concurrency defaults | Varies                | **3 agents / 6 sub-agents**                         |
| Web fetch            | Standard fetch        | **recker** (impersonated fetch)                     |
| Cron runtime         | In-process            | **Optional s3db queue + scheduler + state machine** |
| Control UI auth      | Token or password     | **Password or proxy** (no token/basic/oauth2 UI)    |
| Skill install safety | Install directly      | **Static scan + confirm**                           |

## Persistence (s3db only)

OpenFIFO requires s3db. You must provide a connection string via one of the supported environment variables:

- `OPENCLAW_S3DB_URL`
- `S3DB_URL`
- `S3DB_CONNECTION`

If the connection string is missing, OpenFIFO will refuse to start outside of tests.

## Cost-focused defaults

OpenFIFO defaults to a smaller, cheaper model and a sane concurrency cap:

- Default provider/model: `anthropic/claude-haiku-4-5` (alias: `claude-haiku-4-5`)
- Default context: 200,000 tokens
- Default concurrency: 3 top-level agents, 6 sub-agents

You can still override these in config, but the baseline is optimized for cost and stability.

## Web fetch and crawl

`web_fetch` uses the `recker` client by default, which relies on an impersonated HTTP stack for improved crawl reliability. You can override it with:

- `tools.web.fetch.client: "fetch"`

## Security-focused changes

- Control UI authentication uses password or proxy modes only. Token/basic/oauth2 auth is not supported in the browser UI (those are for non-browser clients).
- Skill installs are scanned for suspicious code patterns. If something looks risky, OpenFIFO asks for explicit confirmation before continuing.

## Container-first ops

OpenFIFO’s docs include a container-first proxy layout (Claude + OpenAI/Codex) and recommended environment wiring. See `docs/deploy/proxies.md`.

## Fork history (OpenFIFO changes)

### 2026-02-08 — `cf8cd63c6` — openfifo: s3db-only defaults, auth tweaks, docs

- Enforced **s3db-only** persistence and added the `s3db` persistence layer used by sessions, auth profiles, pairing, cron, and related stores.
- Added `OPENCLAW_S3DB_URL` (plus `S3DB_URL` / `S3DB_CONNECTION`) requirement for runtime persistence.
- Switched **cost defaults**: default model to Haiku, default context to **200k**, and concurrency to **3 agents / 6 sub-agents**.
- Defaulted `web_fetch` to **recker** (impersonated HTTP client) with config override to `fetch`.
- Control UI auth changes: password default, tokenized URLs removed, proxy auth supported, and UI now **refuses token auth**.
- Added **skill safety scanning** on install with a confirmation prompt when suspicious patterns are detected.
- Container-first docs: added `docs/deploy/proxies.md` and updated install/onboarding/security docs to match the new defaults.
- UI usability: chat layout improvements for better responsiveness and full-width input.

### 2026-02-09 — `70a53b33f` — gateway: add basic and oauth2 auth modes

- Added `basic` and `oauth2` gateway auth modes (JWT validation via JWKS + OIDC discovery).
- HTTP endpoints (`/v1/chat/completions`, `/v1/responses`, `/tools/invoke`) now accept **Basic** and **OAuth2 Bearer** auth.
- CLI now supports `--auth basic|oauth2` and `--basic-user/--basic-password` for remote RPC.
- Config schema extended with `gateway.auth.basic.*`, `gateway.auth.oauth2.*`, and `gateway.remote.basic.*`.
- Documentation updated across gateway/web/CLI pages to describe the new auth modes and config/env vars.

### 2026-02-09 — `de34526f3` — docs: list fork changes in openfifo overview

- Added the initial OpenFIFO fork history section to `docs/concepts/openfifo.md`.

### 2026-02-09 — `25ae61cd1` — docs: expand proxy deployment guide

- Expanded `docs/deploy/proxies.md` with container-first proxy wiring, `openclaw.json` volume mounts, and minimal-access Docker Compose patterns.

### 2026-02-09 — `46c28a334` — cron: add s3db queue mode

- Added **queue-backed cron mode** using s3db SchedulerPlugin + S3QueuePlugin + StateMachinePlugin.
- Cron jobs can now be split into **gateway / scheduler / worker** roles via config or env (`OPENCLAW_CRON_ROLES`).
- Queue mode persists tasks in s3db and survives container restarts; workers call `cron.run` against the gateway.
- New deploy docs: `docs/deploy/cron-queue.md`.

### 2026-02-09 — `05c1b4567` — cron: tighten queue resource typing

- Follow-up typing cleanup for the cron queue runtime (no behavior change).
