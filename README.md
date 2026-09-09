# LocalAFK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E22.12-brightgreen.svg)](package.json)
[![CI](https://github.com/thuanlyt/LocalAFK/actions/workflows/ci.yml/badge.svg)](https://github.com/thuanlyt/LocalAFK/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/thuanlyt/LocalAFK)](https://github.com/thuanlyt/LocalAFK/releases/latest)

**English** | [Tiếng Việt](./readme-vi.md)

LocalAFK is a lightweight, headless Discord bot controlled entirely through slash commands. It keeps up to five official Discord bot accounts (one Controller plus up to four Workers) connected to voice channels, restores each saved voice target after restart, and exposes operational diagnostics and VPS/host statistics directly in Discord — all from a single Node.js process.

There is no dashboard, HTTP server, browser control plane, web login, Docker requirement, database, or reverse-proxy requirement.

**Current stable release:** [v1.2.0](https://github.com/thuanlyt/LocalAFK/releases/tag/v1.2.0)

## Contents

- [What is LocalAFK](#what-is-localafk)
- [Why headless](#why-headless)
- [Features](#features)
- [Architecture](#architecture)
- [Five-bot architecture](#five-bot-architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Slash commands](#slash-commands)
- [Voice persistence](#voice-persistence)
- [Running on Linux](#running-on-linux)
- [Running on Windows](#running-on-windows)
- [Process supervision](#process-supervision)
- [Security](#security)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Releases](#releases)
- [Contributing](#contributing)
- [License](#license)
- [Support the Project](#support-the-project)

## What is LocalAFK

LocalAFK runs one Node.js process containing:

- a BotManager owning up to five Discord Clients (1 Controller + 4 Workers), each with its own VoiceManager and its own persisted voice target;
- a CommandManager, attached only to the Controller, for slash-command registration, authorization, dispatch, and diagnostics;
- a StatsProvider for read-only VPS/host statistics;
- a small atomic JSON StateStore per bot slot for its desired voice target and (for Workers) its enabled/stopped state.

Discord is the user interface and control plane. Only stopping the Node process stops every bot's runtime connection.

## Why headless

A Discord-native control plane keeps the runtime small and removes an entire class of web concerns:

- no inbound TCP port;
- no frontend or browser session;
- no OAuth web callback or password UI;
- no HTTP, Socket.IO, TLS, reverse proxy, or Docker layer;
- fewer dependencies and fewer privileged Discord intents;
- diagnostics and control remain available in the same Discord environment as the bot.

For long-running use, run the Node process under the operating system's process supervisor. LocalAFK does not ship a supervisor configuration.

## Features

- One root slash command: /afk, registered only by the Controller (Bot 1).
- Up to five official Discord bot accounts (1 Controller + 4 Workers) managed from one process.
- Owner allowlisting through comma-separated OWNER_DISCORD_IDS, plus an execution-time guild gate when COMMAND_GUILD_ID is set.
- Ephemeral control, status, sync, diagnostics, and error responses.
- Guild-scoped command registration for fast iteration, or global registration for multi-guild use.
- Startup command synchronization that skips the Discord API write when the schema is already in sync.
- Per-bot voice join, leave, reconnect, status, and member listing, selected with an optional `bot:` option (defaults to Bot 1).
- Worker lifecycle control from Discord: `/afk bot list|start|stop|restart` — no SSH required.
- Silent Opus frames to keep each bot's voice connection active.
- Generation-guarded voice lifecycle with bounded reconnect backoff, independent per bot.
- Atomic, recoverable persistence of each bot's desiredVoice, and of each Worker's enabled/stopped state.
- `/afk status`: LocalAFK's own process CPU/RAM/heap/uptime plus the live state of all five bot slots.
- Read-only host/VPS statistics (`/afk stats`): CPU, RAM, swap, disk, listening ports (with owning PID/process), and top processes — no SSH required.
- Native Node.js environment-file loading; no runtime configuration dependency beyond Node.js and npm.

## Architecture

~~~text
                     systemd (or another process supervisor)
                                    │
                            localafk.service
                                    │
                        1 Node.js process, 1 CommandManager
                                    │
                               BotManager
      ┌───────────┬───────────┬───────────┬───────────┬───────────┐
      ▼           ▼           ▼           ▼           ▼
   Bot 1        Bot 2       Bot 3       Bot 4       Bot 5
Controller      Worker      Worker      Worker      Worker
Client +        Client +    Client +    Client +    Client +
VoiceManager    VoiceManager VoiceManager VoiceManager VoiceManager
      │           │           │           │           │
state.json  state.bot2.json ... state.bot5.json (independent, atomic)
~~~

Every bot requests only the `Guilds` and `GuildVoiceStates` intents. None of them subscribe to message content or message events. All five Clients live in the same Node/V8 runtime — the deliberate lowest-memory design; see [Five-bot architecture](#five-bot-architecture).

## Five-bot architecture

LocalAFK manages up to five official Discord bot accounts from a single Node.js process, a single systemd service, and a single BotManager — not five processes, not Worker Threads, not Docker containers.

- **Bot 1 (Controller, `BOT_TOKEN`)** is required. It owns slash-command registration, `/afk status`, `/afk stats`, and authorization for every command (including control of the four Workers). If the Controller fails to log in, startup is fatal and the process exits non-zero — the OS supervisor is responsible for restarting it.
- **Bots 2-5 (Workers, `TOKEN_2`..`TOKEN_5`)** are optional. Each is its own official bot account, its own Discord Client, and its own VoiceManager with its own saved voice target — never shared with any other slot. Workers do **not** register slash commands and have no interaction handler of their own; they are only reachable through the Controller's `/afk` commands.
- Leaving a worker slot's token empty leaves it `UNCONFIGURED` — the Controller starts and runs normally with zero, some, or all four Workers configured.
- A Worker's login failure is isolated to that slot (`FAILED`, with a sanitized error) and never affects the Controller or any other Worker.
- **Stopping a Worker releases its runtime**: `client.destroy()` and `VoiceManager.shutdown()` are called, the Client and VoiceManager references are dropped, and only a tiny state record (its persisted `desiredVoice` and `enabled: false`) remains. A stopped Worker holds no Gateway connection, no voice connection, and no listeners. **Stopping a Worker is not the same as leaving its voice channel** — the saved target is preserved so `/afk bot start` reconnects it where it left off.
- Each Worker's `enabled` flag is persisted (`DATA_DIR/state.bot<N>.json`) and survives a process restart or host reboot: a Worker you stopped stays stopped; the Controller always starts.
- At startup, configured-and-enabled Workers are started with a small bounded stagger (not a burst, no permanent supervisory timer/polling loop) after the Controller is ready and its voice target is restored.
- **Duplicate tokens are rejected at startup**: if two slots share the same token, LocalAFK fails safely with a message like `Duplicate bot token configured for slots 1 and 3` — the token value itself is never logged.

### Discord bot invites

- **Controller**: invite with the `bot` and `applications.commands` scopes (it needs `applications.commands` to register `/afk`), plus Connect/Speak in any voice channel it should manage.
- **Workers**: invite with the `bot` scope and Connect/Speak permissions only. **Workers do not need the `applications.commands` scope or any LocalAFK command registration** — they are never the target of a Discord slash-command registration call.

### Per-bot resource reporting — a deliberate limitation

All five Clients run inside **one** Node/V8 process. Linux cannot attribute an exact share of process-wide CPU or RSS to one Client among several sharing the same event loop and heap, and LocalAFK does not fabricate one: `/afk status` reports real, accurate **process-wide** CPU/RSS/heap once, and real **per-bot operational** state (online/stopped/failed, uptime, ping, voice state) for each of the five slots — it never divides the process total by five or invents a per-bot number. This is the deliberate tradeoff for the lowest practical memory footprint; obtaining trustworthy per-bot CPU/RAM would require separate OS processes (or Worker Threads with their own overhead) for each bot, which contradicts the "as light as possible" goal this architecture is built around.

## Requirements

- Node.js >=22.12.0; Node.js 24 LTS is recommended.
- npm compatible with the installed Node.js version.
- A Discord application and bot token for the Controller (Bot 1), and one more application/token per Worker you plan to configure (Bots 2-5).
- The Controller invited with the bot and applications.commands scopes; each Worker invited with the bot scope only.
- Access to the guild and voice channels you want to manage.
- Connect and Speak permissions in the target voice channel(s).

LocalAFK does not require Docker, a database, an HTTP port, a web server, or a reverse proxy.

## Quick start

~~~bash
git clone https://github.com/thuanlyt/LocalAFK.git
cd LocalAFK
npm ci
cp .env.example .env
npm start
~~~

Edit .env before starting. On Windows PowerShell, copy the example with:

~~~powershell
Copy-Item .env.example .env
~~~

To pin the checkout to the current stable release instead of the current master branch:

~~~bash
git checkout v1.2.0
~~~

Invite the Controller bot with the bot and applications.commands scopes, then run /afk ping in a guild where your Discord user ID is listed in OWNER_DISCORD_IDS. Configure TOKEN_2..TOKEN_5 (each its own bot invited with the bot scope only) later, any time — see [Five-bot architecture](#five-bot-architecture).

For development:

~~~bash
npm run dev
~~~

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| BOT_TOKEN | Yes | Discord bot token for Bot 1, the Controller. Treat it as a password. |
| TOKEN_2 | No | Discord bot token for Bot 2, a Worker. Leave empty to leave the slot unconfigured. |
| TOKEN_3 | No | Discord bot token for Bot 3, a Worker. |
| TOKEN_4 | No | Discord bot token for Bot 4, a Worker. |
| TOKEN_5 | No | Discord bot token for Bot 5, a Worker. |
| OWNER_DISCORD_IDS | Yes | Comma-separated Discord user IDs authorized to run /afk. |
| COMMAND_GUILD_ID | No | Register commands in this one guild. Empty means global registration. When set, `/afk` also rejects any interaction from a different guild at execution time, independent of registration scope. |
| DATA_DIR | No | Directory for state files. Defaults to ./data. Bot 1 uses state.json; each configured Worker slot N uses its own state.bot\<N\>.json. |
| STATS_SHOW_HOSTNAME | No | Set to `true` to include the OS hostname in `/afk stats`. Defaults to omitted, since a self-chosen hostname can be identifying/private. |

The application requires both BOT_TOKEN and at least one owner ID. TOKEN_2..TOKEN_5 are independently optional — any subset (including none) may be configured. Two slots sharing the same token value is a startup error (see [Five-bot architecture](#five-bot-architecture)). COMMAND_GUILD_ID is useful during development because guild commands update quickly; global command propagation can take longer.

Generate or copy secrets only through a private local .env file. .env is ignored by Git and must never be committed.

## Slash commands

All /afk commands are owner-only. Authorization is checked at runtime against interaction.user.id, and an unauthorized interaction receives an ephemeral response without side effects.

| Command | Behavior |
| --- | --- |
| /afk voice join channel:<voice channel> bot:<1-5, optional> | Validate the guild/channel, persist the target, and connect or switch voice for the selected bot (defaults to Bot 1). |
| /afk voice leave bot:<1-5, optional> | Clear the saved target, cancel reconnects, and stop voice for the selected bot. |
| /afk voice reconnect bot:<1-5, optional> | Preserve the saved target, dispose the live connection, and reconnect intentionally for the selected bot. |
| /afk voice status bot:<1-5, optional> | Show connected/reconnecting state, target, duration, and reconnect state for the selected bot. |
| /afk voice members bot:<1-5, optional> | List current voice members for the selected bot's channel, with bot markers and clean truncation. |
| /afk bot list | Compact overview of all five slots: online/offline, voice state, or saved target for stopped slots. |
| /afk bot start bot:<2-5> | Start a Worker: create a fresh Client + VoiceManager, log in, and restore its saved voice target. |
| /afk bot stop bot:<2-5> | Stop a Worker: shut down its VoiceManager, destroy its Client, release the runtime — its saved voice target is preserved, not cleared. |
| /afk bot restart bot:<2-5> | Stop and immediately start a Worker again (fresh runtime), preserving its saved voice target. Bot 1 cannot be started/stopped/restarted this way — it follows the process's own lifecycle. |
| /afk commands status | Show guild/global scope, local count, remote count, and schema sync state. |
| /afk commands sync | Force command schema synchronization and report the scope and count. |
| /afk ping | Show the Controller's gateway ping and process uptime. |
| /afk status | Show LocalAFK's own process CPU/RAM/heap/uptime, plus live state for all five bot slots. |
| /afk diagnostics | Show a safe Controller-level operational snapshot without tokens, secrets, owner IDs, or private paths. |
| /afk stats | Show read-only host/VPS system statistics: CPU, RAM, swap, disk, listening ports (with owning PID/process), and top processes. No bot-specific data — see /afk status for that. |

Control and diagnostic responses are ephemeral. Voice command handlers call each target bot's public VoiceManager API; they do not duplicate voice lifecycle logic, and CommandManager never shares one VoiceManager across two bots.

### /afk status

`/afk status` is LocalAFK's own process and multi-bot status — **not** VPS-wide monitoring (that's `/afk stats`). It reports, in one ephemeral response:

- the LocalAFK Node process's own PID, CPU% (sampled over a short ~150-250ms window and normalized against total VPS CPU capacity — e.g. "2.4%" means 2.4% of the whole VPS, not of one core), RSS (and RSS as a percentage of total VPS RAM), heap used, and uptime;
- how many of the five slots are configured and how many bots are currently online, and how many are voice-connected;
- each of the five slots' real state (`UNCONFIGURED` / `STOPPED` / `STARTING` / `ONLINE` / `FAILED`), and for online bots: tag, uptime, gateway ping, guild count, and voice state/target;
- one explicit line stating that per-bot CPU/RAM cannot be attributed exactly in a shared single-process runtime — see [Per-bot resource reporting](#per-bot-resource-reporting--a-deliberate-limitation). No slot is ever silently dropped to save space; if the full response would exceed Discord's size limit, each bot's entry is compacted to one line before anything is truncated.

### /afk stats

`/afk stats` lets the owner observe **VPS/host** health directly from Discord, without SSH — strictly host-level, with no bot-specific section (that's `/afk status`). It is:

- **read-only** — it never execs a shell, never accepts arbitrary commands, and cannot kill/restart/reboot anything or edit any file;
- **owner-only and ephemeral**, like every other `/afk` command, and additionally guild-scoped when `COMMAND_GUILD_ID` is configured;
- **rate-limited** — at most one run every 5 seconds per owner, to avoid needlessly repeated `ps`/`ss` calls;
- **redacted by design** — no remote peer IP is ever shown, no process argv/environment/cwd is shown (only pid, CPU%, MEM%, and executable name for the process table; protocol/bind/port/state/PID/process for the port table), and the OS hostname is omitted unless `STATS_SHOW_HOSTNAME=true` is explicitly set.

It does not open an HTTP port, start a monitoring server, or add a web dashboard — Discord remains the only control plane. On Linux it reads `/proc`, `os` built-ins, and the fixed, argument-locked `ps`/`ss` executables via `execFile` (never a shell string); on other platforms (including Windows) the ports/processes sections report "Unavailable on this platform" instead of guessing or crashing, while CPU/RAM/disk stats remain available everywhere `fs.statfs`/`os` support them.

**Listening-port process attribution.** An unprivileged `ss -p` can only see the process name/PID for sockets owned by the same user running LocalAFK, so processes like `sshd` or `nginx` (running as `root` or another user) may show as `unknown`. LocalAFK itself is never run as root to fix this. Instead, if a narrowly-scoped root helper is deployed, `/afk stats` uses it automatically:

- a fixed, root-owned script at `/usr/local/libexec/localafk-portstats` that accepts **zero** arguments and runs exactly `ss -H -lntup` — nothing else;
- a `sudoers.d` entry granting the LocalAFK service account passwordless access to run **only that exact helper path**, nothing broader (no shell, no `ps`, no `systemctl`, no general sudo);
- invoked as `execFile('/path/to/sudo', ['-n', '/usr/local/libexec/localafk-portstats'])` — no shell string, no interpolation, no argument ever comes from Discord or a user.

If the helper isn't installed or configured, `/afk stats` automatically and silently falls back to a plain, unprivileged `ss` call — port attribution may then show `unknown` for some entries, but the command never crashes or blocks on it.

### Command registration

At startup, LocalAFK builds the local /afk schema, fetches remote commands for the configured scope, normalizes relevant fields, and compares them. If they match, registration is a no-op. If they differ, LocalAFK replaces the command set with the local schema.

- COMMAND_GUILD_ID set: commands are registered in that guild.
- COMMAND_GUILD_ID empty: commands are registered globally.
- /afk commands sync: force a synchronization.
- /afk commands status: inspect the current comparison without mutating Discord.

The bot does not hot-reload source code. After changing the application, restart the Node process; use /afk commands sync only for command registration.

## Voice persistence

Every configured bot (Controller and each Worker) has its own independent VoiceManager and its own persisted target — never shared across slots.

- /afk voice join validates a voice-based channel in the interaction guild before persisting it, for the selected bot.
- Each VoiceManager sends a steady silent Opus stream.
- Unexpected disconnects reconnect with bounded backoff from 5 seconds up to 60 seconds, independently per bot.
- Generation guards prevent stale connection events and timers from affecting a replacement connection.
- /afk voice reconnect preserves desiredVoice while intentionally replacing the live connection.
- /afk voice leave clears desiredVoice and never reconnects.
- /afk bot stop stops a Worker's runtime but preserves its desiredVoice — stopping is not leaving.
- Process shutdown (or /afk bot stop) stops the runtime connection but preserves desiredVoice for the next startup.
- An invalid saved guild/channel is logged and not retried forever.

State is stored atomically per bot: Bot 1 in DATA_DIR/state.json, each configured Worker N in DATA_DIR/state.bot\<N\>.json. Every StateStore snapshots overlapping writes, reports a failing write to its caller, keeps later writes usable, and cleans up failed temporary files.

## Running on Linux

From the repository directory:

~~~bash
npm ci
cp .env.example .env
# edit .env with a secure editor
npm start
~~~

For a long-running service, use a generic process supervisor such as systemd or another service manager. Keep the .env file private and make DATA_DIR writable by the service account. LocalAFK does not ship a systemd unit or deployment script.

## Running on Windows

In PowerShell:

~~~powershell
npm ci
Copy-Item .env.example .env
# edit .env
npm start
~~~

For unattended use, run the process through Task Scheduler or a trusted Windows service wrapper. LocalAFK does not require a listening port and does not need a desktop session after the process starts.

## Process supervision

LocalAFK handles SIGTERM and SIGINT by calling BotManager.shutdown(): every active Worker's VoiceManager is shut down and its Client destroyed, then the Controller's VoiceManager is shut down and its Client destroyed. Every bot's desiredVoice and every Worker's enabled state are preserved — a restart brings the Controller straight back up and restores exactly the Workers that were enabled before. An operating-system supervisor is responsible for restarting the process after a crash or host restart; this is one supervised process regardless of how many of the five bot slots are configured.

Process supervision is optional for local development and recommended for unattended use. Do not add source hot-reload to a running production process; restart the process after code changes.

## Security

- Never commit .env or expose BOT_TOKEN.
- Reset the bot token immediately if it is exposed.
- Keep OWNER_DISCORD_IDS limited to trusted Discord user IDs.
- Runtime authorization is the final authority; roles and Discord permission metadata do not replace the owner-ID check.
- All control and diagnostics responses are ephemeral.
- The bot requests only Guilds and GuildVoiceStates; it does not request Message Content Intent.
- Grant only the Discord permissions needed for the target guild and voice channel.
- LocalAFK controls a bot account. It must not be used to automate a personal Discord account.

## Testing

Run the built-in Node.js suite:

~~~bash
npm test
~~~

The tests cover:

- command authorization, owner dispatch, safe errors, and ephemeral replies;
- voice join, leave, reconnect, status, invalid-channel handling, and command errors;
- guild/global command registration;
- stable command-schema comparison and startup no-op behavior;
- VoiceManager generation lifecycle and reconnect regression cases;
- StateStore atomic persistence, overlapping snapshots, queue recovery, malformed JSON, and temporary-file cleanup;
- /afk stats authorization (owner/guild/cooldown), redaction (no remote IPs, no argv/env), the privileged-helper/plain-ss fallback, safe degradation when `ss`/`ps` are missing or the platform isn't Linux, and response-size truncation;
- config: required BOT_TOKEN/OWNER_DISCORD_IDS, optional TOKEN_2..TOKEN_5, and duplicate-token detection without leaking token values;
- BotManager: Controller vs. Worker lifecycle, start/stop/restart, enabled-state persistence across a simulated restart, worker-login-failure isolation, runtime release on stop, and isolated per-slot state files;
- CommandManager multi-bot dispatch: /afk bot list/start/stop/restart, the voice bot: selector (including its default-to-Bot-1 behavior and rejection of unconfigured/stopped/failed targets), and /afk status (process totals, all five slots, and that per-bot CPU/RAM is never fabricated);
- normalized per-process CPU sampling (against total core count, not per-core, and never a cumulative-time mislabel).

Additional checks:

~~~bash
npm ci
npm audit --omit=dev
npm ls --depth=0
~~~

GitHub Actions runs npm ci and npm test on Node 24 for pushes and pull requests targeting master.

## Project structure

~~~text
src/
  config.js                   Environment contract: tokens (1 Controller + 4 Workers), owner IDs, guild scope
  index.js                    Startup order, command sync, restore, and shutdown
  discord/
    client.js                 Discord client factory and minimal intents (shared by all 5 slots)
    botManager.js             Owns all 5 bot slots: lifecycle, isolation, per-slot state
    commandManager.js         Slash commands, authorization, dispatch, /afk status, /afk stats
    silenceStream.js          Silent Opus frame stream
    voiceManager.js           Persistent voice lifecycle (one instance per configured bot)
  store/stateStore.js         Atomic JSON persistence (one file per bot slot)
  system/
    statsProvider.js          Read-only host/VPS statistics (CPU, RAM, disk, ports, processes)
    processStats.js           Normalized LocalAFK-process CPU sampling for /afk status
test/
  botManager.test.js
  commandManager.test.js
  config.test.js
  processStats.test.js
  stateStore.test.js
  statsProvider.test.js
  voiceManager.test.js
audit/                         Historical review and completion reports
~~~

## Troubleshooting

### Commands do not appear

Check that the bot was invited with the applications.commands scope and that BOT_TOKEN is valid. Set COMMAND_GUILD_ID to the test guild for fast registration, restart the process, or run /afk commands sync.

Global commands can take longer to propagate than guild commands.

### I am rejected as unauthorized

Copy your Discord user ID and add it to OWNER_DISCORD_IDS as a comma-separated value. Restart the process after changing .env.

### The bot cannot join voice

Verify that the selected channel is a voice or stage channel and that the bot has Connect and Speak permissions. The command must be used inside the target guild.

### The saved voice target is invalid after restart

Check that the guild and channel still exist, the bot is still a member of the guild, and permissions remain available. Join a valid channel again to replace the saved target.

### The process exits during startup

Check the console output for missing BOT_TOKEN, missing OWNER_DISCORD_IDS, a duplicate token across two slots (`Duplicate bot token configured for slots X and Y`), invalid command guild access, Discord login errors, or command registration errors. Only the Controller's own login failure is fatal; a Worker's login failure is isolated to that slot instead (see [Five-bot architecture](#five-bot-architecture)).

### A Worker shows FAILED or STOPPED in /afk bot list

FAILED means its login attempt errored (bad token, or the token belongs to an application without a bot user) — check `/afk bot list` for the sanitized reason, then fix `.env` and run `/afk bot restart bot:<N>`. STOPPED means the owner (or you) previously ran `/afk bot stop` — its saved voice target is preserved; run `/afk bot start bot:<N>` to bring it back.

### Voice reconnects repeatedly

Check Discord gateway connectivity, host/network stability, and voice permissions. /afk voice status, /afk bot list, and /afk diagnostics expose the current state without requiring shell access.

## Limitations

- Sessions and web authentication do not exist; control is limited to Discord slash commands.
- One Node process owns all five bot slots and their voice connections. There is no Worker Threads, multi-process, or container isolation between bots — see [Per-bot resource reporting](#per-bot-resource-reporting--a-deliberate-limitation) for why, and the tradeoff it buys.
- Per-bot CPU/RAM cannot be attributed exactly; `/afk status` reports accurate process-wide totals and accurate per-bot operational state (online/voice/ping/etc.), never a fabricated per-bot CPU/RAM split.
- desiredVoice is retained when its guild/channel becomes invalid; it is not silently deleted.
- Global command propagation depends on Discord and can be slower than guild registration.
- Continuous voice presence still depends on Discord, network, host, process supervision, and permissions — independently per bot.
- Listening-port process attribution in `/afk stats` may show `unknown` for sockets owned by other users unless the optional, narrowly-scoped root helper (see [/afk stats](#afk-stats)) is deployed.
- Auth/API/frontend tests from the former dashboard are gone with that runtime; command, voice, multi-bot lifecycle, and persistence behavior are covered by built-in tests.

## Releases

The latest stable version is [v1.2.0](https://github.com/thuanlyt/LocalAFK/releases/tag/v1.2.0).

Release tags are treated as immutable snapshots. The `master` branch may contain documentation or development changes made after the latest release.

## Contributing

Issues and pull requests are welcome.

Before opening a pull request:

- keep the runtime small and the direct dependency set minimal;
- run npm ci, npm test, and npm audit --omit=dev;
- add tests for command authorization, command synchronization, voice lifecycle, or persistence changes;
- do not add web, Docker, database, or hot-reload infrastructure without a separately agreed feature;
- never include tokens, .env, local state, or deployment credentials.

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
