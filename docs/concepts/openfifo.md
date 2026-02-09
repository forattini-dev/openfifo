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

| Area                 | OpenClaw              | OpenFIFO                            |
| -------------------- | --------------------- | ----------------------------------- |
| Persistence          | Multiple options      | **s3db only**                       |
| Default model        | Opus-leaning examples | **Haiku** (`claude-haiku-4-5`)      |
| Context default      | Varies                | **200k tokens**                     |
| Concurrency defaults | Varies                | **3 agents / 6 sub-agents**         |
| Web fetch            | Standard fetch        | **recker** (impersonated fetch)     |
| Control UI auth      | Token or password     | **Password or proxy** (no token UI) |
| Skill install safety | Install directly      | **Static scan + confirm**           |

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

- Control UI authentication uses password or proxy modes only. Token auth is not supported in the browser UI.
- Skill installs are scanned for suspicious code patterns. If something looks risky, OpenFIFO asks for explicit confirmation before continuing.

## Container-first ops

OpenFIFO’s docs include a container-first proxy layout (Claude + OpenAI/Codex) and recommended environment wiring. See `docs/deploy/proxies.md`.
