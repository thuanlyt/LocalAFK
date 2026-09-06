# LocalAFK — Full pre-deployment audit

**Date:** 2026-09-06  
**Audited source baseline:** `c397d5d08efa2396a7b3b12fb7b98bed2ab64670` (`master`)  
**Scope:** full repository review before any source modification or VPS deployment  
**Write boundary for this audit:** only `audit/` is modified; application source remains untouched.

## 1. Executive summary

LocalAFK is a small, understandable Node.js application with a sensible core architecture for a personal Discord bot dashboard: one Discord client, one web process, Socket.IO for live updates, a tiny persisted voice target, and no database-heavy stack.

It is **not ready for production deployment in its current repository state**, despite the README saying it is deploy-ready. The main reasons are not code size or architectural complexity; they are a few concrete correctness/security gaps that are inexpensive to fix.

### Deployment verdict

**HOLD deployment until the P0/P1 items below are fixed and tested.**

Recommended target after remediation: a **single native Node.js 24 LTS process managed by systemd behind Nginx**, bound to loopback only. Docker can remain a supported secondary deployment path, but should not be the preferred path for this 2 GB VPS unless there is a strong operational reason.

## 2. Repository inventory reviewed

All tracked files at the audited baseline were reviewed:

- `.env.example`
- `.gitignore`
- `Dockerfile`
- `LICENSE`
- `README.md`
- `docker-compose.yml`
- `package.json`
- `package-lock.json`
- `public/index.html`
- `public/css/style.css`
- `public/js/app.js`
- `src/config.js`
- `src/index.js`
- `src/discord/client.js`
- `src/discord/chat.js`
- `src/discord/silenceStream.js`
- `src/discord/voiceManager.js`
- `src/store/stateStore.js`
- `src/web/api.js`
- `src/web/auth.js`
- `src/web/server.js`
- `src/web/sockets.js`

Repository history visible at audit time contains only three commits. The initial commit already used blank values in `.env.example`, and `.env` is ignored. No committed production secret was found in the visible tracked history. This is **not** a substitute for a dedicated secret-scanning tool.

No GitHub Actions workflow/run exists at the audited HEAD. No automated test suite exists.

## 3. Findings by priority

### P0 — Runtime contract is internally inconsistent

**Evidence**

- `package.json` declares Node `>=18.17.0`.
- README says Node `>=18.17`, recommends 20+.
- `Dockerfile` uses `node:20-alpine`.
- Locked `@discordjs/voice@0.19.2` declares Node `>=22.12.0`.
- As of this audit, Node 20 is EOL and Node 24 is LTS.

**Impact**

The Docker image and documented minimum runtime are unsupported by a direct dependency. Installation may warn/fail depending on npm engine policy, and even if it starts, this is not a valid production support contract.

**Required fix**

- Set project engine minimum to `>=22.12.0`.
- Recommend Node 24 LTS for production docs/CI.
- Change Docker base to Node 24 LTS.
- Use `npm ci --omit=dev` in Docker instead of `npm install --omit=dev` for reproducible installs.
- Update README badge, requirements and deployment instructions.

Official reference: https://www.npmjs.com/package/@discordjs/voice

---

### P0 — Voice reconnect race can destroy a healthy replacement connection

**Location:** `src/discord/voiceManager.js`, especially `_connect()`, the intentional `connection.destroy()` path, and the `VoiceConnectionStatus.Destroyed` handler.

**Problem**

When `_connect()` is called while a previous connection exists, it intentionally destroys the previous connection. However, that previous connection's `Destroyed` handler sees `this.desired` still set and schedules a reconnect timer. A newly-created connection may become healthy, but the stale timer can later call `_connect()` again, destroy the healthy connection, and schedule another reconnect. `Ready` resets the delay but does not clear a stale reconnect timer.

This can be triggered by switching/rejoining voice channels or overlapping connect attempts.

**Impact**

A supposedly stable 24/7 voice connection can enter an unnecessary reconnect loop. This directly contradicts the core product promise.

**Required fix**

Use an explicit lifecycle/generation strategy, for example:

- distinguish **intentional replacement/leave/shutdown** from unexpected disconnect;
- keep at most one reconnect timer;
- clear stale timers when a connection becomes Ready or a new connect generation starts;
- ensure callbacks from an old connection cannot schedule work for the current generation;
- explicitly stop/destroy old player/resource when replacing or shutting down;
- validate a restored guild/channel before reconnecting.

Add deterministic tests for:

1. first join;
2. channel A -> B switch;
3. repeated Join on the same channel;
4. transient disconnect that self-recovers;
5. hard disconnect that requires backoff reconnect;
6. Leave while a reconnect timer exists;
7. shutdown while connected;
8. stale saved channel on restart.

---

### P1 — Docker Compose publishes dashboard port to all interfaces

**Location:** `docker-compose.yml`

Current mapping:

```yaml
ports:
  - "3000:3000"
```

Docker publishes an unspecified host IP on all interfaces by default. On Ubuntu, Docker's published-port rules can also bypass the traffic path UFW normally controls.

**Impact**

If deployed with the current Compose file, port 3000 can be reachable directly from the Internet even if the intended design is Nginx-only on ports 80/443.

**Required fix if Docker remains supported**

```yaml
ports:
  - "127.0.0.1:3000:3000"
```

Then reverse proxy through Nginx. Do not rely on UFW alone to hide a Docker-published port.

Official references:

- https://docs.docker.com/engine/network/port-publishing/
- https://docs.docker.com/engine/network/packet-filtering-firewalls/#docker-and-ufw

---

### P1 — Discord OAuth2 flow has no `state` validation

**Location:** `src/web/auth.js`

The authorization request contains `client_id`, `redirect_uri`, `response_type`, `scope`, and `prompt`, but no cryptographically random `state`. The callback does not verify any state value.

**Impact**

The OAuth login flow lacks the standard CSRF binding recommended by Discord. The owner-ID allowlist reduces practical blast radius, but it does not make the flow correct.

**Required fix**

- generate a cryptographically random OAuth `state`;
- store it in the user's server-side session;
- send it in `/auth/login`;
- constant-time or normal exact comparison on callback is sufficient for a random nonce;
- reject missing/mismatched state before exchanging the authorization code;
- consume/delete state after use;
- regenerate the session after successful authentication.

Official reference: https://discord.com/developers/docs/topics/oauth2#state-and-security

---

### P1 — Password login has no brute-force control

**Location:** `src/web/auth.js` (`POST /auth/password`)

The README already acknowledges this limitation.

**Impact**

A public dashboard exposes an online password guessing endpoint.

**Recommended fix**

Best lightweight option for this personal deployment: make **Discord OAuth + owner ID allowlist the primary/only Internet-facing login**. If password fallback is kept, add a small in-process/IP-aware rate limiter and reverse-proxy rate limiting; do not add Redis solely for this application.

Also consider a minimum password length/config validation and a timing-safe comparison for defense-in-depth.

---

### P1 — Default `express-session` MemoryStore is not a production store

**Location:** `src/web/server.js`

No `store` is supplied to `express-session`, so the default MemoryStore is used. Express explicitly warns that MemoryStore is not designed for production, leaks memory under many conditions, does not scale beyond one process, and exists for development/debugging.

**Impact**

- sessions disappear on restart/deploy;
- long-running production behavior is not supported by the library's own guidance;
- session memory grows with session churn.

**Recommended fix for this tiny single-process app**

Use a lightweight persistent session store, preferably file/SQLite-backed, stored outside the release directory. Avoid Redis unless another service already needs it.

Official reference: https://expressjs.com/en/resources/middleware/session.html

---

### P1 — No graceful shutdown lifecycle

**Location:** `src/index.js`, `src/discord/voiceManager.js`

There is no SIGTERM/SIGINT handling. The HTTP server, Socket.IO, Discord client, voice connection/player/stream and reconnect timers are not deliberately closed before process exit.

**Impact**

Deploys/systemd restarts can create noisy disconnects and make reconnect behavior harder to reason about.

**Required fix**

Implement an idempotent shutdown path that:

1. marks the manager as shutting down (no new reconnect timers);
2. clears reconnect timers;
3. stops/destroys voice player/resource/connection without clearing the desired persisted channel unless the user explicitly pressed Leave;
4. closes Socket.IO/HTTP listener;
5. destroys the Discord client;
6. exits after completion or a short bounded timeout.

---

### P2 — State file writes are non-atomic and load errors are silently swallowed

**Location:** `src/store/stateStore.js`

- `_load()` catches every error and silently resets state to `{}`.
- `set()` writes JSON directly to the final path.

**Impact**

A partial write/power loss can corrupt `state.json`; the next boot silently forgets the desired voice channel. Operational errors such as permissions problems also look like an empty state.

**Recommended fix**

- distinguish ENOENT from parse/permission errors;
- log/report malformed state;
- write to a temporary file in the same directory and atomically rename;
- serialize writes if concurrent writes may occur;
- make state location configurable (`STATE_FILE` or `DATA_DIR`) and place it under `/var/lib/localafk` in production.

---

### P2 — Application only accepts a port, not an explicit bind host

**Location:** `src/index.js`, `src/config.js`

`httpServer.listen(config.port)` does not express the desired production boundary.

**Recommended fix**

Add `HOST`, defaulting conservatively to `127.0.0.1` for this dashboard, and use `httpServer.listen(config.port, config.host)`. Document `0.0.0.0` only for container/internal-network use cases where exposure is intentional.

This makes the security boundary visible in application config rather than depending solely on external firewall/proxy assumptions.

---

### P2 — No health endpoint / service readiness contract

There is no cheap unauthenticated health endpoint for systemd/reverse-proxy checks.

**Recommended fix**

Add `/healthz` that reports only process health, e.g. HTTP 200 with a tiny static payload. Do **not** make liveness fail solely because Discord voice/gateway is reconnecting, or an external Discord incident could cause a restart storm.

A separate authenticated status endpoint can expose Discord/voice status if needed.

---

### P2 — No automated tests or CI safety gate

The repo currently has no test script and no GitHub Actions workflow/run.

**Recommended lightweight approach**

Use built-in `node:test` and `node:assert` first; do not add a large testing framework unless tests outgrow them.

Minimum CI on Node 24:

1. `npm ci`;
2. syntax/static smoke checks;
3. `npm test`;
4. `npm audit --omit=dev` as an informational or policy-controlled dependency gate.

Tests should mock Discord/voice boundaries rather than connecting to real Discord in CI.

---

### P2 — Security hardening is minimal

**Location:** `src/web/server.js`

Missing or implicit controls include security headers, request size policy beyond Express defaults, explicit `X-Powered-By` disable, and a clear production proxy contract.

**Recommended fix**

Keep this lightweight:

- `app.disable('x-powered-by')`;
- add a small, well-understood security-header middleware or Helmet if the dependency tradeoff is accepted;
- set a strict Content Security Policy compatible with the local static UI + Socket.IO;
- keep cookie `httpOnly`, `sameSite=lax`, and set `secure=true` behind HTTPS;
- enforce HTTPS/HSTS at Nginx;
- keep the app bound to loopback.

Do not add a WAF or heavyweight auth stack for this owner-only application unless threat model changes.

---

### P2 — OAuth outbound fetches have no timeout

**Location:** `src/web/auth.js`

Discord token/user fetch calls have no explicit timeout/AbortSignal.

**Impact**

A degraded upstream can leave requests hanging longer than desired.

**Recommended fix**

Use `AbortSignal.timeout(...)` on Node 24 with a reasonable bounded timeout and return a generic auth failure while logging a safe diagnostic.

---

### P3 — README is materially stale relative to the intended deployment

The README still says the author is searching for an Always Free VPS and discusses failed/free-hosting paths at length. This is now historical noise if the project has moved to a real VPS deployment.

Also, README's Node requirement and Docker instructions are currently wrong for the locked voice dependency.

**Recommended fix**

Make the public README provider-neutral:

- supported Node version;
- local run;
- production principles (HTTPS/reverse proxy, loopback bind, persistent state/session);
- Docker as optional path;
- move personal free-hosting history to a separate historical note or remove it.

Do not publish VPS-specific SSH aliases, IPs, secrets or private deployment topology in the public README.

---

### P3 — UI is desktop-first and has weak failure UX

**Locations:** `public/css/style.css`, `public/js/app.js`

- fixed four-column grid has no responsive breakpoint;
- many async actions have no visible error state;
- a transient `/api/me` failure can fall back to the login view and resemble an auth problem;
- rapid guild/channel changes are not guarded against stale async responses.

This does not block a desktop-only owner dashboard, but should be fixed if mobile administration matters.

---

### P3 — `libsodium-wrappers` may be removable after runtime verification

It is currently a direct dependency. `@discordjs/voice` documents that a separate encryption library is only required when the runtime does not support `aes-256-gcm`.

Before removing it, verify on the actual Node 24 runtime:

```bash
node -e "console.log(require('node:crypto').getCiphers().includes('aes-256-gcm'))"
```

If true and LocalAFK's real voice smoke test passes without the package, remove it to reduce dependency surface. Treat this as an optimization, **not** a pre-deploy blocker.

Official reference: https://www.npmjs.com/package/@discordjs/voice

## 4. Things that are already good

The audit should not rewrite working code for the sake of activity. Positive findings:

- Small codebase with clear module separation.
- Secrets are environment-driven and `.env` is ignored.
- Dashboard API and Socket.IO require an authenticated session.
- OAuth owner-ID allowlist is a useful strong authorization layer once `state` is added.
- Frontend escapes message/user/channel data before using HTML templates in the reviewed paths; no obvious stored/reflected XSS was found in the current UI rendering logic.
- Message send length is capped at Discord's 2000-character limit.
- Voice target survives restart via disk state.
- Reconnect uses bounded exponential backoff conceptually; the lifecycle race, not the backoff idea, is the defect.
- No database/server framework is required for the core product.
- MIT license and public metadata are present.

## 5. Dependency / supply-chain notes

The lockfile was reviewed across its complete tracked content. Important observations:

- lockfile version 3 is committed;
- direct package versions are modern;
- the decisive incompatibility is `@discordjs/voice@0.19.2` -> Node `>=22.12.0` versus project/Docker Node 18/20 claims;
- no conclusion of “zero vulnerabilities” is made because this audit environment did not execute `npm audit` against the registry.

Before merge/deploy, run from a clean checkout:

```bash
node -v
npm -v
npm ci
npm audit --omit=dev
npm test
```

Any audit finding should be evaluated for reachability and severity rather than upgraded blindly.

## 6. Recommended production shape for the 2 GB VPS

### Preferred: native Node + systemd + Nginx

Why:

- LocalAFK is one small Node service; containers add little isolation value here compared with their operational/networking overhead.
- Native execution makes loopback binding and UFW behavior straightforward.
- The VPS can run a single Node 24 LTS process comfortably without adding Redis or a database solely for this app.

Suggested layout:

```text
/opt/localafk/releases/<git-sha>/     immutable application release
/opt/localafk/current -> releases/... symlink
/etc/localafk/localafk.env            secrets/config, not in git
/var/lib/localafk/                     mutable state/session data
```

Run as a dedicated unprivileged Unix user, e.g. `localafk`, not root.

Systemd should restart on failure, start after network, use a bounded stop timeout, and apply basic hardening such as `NoNewPrivileges=true`, `PrivateTmp=true`, and read-only filesystem protection with an explicit writable `/var/lib/localafk` path. Hardening must be tested rather than copied blindly.

Nginx should terminate TLS and proxy HTTP + WebSocket only to `127.0.0.1:<port>`.

### Secondary: Docker

Keep Docker support only after:

- Node 24 image;
- `npm ci --omit=dev`;
- `.dockerignore`;
- non-root container user where practical;
- loopback-only published port;
- healthcheck if useful;
- no secrets baked into the image.

## 7. Minimal remediation roadmap

### Phase A — correctness/security blockers

1. Fix Node runtime contract everywhere.
2. Fix VoiceManager connection-generation/reconnect lifecycle.
3. Add OAuth `state` + session regeneration.
4. Decide auth policy: OAuth-only preferred; if password remains, rate-limit it.
5. Replace production MemoryStore with a lightweight persistent store.
6. Add explicit loopback `HOST` and safe Docker port binding.
7. Add graceful shutdown.

### Phase B — reliability without bloat

8. Make StateStore atomic/configurable.
9. Add `/healthz`.
10. Add built-in Node tests for voice/auth/state/config.
11. Add minimal Node 24 CI.
12. Run `npm audit --omit=dev` and clean-install test.

### Phase C — cleanup/docs

13. Update README and `.env.example`.
14. Add `.dockerignore`; update Docker path even if native deploy is preferred.
15. Verify whether `libsodium-wrappers` is unnecessary on the target runtime before removing it.
16. Improve mobile/error UX only if it matters to actual use.

## 8. Acceptance gates before any VPS deployment

Do not deploy until all of these are true:

- [ ] Node support contract matches `@discordjs/voice` and production uses Node 24 LTS.
- [ ] Clean `npm ci` succeeds with no engine mismatch.
- [ ] Voice channel switch does not create a stale reconnect timer/loop.
- [ ] Forced Discord voice disconnect recovers with bounded backoff.
- [ ] Restart restores desired voice target correctly.
- [ ] SIGTERM exits cleanly and systemd restarts cleanly.
- [ ] OAuth callback rejects missing/wrong state.
- [ ] Session auth survives ordinary requests and uses a production store.
- [ ] Password endpoint is disabled or rate-limited.
- [ ] App listens only on intended loopback address in production.
- [ ] If Docker is used, port 3000 is not published to all interfaces.
- [ ] Nginx WebSocket proxy is verified.
- [ ] HTTPS is active and `COOKIE_SECURE=true`.
- [ ] `npm audit --omit=dev` reviewed.
- [ ] Automated tests pass.
- [ ] Real smoke test passes: login -> list guilds/channels -> read/send text -> join voice -> remain stable -> restart service -> restore voice -> leave.

## 9. Explicit non-goals / avoid overengineering

For the current personal-owner use case and 2 GB VPS, **do not add these by default**:

- Kubernetes;
- Redis just for sessions/rate limiting;
- PostgreSQL/MySQL just for this app;
- microservices;
- PM2 on top of systemd;
- a large frontend framework rewrite;
- a full observability stack;
- multiple worker processes (Discord client/voice state are intentionally single-process here).

Add infrastructure only when a measured requirement appears.

## 10. Audit limitations

This was a static source/history/configuration audit using the GitHub repository contents. It did **not**:

- connect to the VPS;
- use or inspect any real bot/OAuth secret;
- run the bot against Discord;
- execute a container build;
- execute `npm audit`/dynamic SCA;
- perform load testing or browser penetration testing.

Those checks belong after remediation, first in a clean local/ephemeral environment, then in a controlled VPS smoke test.

## 11. Recommended next action

Before changing source, send the companion `audit/2026-09-06-claude-review-brief.md` to Claude and require an independent review. Claude should be encouraged to **disagree with this audit when evidence supports disagreement**, identify false positives/omissions, and propose the smallest safe remediation plan. No SSH/deploy should happen during that review step.
