# LocalAFK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](package.json)
[![CI](https://github.com/thuanlyt/LocalAFK/actions/workflows/ci.yml/badge.svg)](https://github.com/thuanlyt/LocalAFK/actions/workflows/ci.yml)

**English** | [Tiếng Việt](./readme-vi.md)

LocalAFK is a self-hosted web dashboard for a Discord bot. Use it to browse the bot's guilds, read and send text-channel messages, and keep the bot connected to a voice channel while the server process is running.

It uses the official Discord Bot API. It does not automate a personal Discord account or implement a self-bot.

## Contents

- [What is LocalAFK?](#what-is-localafk)
- [Key features](#key-features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [Voice behavior and persistence](#voice-behavior-and-persistence)
- [Running locally](#running-locally)
- [Docker](#docker)
- [Security notes](#security-notes)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Current limitations](#current-limitations)
- [Contributing](#contributing)
- [License](#license)
- [Support the Project](#support-the-project)

## What is LocalAFK?

LocalAFK is a small Node.js service that keeps a Discord bot and its dashboard together in one process. The dashboard is independent of the browser session: closing the tab does not disconnect the bot from Discord.

The voice manager sends a steady silent Opus stream, handles reconnects with bounded backoff, and stores the requested guild/channel so it can restore the target after a process restart.

## Key features

- Discord OAuth2 login restricted to configured owner Discord IDs.
- Optional password login for private or fallback use.
- Guild and channel browsing through a web dashboard.
- Recent-message history and real-time text-channel updates.
- Text-message sending through the bot, with Discord's 2,000-character limit enforced.
- Voice join, leave, live member updates, and reconnect handling.
- Atomic persistence of the desired voice target in `DATA_DIR/state.json`.
- Session-bound OAuth `state` validation and session regeneration after login.
- `GET /healthz` for process liveness checks.
- Native Node.js and Docker workflows.

## How it works

```text
Browser
  │ REST + Socket.IO
  ▼
Express dashboard ── StateStore (DATA_DIR/state.json)
  │
  ▼
Discord.js client ── Discord Gateway / REST / Voice
```

The Discord client starts once with the required guild, message, message-content, and voice-state intents. Express serves the static dashboard and authenticated API. Socket.IO broadcasts new messages, voice status, voice members, and operational log lines to authenticated dashboard clients.

The application has no database or external session service. Sessions use `memorystore` with periodic expiry cleanup and are intentionally in-memory.

## Requirements

- Node.js `>=22.12.0`. Node.js 24 LTS is recommended.
- npm compatible with the Node.js release.
- A Discord application with a bot token.
- A server where the bot has access to the guilds/channels you want to manage.
- Docker is optional.

When creating the bot, enable **Message Content Intent** in the Discord Developer Portal. Grant the bot at least the channel permissions required for your use case: View Channels, Read Message History, Send Messages, Connect, and Speak.

## Quick start

```bash
git clone https://github.com/thuanlyt/LocalAFK.git
cd LocalAFK
npm ci
cp .env.example .env
npm start
```

On Windows PowerShell, the copy step can be written as:

```powershell
Copy-Item .env.example .env
```

Fill in `.env` before starting the service. Open <http://127.0.0.1:3000> after startup.

At least one login method must be configured: Discord OAuth2 or `DASHBOARD_PASSWORD`.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `BOT_TOKEN` | Yes | Discord bot token. Treat it as a password. |
| `SESSION_SECRET` | Yes | Long random value used to sign session cookies. |
| `DISCORD_CLIENT_ID` | OAuth | Discord application client ID. |
| `DISCORD_CLIENT_SECRET` | OAuth | Discord application client secret. |
| `DISCORD_REDIRECT_URI` | OAuth | Exact callback URL registered in the Discord Developer Portal. |
| `OWNER_DISCORD_IDS` | OAuth | Comma-separated Discord user IDs allowed to use OAuth login. |
| `DASHBOARD_PASSWORD` | Password | Enables the password login form when non-empty. |
| `COOKIE_SECURE` | No | Set to `true` when the dashboard is served through HTTPS. Defaults to `false`. |
| `PORT` | No | Web port. Defaults to `3000`. |
| `HOST` | No | Bind address. Defaults to `127.0.0.1`. Docker Compose sets it to `0.0.0.0` inside the container. |
| `DATA_DIR` | No | Directory for `state.json`. Defaults to `./data`. |

The OAuth method is enabled only when all OAuth values and at least one owner ID are present. The service exits at startup if `BOT_TOKEN`, `SESSION_SECRET`, or both login methods are missing.

Generate a session secret with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

For OAuth, register a callback such as `http://127.0.0.1:3000/auth/callback` or the HTTPS URL used by your reverse proxy. The value must match `DISCORD_REDIRECT_URI` exactly.

## Authentication

### Discord OAuth2

The login route creates a cryptographically random, session-bound `state` value and saves the session before redirecting to Discord. The callback rejects missing or mismatched state before exchanging the authorization code, then regenerates and saves the authenticated session before redirecting to the dashboard.

The callback also checks the returned Discord user ID against `OWNER_DISCORD_IDS`.

### Password fallback

When `DASHBOARD_PASSWORD` is set, the dashboard exposes a password login form. A successful password login regenerates and saves the session before returning success.

The password endpoint has no application-level rate limiter. If it is reachable from the Internet, prefer OAuth owner allowlisting and add rate limiting at the reverse-proxy layer.

## Voice behavior and persistence

- Selecting a voice channel stores it as the desired target and connects the bot.
- The bot streams silence at a regular Opus frame cadence to keep the voice connection active.
- Unexpected disconnects use bounded exponential reconnect backoff, starting at 5 seconds and capped at 60 seconds.
- A channel switch or explicit rejoin disposes the previous connection without allowing stale events to affect the replacement.
- **Leave** clears the desired target and persisted state, then stops the connection.
- Process shutdown stops the live connection but preserves the desired target for the next startup.
- On restore, a deleted channel, missing guild, or non-voice target is logged and not retried indefinitely.

This keeps the bot independent of the browser, but it does not guarantee Discord, network, host, or process availability.

## Running locally

Start the service normally:

```bash
npm start
```

Run with Node's watch mode during development:

```bash
npm run dev
```

The default native bind address is `127.0.0.1`. For an internet-facing setup, terminate HTTPS at a reverse proxy, forward HTTP and WebSocket traffic to the local Node process, and set `COOKIE_SECURE=true`.

The unauthenticated liveness endpoint is:

```text
GET /healthz
```

It returns HTTP 200 with `{ "ok": true }` when the web process is alive. It intentionally does not fail merely because Discord or voice is reconnecting.

## Docker

```bash
docker compose up -d --build
```

The image uses Node 24 and installs from the lockfile with `npm ci --omit=dev`. Compose mounts `./data` at `/app/data`, sets `HOST=0.0.0.0` inside the container, and publishes the dashboard only on the host loopback address `127.0.0.1:3000`.

Use a reverse proxy for public HTTPS access. Update `DISCORD_REDIRECT_URI` to the public callback URL and set `COOKIE_SECURE=true` when TLS is enabled. Do not bake `.env` or secrets into the image.

## Security notes

- Never commit `.env`, bot tokens, client secrets, session secrets, or dashboard passwords.
- Reset the bot token immediately if it is exposed.
- Use a strong random `SESSION_SECRET` and a strong password if password login is enabled.
- Use OAuth2 with `OWNER_DISCORD_IDS` as the preferred public login method.
- Put a public deployment behind HTTPS and a reverse proxy; keep native Node deployments bound to loopback.
- Keep the host-published Docker port on loopback unless direct exposure is intentional and understood.
- LocalAFK uses a Discord bot account. Do not use it to automate a personal Discord account.

## Testing

Run the built-in Node.js test suite:

```bash
npm test
```

The tests cover the voice lifecycle and StateStore persistence, including channel replacement, reconnect behavior, shutdown/leave semantics, overlapping snapshots, failed-write recovery, malformed JSON, and temporary-file cleanup.

The repository's GitHub Actions workflow runs `npm ci` and `npm test` on Node 24 for pushes and pull requests targeting `master`.

Additional local checks:

```bash
npm audit --omit=dev
node -e "console.log(require('node:crypto').getCiphers().includes('aes-256-gcm'))"
```

## Project structure

```text
src/
  config.js                 Environment configuration and startup checks
  index.js                  Process startup and graceful shutdown
  discord/                  Discord client, chat, voice, and silence stream
  store/stateStore.js       Atomic JSON state persistence
  web/                      Express auth/API/server and Socket.IO wiring
public/                     Static dashboard
test/                       Built-in node:test suites
audit/                      Historical review and remediation records
Dockerfile                  Node 24 production image
docker-compose.yml          Local container workflow
```

## Troubleshooting

### The bot refuses to start with an intents error

Enable **Message Content Intent** in the Discord Developer Portal and verify the bot was invited with the required permissions.

### OAuth redirects fail

Check that `DISCORD_REDIRECT_URI` exactly matches a registered Discord OAuth2 redirect, including scheme, hostname, port, path, and trailing slash.

### The dashboard logs out after a restart

This is expected. Sessions are stored in memory and are not persisted across process restarts. Log in again; the voice target is stored separately under `DATA_DIR`.

### The bot cannot reconnect to the saved voice channel

Check that the bot is still in the guild, the channel still exists and is voice-based, and the bot still has Connect and Speak permissions. An invalid saved target is logged and must be replaced by joining a valid channel from the dashboard.

### The port is already in use

Change `PORT` or stop the process that owns the configured port. `HOST` controls the bind address separately.

## Current limitations

- `memorystore` is intentionally in-memory. Sessions disappear when the process restarts and do not support multi-process deployments.
- Password login has no built-in brute-force limiter. Use OAuth owner allowlisting and reverse-proxy rate limiting when appropriate.
- Auth, API, and frontend behavior have less automated coverage than the voice and persistence subsystems.
- A saved voice target is retained when it becomes invalid; LocalAFK does not automatically delete it because the owner may want to repair the guild/channel and retry.
- Continuous voice presence still depends on the Discord gateway, network, host, process manager, and permissions.

## Contributing

Issues and pull requests are welcome.

Before opening a pull request:

- keep the CommonJS and small-dependency approach unless there is a clear reason to change it;
- run `npm ci` and `npm test`;
- update tests when changing voice lifecycle or persistence behavior;
- describe the change and verification performed;
- do not include secrets, local state, or deployment credentials.

## License

LocalAFK is released under the [MIT License](LICENSE).

## 💖 Support the Project

LocalAFK is **free and open source**. If it saves you time, please give us a ⭐ **Star** — it keeps the project alive and helps us keep improving it.

<a href="https://github.com/thuanlyt/LocalAFK/stargazers">
  <img src="https://img.shields.io/github/stars/thuanlyt/LocalAFK?style=social" alt="GitHub Stars">
</a>

### 🤝 Community & Support

- 📖 [Read the Docs](https://github.com/thuanlyt/LocalAFK#readme)
- 🐛 [Report an Issue](https://github.com/thuanlyt/LocalAFK/issues)
- 🌐 [ThuanLYT Website](https://thuanlyt.id.vn)

<p align="center"><em>Built with ❤️ by ThuanLYT</em></p>
