---
summary: "Run OpenClaw behind OpenAI-compatible proxies (Claude Max + Codex) with container-friendly persistence"
read_when:
  - You want to route OpenClaw through internal OpenAI-compatible proxies
  - You are deploying in containers or Kubernetes
  - You want Claude via a proxy without direct API keys
  - You need s3db-based persistence
title: "OpenAI-Compatible Proxies"
---

# OpenAI-Compatible Proxies

This guide shows how to run OpenClaw behind **OpenAI-compatible** proxies for:

- **Claude Max Proxy** (OpenAI-compatible API backed by Claude CLI)
- **Codex Proxy** (OpenAI-compatible API backed by Codex)

It mirrors the proven k3s setup used in production and keeps the gateway fully container-friendly.

## Architecture

```
OpenClaw -> OpenAI-compatible API -> Claude Max Proxy -> Claude CLI
OpenClaw -> OpenAI-compatible API -> Codex Proxy     -> Codex
```

The gateway speaks OpenAI-compatible HTTP; each proxy exposes `/v1` and translates to the target provider.

## Required environment variables

Set these via your container env or secret store:

- `OPENAI_BASE_URL` — default OpenAI-compatible base URL (typically Claude Max Proxy)
- `OPENAI_API_KEY` — any non-empty value if the proxy doesn’t enforce keys
- `OPENCLAW_S3DB_URL` — **required** connection string for persistence

`OPENCLAW_S3DB_URL` can also be provided as `S3DB_URL` or `S3DB_CONNECTION`.

## Configuration example (openclaw.json)

> Replace hostnames and model IDs with whatever your proxies expose.

```json5
{
  env: {
    OPENAI_API_KEY: "not-needed",
    OPENAI_BASE_URL: "http://claude-max-proxy:3456/v1",
    OPENCLAW_S3DB_URL: "s3://<bucket>/<prefix>?region=<region>",
  },
  models: {
    providers: {
      // Claude via OpenAI-compatible proxy
      openai: {
        baseUrl: "http://claude-max-proxy:3456/v1",
        api: "openai-completions",
        auth: "api-key",
        models: [
          {
            id: "claude-haiku-4",
            name: "Claude Haiku 4 (Proxy)",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
      // Codex via OpenAI-compatible proxy
      "openai-codex": {
        baseUrl: "http://codex-proxy:8080/v1",
        api: "openai-completions",
        auth: "api-key",
        models: [
          {
            id: "<codex-model-id>",
            name: "Codex (Proxy)",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "openai/claude-haiku-4" },
    },
  },
}
```

Notes:

- Provider names are **arbitrary**. Use the same key in model references (`provider/modelId`).
- If you want Codex as the default, set `agents.defaults.model.primary` to `openai-codex/<codex-model-id>`.

## Persistence (S3DB required)

OpenClaw requires S3DB for all persistence. The connection string is **chosen by the user** and must be provided via environment:

- `OPENCLAW_S3DB_URL=s3://...` (or `S3DB_URL` / `S3DB_CONNECTION`)

For tests only, you can use:

- `OPENCLAW_S3DB_URL=memory://openclaw-test`

## Container tips

- Proxies should be reachable **inside** the container network (Kubernetes service names or Docker Compose service names).
- Keep proxy services **internal** and front the gateway with your preferred ingress.
- If you run behind other reverse proxies, set `gateway.trustedProxies` to explicit IPs (not CIDR).

## Troubleshooting

- If OpenClaw reports missing API keys, ensure `OPENAI_API_KEY` is set to any non-empty value.
- If models don’t show up, confirm the provider name and `id` match your proxy’s OpenAI-compatible model list.
