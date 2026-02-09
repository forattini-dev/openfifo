---
summary: "Gateway dashboard (Control UI) access and auth"
read_when:
  - Changing dashboard authentication or exposure modes
title: "Dashboard"
---

# Dashboard (Control UI)

The Gateway dashboard is the browser Control UI served at `/` by default
(override with `gateway.controlUi.basePath`).

Quick open (local Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (or [http://localhost:18789/](http://localhost:18789/))

Key references:

- [Control UI](/web/control-ui) for usage and UI capabilities.
- [Tailscale](/gateway/tailscale) for Serve/Funnel automation.
- [Web surfaces](/web) for bind modes and security notes.

Authentication is enforced at the WebSocket handshake via `connect.params.auth.password`
or **proxy auth headers** when `gateway.auth.mode="proxy"`. The Control UI does **not**
accept token/basic/oauth2 auth. See `gateway.auth` in [Gateway configuration](/gateway/configuration).

Security note: the Control UI is an **admin surface** (chat, config, exec approvals).
Do not expose it publicly. The UI stores the gateway URL in `localStorage` after first load;
passwords are kept in memory only. Prefer localhost, Tailscale Serve, or an SSH tunnel.

## Fast path (recommended)

- After onboarding, the CLI auto-opens the dashboard and prints a clean (non-tokenized) link.
- Re-open anytime: `openclaw dashboard` (copies link, opens browser if possible, shows SSH hint if headless).
- If the UI prompts for auth, enter the password from `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`), or use proxy auth.

## Auth basics (local vs remote)

- **Localhost**: open `http://127.0.0.1:18789/`.
- **Password source**: `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`).
- **Not localhost**: use Tailscale Serve (identity headers when `gateway.auth.allowTailscale: true`),
  tailnet bind with a password, a reverse proxy with `gateway.auth.mode="proxy"`, or an SSH tunnel.
  See [Web surfaces](/web).

## If you see “unauthorized” / 1008

- Ensure the gateway is reachable (local: `openclaw status`; remote: SSH tunnel `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/`).
- Ensure a password is configured (`gateway.auth.password` or `OPENCLAW_GATEWAY_PASSWORD`).
- Enter the password when prompted, then connect.
