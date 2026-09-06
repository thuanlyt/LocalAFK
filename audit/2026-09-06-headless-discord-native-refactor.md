# LocalAFK — Headless Discord-native refactor audit

**Date:** 2026-09-06  
**Repository:** thuanlyt/LocalAFK  
**Scope:** local repository and GitHub Actions only; no VPS, SSH, remote shell, or deployment operation  
**Starting HEAD:** 37ee3e82217245fd799dd6df1217a5a1114b9817  
**Implementation commits:** 115fd79, 9c02f31  
**Documentation/audit completion commit:** efeb662
**Documentation CI run:** 34015208243 (completed/success)

## 1. Result

The repository was refactored from a Discord bot plus web dashboard into a headless, Discord-native Node.js process controlled through owner-authorized slash commands.

The final documentation commit is pushed and its GitHub Actions run is green. The repository verdict for this refactor is LOCALAFK HEADLESS LOCAL/REPOSITORY READY.

No VPS, SSH session, remote probe, deployment, or real-secret inspection was performed.

## 2. Baseline and resulting shape

Baseline at the start of this refactor:

- HEAD: 37ee3e82217245fd799dd6df1217a5a1114b9817
- Branch: master
- Remote: https://github.com/thuanlyt/LocalAFK.git
- Working tree and origin/master were clean and aligned before implementation.
- Runtime included Express, sessions, Socket.IO, browser assets, web authentication, message-based Discord control, and Docker files.

Resulting application:

- One Node.js process.
- Direct runtime dependencies: @discordjs/voice and discord.js.
- Node native env-file startup: node --env-file-if-exists=.env.
- Discord Gateway intents: only Guilds and GuildVoiceStates.
- No message intents, message partials, HTTP listener, Socket.IO server, browser control plane, or web login.
- State persistence remains the tested atomic JSON StateStore.
- Voice lifecycle remains in VoiceManager, with a public reconnect operation and generation-guarded reconnect behavior.

## 3. Removed runtime and files

Removed from the repository:

- .dockerignore
- Dockerfile
- docker-compose.yml
- public/index.html
- public/css/style.css
- public/js/app.js
- src/discord/chat.js
- src/web/api.js
- src/web/auth.js
- src/web/server.js
- src/web/sockets.js

Removed direct dependencies:

- dotenv
- express
- express-session
- memorystore
- socket.io

The final direct dependency inventory is exactly:

~~~text
@discordjs/voice@0.19.2
discord.js@14.27.0
~~~

## 4. Environment contract

Required:

- BOT_TOKEN
- OWNER_DISCORD_IDS, comma-separated Discord user IDs

Optional:

- COMMAND_GUILD_ID, for guild-scoped registration; empty means global registration
- DATA_DIR, defaulting to ./data

Removed web/runtime variables include the former OAuth, session, password, port, host, and dashboard configuration. No web environment contract remains.

## 5. Command tree

The local schema contains one root command:

~~~text
/afk
├── voice
│   ├── join channel:<GuildVoice|GuildStageVoice>
│   ├── leave
│   ├── reconnect
│   ├── status
│   └── members
├── commands
│   ├── status
│   └── sync
├── ping
├── status
└── diagnostics
~~~

Command behavior:

- All commands are checked at runtime against interaction.user.id and the configured owner IDs.
- Unauthorized interactions receive an ephemeral response and no side effect.
- Authorized interactions default to ephemeral replies.
- Voice join validates the typed channel before persistence or connection.
- Safe errors are returned without leaking tokens, owner IDs, private paths, or raw internal details.
- Diagnostics report operational state without secret material.

## 6. Registration and synchronization

At startup, CommandManager builds the local schema, fetches the remote command set in the configured scope, normalizes relevant fields, and compares the result.

- Matching schemas produce a no-op.
- Different schemas are replaced with the local schema.
- COMMAND_GUILD_ID selects guild scope.
- Empty COMMAND_GUILD_ID selects global scope.
- /afk commands sync forces synchronization.
- /afk commands status reports comparison state without mutating Discord.
- Source hot reload is intentionally not implemented.

Generated Discord IDs, versions, application IDs, and guild IDs are ignored during schema comparison so remote metadata does not cause unnecessary writes.

## 7. Voice and persistence

The refactor preserves the tested VoiceManager and StateStore design while exposing the required control surface:

- public VoiceManager.reconnect() preserves the desired target;
- intentional replacement cancels stale reconnect work;
- reconnect timers are bounded;
- generation guards prevent stale connection events from affecting a replacement;
- leave clears desired voice and prevents reconnect;
- shutdown stops the active runtime while retaining desired voice for a future restart;
- StateStore writes atomically and recovers its write queue after failures.

## 8. Tests and local gates

Local verification completed:

- npm ci: pass
- npm test: 24/24 pass
- npm audit --omit=dev: 0 vulnerabilities
- npm ls --depth=0: exactly two direct runtime dependencies
- native env-file CLI check: pass
- source/config scan: no web runtime, old web env names, HTTP listener, or dotenv residue
- git diff --check: pass

Test coverage includes 12 command-manager cases, 7 VoiceManager cases, and 5 StateStore cases. The command tests cover unauthorized access, owner dispatch, join/leave/reconnect/status/diagnostics, safe errors, schema IDs, no-op/change sync, guild/global scope, and invalid channels.

## 9. GitHub Actions

Implementation CI:

- Workflow: .github/workflows/ci.yml
- Run: 34014799541
- Commit: 9c02f31
- Result: completed/success
- npm ci: pass
- npm test: pass

The workflow continues to use Node 24 and does not build or run Docker. A GitHub Actions annotation notes that the current setup-node action internally targets a newer runtime; it did not fail the job and is outside the requested refactor scope.

Final documentation/audit CI: run 34015208243 for commit efeb662, completed/success.

## 10. Documentation

Rewritten:

- README.md is the canonical English guide.
- readme-vi.md is the Vietnamese guide.

Both document:

- headless Discord-native architecture;
- Linux and Windows local execution;
- generic process supervision;
- minimal env contract;
- complete slash-command reference;
- registration behavior and voice persistence;
- security, testing, troubleshooting, and limitations.

Both end with the required project support section and LocalAFK URLs. No private deployment details, credentials, VPS instructions, or old dashboard setup remain.

## 11. Acceptance gate

| Gate | Result |
| --- | --- |
| Correct repository and baseline verified | PASS |
| No VPS/SSH/remote deployment used | PASS |
| Headless source runtime | PASS |
| Minimal env contract | PASS |
| Minimal Discord intents | PASS |
| Owner authorization on every command | PASS |
| Startup sync with no-op comparison | PASS |
| Voice reconnect API and tests | PASS |
| Web runtime removed | PASS |
| Docker files removed | PASS |
| Direct dependencies reduced to two | PASS |
| npm ci | PASS |
| npm test | PASS |
| npm audit --omit=dev | PASS |
| GitHub Actions implementation run | PASS |
| Final docs/audit CI | PASS — run 34015208243 |

## 12. Remaining limitations

- No live Discord startup/voice smoke test was run; CI is intentionally credential-free.
- Global Discord command propagation is controlled by Discord and can take longer than guild registration.
- Continuous voice presence still depends on Discord, network, host availability, process supervision, and permissions.
- One process owns the bot and voice lifecycle; multi-process coordination is not implemented.
- No source hot reload is provided.
- The audit does not claim a VPS deployment or production-host verification.

## 13. Completion record

This report records the final docs/audit push with:

- ending implementation/documentation HEAD: efeb662ca15269c0c63817a3a8bd81bfe70eabc5;
- final documentation/audit GitHub Actions run: 34015208243, completed/success;
- final local/remote alignment at verification time;
- final verdict: LOCALAFK HEADLESS LOCAL/REPOSITORY READY.

The subsequent audit-record commit only records this already-verified completion state; it does not change application behavior.
