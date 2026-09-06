# LocalAFK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E22.12-brightgreen.svg)](package.json)
[![CI](https://github.com/thuanlyt/LocalAFK/actions/workflows/ci.yml/badge.svg)](https://github.com/thuanlyt/LocalAFK/actions/workflows/ci.yml)

**English** | [Tiếng Việt](./readme-vi.md)

LocalAFK is a lightweight, headless Discord bot controlled entirely through slash commands. It keeps an authorized bot connected to a voice channel, restores the saved voice target after restart, and exposes operational diagnostics directly in Discord.

There is no dashboard, HTTP server, browser control plane, web login, Docker requirement, database, or reverse-proxy requirement.

## Contents

- [What is LocalAFK](#what-is-localafk)
- [Why headless](#why-headless)
- [Features](#features)
- [Architecture](#architecture)
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
- [Contributing](#contributing)
- [License](#license)
- [Support the Project](#support-the-project)

## What is LocalAFK

LocalAFK runs one Node.js process containing:

- a Discord.js client for the Gateway and application commands;
- a CommandManager for slash-command registration, authorization, dispatch, and diagnostics;
- a VoiceManager for persistent voice presence and reconnect lifecycle;
- a small atomic JSON StateStore for the desired voice target.

Discord is the user interface and control plane. Only stopping the Node process stops the runtime connection.

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

- One root slash command: /afk.
- Owner allowlisting through comma-separated OWNER_DISCORD_IDS.
- Ephemeral control, status, sync, diagnostics, and error responses.
- Guild-scoped command registration for fast iteration, or global registration for multi-guild use.
- Startup command synchronization that skips the Discord API write when the schema is already in sync.
- Voice join, leave, reconnect, status, and member listing.
- Silent Opus frames to keep the voice connection active.
- Generation-guarded voice lifecycle with bounded reconnect backoff.
- Atomic, recoverable persistence of desiredVoice.
- Safe diagnostics for Node version, uptime, memory, gateway ping, guild count, voice state, and command sync state.
- Native Node.js environment-file loading; no runtime configuration dependency beyond Node.js and npm.

## Architecture

~~~text
Discord Gateway + Slash Commands
              │
              ▼
       LocalAFK Node.js process
              │
      ┌───────┼────────┐
      ▼       ▼        ▼
CommandManager VoiceManager StateStore
                         │
                         ▼
                 DATA_DIR/state.json
~~~

The bot requests only Guilds and GuildVoiceStates intents. It does not subscribe to message content or message events.

## Requirements

- Node.js >=22.12.0; Node.js 24 LTS is recommended.
- npm compatible with the installed Node.js version.
- A Discord application and bot token.
- The bot invited with the bot and applications.commands scopes.
- Access to the guild and voice channels you want to manage.
- Connect and Speak permissions in the target voice channel.

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

Invite the bot with the bot and applications.commands scopes, then run /afk ping in a guild where your Discord user ID is listed in OWNER_DISCORD_IDS.

For development:

~~~bash
npm run dev
~~~

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| BOT_TOKEN | Yes | Discord bot token. Treat it as a password. |
| OWNER_DISCORD_IDS | Yes | Comma-separated Discord user IDs authorized to run /afk. |
| COMMAND_GUILD_ID | No | Register commands in this one guild. Empty means global registration. |
| DATA_DIR | No | Directory for state.json. Defaults to ./data. |

The application requires both BOT_TOKEN and at least one owner ID. COMMAND_GUILD_ID is useful during development because guild commands update quickly; global command propagation can take longer.

Generate or copy secrets only through a private local .env file. .env is ignored by Git and must never be committed.

## Slash commands

All /afk commands are owner-only. Authorization is checked at runtime against interaction.user.id, and an unauthorized interaction receives an ephemeral response without side effects.

| Command | Behavior |
| --- | --- |
| /afk voice join channel:<voice channel> | Validate the guild/channel, persist the target, and connect or switch voice. |
| /afk voice leave | Clear the saved target, cancel reconnects, and stop voice. |
| /afk voice reconnect | Preserve the saved target, dispose the live connection, and reconnect intentionally. |
| /afk voice status | Show connected/reconnecting state, target, duration, and reconnect state. |
| /afk voice members | List current voice members with bot markers and clean truncation. |
| /afk commands status | Show guild/global scope, local count, remote count, and schema sync state. |
| /afk commands sync | Force command schema synchronization and report the scope and count. |
| /afk ping | Show gateway ping and process uptime. |
| /afk status | Show compact bot, gateway, voice, target, and command-scope status. |
| /afk diagnostics | Show a safe operational snapshot without tokens, secrets, owner IDs, or private paths. |

Control and diagnostic responses are ephemeral. Voice command handlers call the public VoiceManager API; they do not duplicate voice lifecycle logic.

### Command registration

At startup, LocalAFK builds the local /afk schema, fetches remote commands for the configured scope, normalizes relevant fields, and compares them. If they match, registration is a no-op. If they differ, LocalAFK replaces the command set with the local schema.

- COMMAND_GUILD_ID set: commands are registered in that guild.
- COMMAND_GUILD_ID empty: commands are registered globally.
- /afk commands sync: force a synchronization.
- /afk commands status: inspect the current comparison without mutating Discord.

The bot does not hot-reload source code. After changing the application, restart the Node process; use /afk commands sync only for command registration.

## Voice persistence

- /afk voice join validates a voice-based channel in the interaction guild before persisting it.
- VoiceManager sends a steady silent Opus stream.
- Unexpected disconnects reconnect with bounded backoff from 5 seconds up to 60 seconds.
- Generation guards prevent stale connection events and timers from affecting a replacement connection.
- /afk voice reconnect preserves desiredVoice while intentionally replacing the live connection.
- /afk voice leave clears desiredVoice and never reconnects.
- Process shutdown stops the runtime connection but preserves desiredVoice for the next startup.
- An invalid saved guild/channel is logged and not retried forever.

State is stored atomically in DATA_DIR/state.json. StateStore snapshots overlapping writes, reports a failing write to its caller, keeps later writes usable, and cleans up failed temporary files.

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

LocalAFK handles SIGTERM and SIGINT by stopping VoiceManager, destroying the Discord client, and exiting. An operating-system supervisor is responsible for restarting the process after a crash or host restart.

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
- StateStore atomic persistence, overlapping snapshots, queue recovery, malformed JSON, and temporary-file cleanup.

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
  config.js                   Minimal environment contract
  index.js                    Startup, command sync, restore, and shutdown
  discord/
    client.js                 Discord client and minimal intents
    commandManager.js         Slash commands, authorization, sync, diagnostics
    silenceStream.js          Silent Opus frame stream
    voiceManager.js           Persistent voice lifecycle
  store/stateStore.js         Atomic JSON persistence
test/
  commandManager.test.js
  stateStore.test.js
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

Check the console output for missing BOT_TOKEN, missing OWNER_DISCORD_IDS, invalid command guild access, Discord login errors, or command registration errors.

### Voice reconnects repeatedly

Check Discord gateway connectivity, host/network stability, and voice permissions. /afk voice status and /afk diagnostics expose the current state without requiring shell access.

## Limitations

- Sessions and web authentication do not exist; control is limited to Discord slash commands.
- One process owns the bot and its voice connection. Multi-process coordination is not implemented.
- desiredVoice is retained when its guild/channel becomes invalid; it is not silently deleted.
- Global command propagation depends on Discord and can be slower than guild registration.
- Continuous voice presence still depends on Discord, network, host, process supervision, and permissions.
- Auth/API/frontend tests from the former dashboard are gone with that runtime; command, voice, and persistence behavior are covered by built-in tests.

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
