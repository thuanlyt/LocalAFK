# LocalAFK — Remediation report (local implementation round)

**Date:** 2026-09-06
**Starting commit:** `9dbc41806a4e39263e00d35ab2dcf7678d5a477b` (includes `audit/2026-09-06-full-audit.md` and `audit/2026-09-06-claude-review-brief.md`)
**Ending commit:** `29a2976ba9763c79eb51e7b8690619368c20c42f` (pushed to `origin/master`)
**Scope:** local source + repository only. No VPS was touched, inspected, or prepared during this round — see "Intentionally deferred" below.

## Commits in this round

1. `060b625` — Fix VoiceManager reconnect race with generation-based lifecycle guard
2. `a7886e8` — Fix Node engine contract, harden auth/session, add HOST/DATA_DIR and graceful shutdown
3. `29a2976` — Update README for the hardened baseline and add minimal CI

## Files changed

- `src/discord/voiceManager.js` — core lifecycle fix
- `test/voiceManager.test.js` — new, 6 regression tests
- `package.json` / `package-lock.json` — engine bump, dependency swap
- `Dockerfile`, `docker-compose.yml`, `.dockerignore` — Node 24 base image, loopback publish
- `src/config.js` — `HOST`, `DATA_DIR`
- `src/index.js` — HOST bind, graceful shutdown
- `src/web/server.js` — session store, `/healthz`
- `src/web/auth.js` — OAuth `state`, session regeneration
- `src/web/api.js` — consistent error handling on `/voice/leave`
- `src/store/stateStore.js` — atomic writes, write queue, error handling
- `.env.example` — documents `HOST`/`DATA_DIR`
- `.github/workflows/ci.yml` — new
- `README.md` — updated throughout

## Fixes (what changed and why)

- **VoiceManager reconnect race (the core bug):** `_connect()` used to destroy the previous connection without distinguishing "intentional replacement" from "unexpected loss," so the old connection's own `Destroyed` handler could schedule a reconnect timer that later fired and destroyed a perfectly healthy replacement — repeating indefinitely after any channel switch. Fixed with a generation counter: every `_connect()` call bumps it and every listener it registers checks it before acting, so a superseded connection's events become no-ops regardless of timing. Added `shutdown()` (distinct from `leave()` — preserves persisted `desiredVoice`) and re-validation of the target guild/channel before reconnect/restore attempts (stops retrying instead of looping forever against a deleted channel).
- **Node engine contract:** bumped to `>=22.12.0` (verified against the locked `@discordjs/voice@0.19.2`'s own `engines` field), Docker base image to `node:24-alpine`, `npm ci --omit=dev` for the container build.
- **`libsodium-wrappers` removed:** confirmed unused — no `require` anywhere in `src/`, and not a peer/transitive dependency of anything in the resolved dependency tree. `@discordjs/voice@0.19.2` encrypts voice traffic via `node:crypto` directly; confirmed `aes-256-gcm` is available on the target Node runtime before removing it (see Runtime/dependencies below).
- **OAuth `state` + session regeneration:** `/auth/login` now generates a random `state`, stored in session; `/auth/callback` rejects a missing/mismatched value before exchanging the code. Both OAuth and password login now call `req.session.regenerate()` before attaching the authenticated user (session-fixation hardening).
- **Session store:** swapped the default `express-session` MemoryStore (never evicts) for `memorystore` (in-memory, scheduled pruning). Sessions still don't survive a process restart — accepted, documented tradeoff for a single-owner dashboard, not treated as a subsystem to solve with a persistent store.
- **HOST / DATA_DIR:** app now binds `config.host` (default `127.0.0.1`); `docker-compose.yml` overrides it to `0.0.0.0` only inside the container while keeping the host-published port on `127.0.0.1:3000`. `state.json` location is now configurable via `DATA_DIR`.
- **StateStore:** writes are now atomic (temp file in the same directory, then rename) and serialized through a write queue; load errors distinguish a missing file (`ENOENT`, normal on first run) from a corrupt/unreadable one (now logged instead of silently swallowed).
- **Graceful shutdown:** `SIGTERM`/`SIGINT` now trigger an idempotent shutdown (stop HTTP/Socket.IO, `voiceManager.shutdown()`, destroy the Discord client, exit).
- **`GET /healthz`:** minimal unauthenticated liveness endpoint, independent of session/Discord state, for future reverse-proxy/service-manager checks.
- **`/api/voice/leave`:** wrapped in try/catch for consistency with the other routes.
- **A bug I introduced and caught before committing:** `memorystore`'s `checkPeriod` was first wired to the 30-day session `maxAge` constant, which overflows Node's 32-bit `setInterval` limit (~24.8 days) and gets silently clamped to a ~1ms sweep — found via a local smoke test (`TimeoutOverflowWarning` in the log), fixed with a separate, sane 24h prune interval.

## Voice lifecycle — mechanism

- **Intentional replacement (explicit join/switch):** `_connect()` cancels any pending reconnect timer, then bumps the generation *before* destroying the old connection. The old connection's `Destroyed` handler fires with its captured (now stale) generation, sees the mismatch, and returns immediately — no reconnect scheduled, no mutation of state for the new connection. This holds regardless of whether `@discordjs/voice` emits the event synchronously or later.
- **Unexpected disconnect:** `Disconnected` re-checks generation both before and after its `entersState` race (state may have changed during the await), so a stale in-flight disconnect handler can't act on a connection that's since been replaced or left. If the real, current connection is lost, exactly one reconnect timer is scheduled, with the existing exponential backoff (5s → 60s cap in production; test-injectable in `test/voiceManager.test.js`).
- **Ready:** only updates `connectedAt`/resets backoff if the event's generation is still current.
- **Leave:** clears `desired` and cancels the timer *before* disposing the connection, so the resulting `Destroyed` event never schedules a reconnect (this ordering was already correct before this round; kept and now covered by a test).
- **Shutdown:** sets `shuttingDown`, cancels timers, disposes the connection/player — but never touches `desired` or the persisted `state.json`, so a restart still restores the previous voice target via `restoreFromState()`.
- **Stale target after restart:** if the saved guild/channel is no longer valid (deleted, bot removed), `_connect()` logs it and returns without scheduling anything further — no infinite retry against a target that can never succeed. `desiredVoice` is deliberately left in the state file rather than auto-cleared; documented in README "Giới hạn hiện tại" as a decision, not an oversight.

## Tests

All via `npm test` (`node --test`), dependency-injected fake voice connections (no real Discord/network calls):

| Test | Result |
|---|---|
| channel switch disposes the old connection without leaving a stale reconnect timer | PASS |
| an unexpected connection loss schedules exactly one reconnect | PASS |
| an explicit join cancels a pending reconnect timer instead of stacking another one | PASS |
| leave clears desired state, cancels timers, and never reconnects | PASS |
| shutdown tears down the runtime but preserves persisted desiredVoice | PASS |
| stale events from a superseded connection do not mutate the active connection state | PASS |

**Local smoke status (real bot, real `.env` credentials already present on this machine):**
- Startup, `HOST=127.0.0.1` bind, Discord login, `GET /healthz`, `GET /auth/config`, and unauthenticated `GET /api/me` → 401: all verified against the real running process.
- SIGTERM: sent via `kill` from Git Bash on Windows; the process exited and released the port, but the graceful-shutdown log line did not appear before it did — consistent with Node's well-documented limited POSIX signal support on Windows (there is no real SIGTERM delivery to a Node process there), not necessarily a code defect. **Not independently confirmed on Linux** — the target production OS. Recommend re-verifying with a real `kill -TERM`/`systemctl stop` on Ubuntu before relying on it operationally.
- **Real voice join / channel switch was deliberately not exercised** — doing so would join a real voice channel in the owner's real Discord server, a visible side effect on shared state, which the task instructions did not ask for and which I chose not to trigger without it being explicitly requested. The 6 automated tests above target the exact bug mechanism directly and are stronger evidence than a single manual run would be, but a real live smoke test (join → switch channel → observe no flapping) remains a manual gate before anyone treats this as fully field-verified.

## Runtime / dependencies

- Local Node: `v24.13.0`, npm `11.6.2`.
- `engines.node` now `>=22.12.0` (matches `@discordjs/voice@0.19.2`'s own requirement, confirmed directly in `package-lock.json`).
- Fresh `npm ci` from the updated lockfile: clean, no engine-mismatch warning.
- `node -e "require('node:crypto').getCiphers().includes('aes-256-gcm')"` → `true` on this runtime.
- `libsodium-wrappers`: removed (see Fixes above). `package-lock.json` regenerated via `npm install` (not edited by hand), then re-verified with a clean `npm ci`.
- `npm audit`: found 1 moderate advisory (`qs`, transitive via `express`→`body-parser`) after the dependency change; fixed with plain `npm audit fix` (bumped `qs` 6.15.3 → 6.16.0, within express's existing semver range — no `--force`, no top-level dependency change). Final `npm audit`: **0 vulnerabilities**.

## Security / reliability

- OAuth `state`: implemented, session-bound, consumed on use, checked before token exchange.
- Session regeneration: applied on both OAuth callback success and password login success.
- Session store: `memorystore` (in-memory, pruned), not persistent across restarts — documented, not treated as a bug.
- `HOST`: added, defaults to `127.0.0.1`; Docker Compose overrides to `0.0.0.0` only inside the container while publishing the host port on loopback only.
- `DATA_DIR`: added, defaults to `./data`.
- StateStore: atomic (temp file + rename, same filesystem) and write-queue-serialized; ENOENT vs. malformed-JSON vs. other read errors are now distinguished and logged.
- Graceful shutdown: implemented; logic reviewed and syntax-checked; end-to-end signal delivery confirmed to start the process down correctly, but the clean-shutdown log path itself could not be confirmed on this Windows dev machine (see Tests above).
- `/healthz`: implemented, unauthenticated, leaks nothing (no token/env/owner ID/session/filesystem path in the response).

## Remaining local issues

- Graceful-shutdown behavior should be re-verified with a real signal on Linux (this dev machine is Windows, where Node's SIGTERM handling is unreliable by platform design, not by this code).
- A real voice join/channel-switch smoke test against a live Discord guild was deliberately deferred (see Tests above) — recommended as a manual gate whenever someone next runs this against a real server, independent of any VPS decision.
- Automated test coverage is intentionally scoped to the voice lifecycle (the one confirmed severe bug); `auth.js`, `api.js`, and the frontend have no automated tests yet.
- `express.json()` request size limits are Express's defaults; no explicit body-size policy has been set (low priority for a single-owner dashboard, not evaluated further this round).

## Intentionally deferred (future deployment concerns — not acted on, not scheduled)

Reverse proxy (Nginx/Caddy) configuration, TLS/certificate setup, a systemd unit, firewall/UFW rules, DNS, and anything involving the VPS mentioned in this project's context are **out of scope for this round by explicit instruction** and were not touched, inspected, or prepared. These remain open only if and when the owner decides to open that scope in a future turn — this report does not treat deployment as a required next step.
