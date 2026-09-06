# Claude independent review brief — LocalAFK

Use this brief **before any source edit or VPS deployment**.

## Context

Repository: `thuanlyt/LocalAFK`  
Source baseline audited: `c397d5d08efa2396a7b3b12fb7b98bed2ab64670`  
Audit report: `audit/2026-09-06-full-audit.md`

Target VPS context for eventual deployment:

- Provider: ThueCloud
- Plan: VPS Việt Nam 2
- OS: Ubuntu 24.04 LTS
- 2 vCPU
- 2 GB RAM
- 30 GB SSD
- Kernel: `6.8.0-138-generic`
- The only SSH entrypoint that the owner has explicitly verified is: `ssh thuanlyt-vps-root`

**Do not SSH in this review step. Do not deploy. Do not modify application source.**

## Your role

Act as an independent senior reviewer, not an agreeable implementation agent.

Read the entire repository and the audit report yourself. Treat the existing audit as a hypothesis to test, not as instructions that must be accepted.

You are explicitly expected to disagree where appropriate.

## What to do

1. Independently inspect all tracked application/config/docs/dependency files.
2. Verify or refute every P0/P1 finding in `audit/2026-09-06-full-audit.md` with concrete code/package/documentation evidence.
3. Look for important issues the audit missed, especially:
   - Discord voice lifecycle/reconnect behavior;
   - authentication/session/OAuth security;
   - public network exposure behind Nginx/UFW/Docker;
   - Node/runtime/dependency compatibility;
   - data persistence and crash recovery;
   - resource use on a 2 GB VPS;
   - shutdown/restart behavior;
   - WebSocket reverse proxy concerns;
   - unsafe assumptions in README/deployment instructions.
4. Identify any audit recommendation that is unnecessary, overengineered, harmful, or not worth its cost for this owner-only small application.
5. Challenge the recommendation **native Node 24 + systemd + Nginx vs Docker**. Compare both for this exact application and VPS. Pick a preferred path only after considering security, RAM/CPU/disk overhead, reproducibility, operational simplicity, UFW behavior, rollback, and maintenance.
6. Evaluate whether `libsodium-wrappers` is actually needed with the intended Node runtime. Do not remove it based on theory alone; state the exact runtime check/smoke test required.
7. Propose the smallest coherent remediation sequence that makes the repository safe and reliable enough to deploy.
8. Define objective acceptance tests/gates for declaring remediation complete.

## Rules

- Do not modify source in this step.
- Do not SSH or touch the VPS in this step.
- Do not use real credentials/tokens.
- Do not silently accept claims from README or the audit.
- Do not invent test results you did not execute.
- Distinguish confirmed defect, likely risk, optional hardening, and personal preference.
- Prefer fewer dependencies and lower operational overhead unless added complexity has a concrete benefit.
- Do not recommend Kubernetes, Redis, a new database, microservices, or a frontend rewrite without strong evidence they are required.
- Preserve LocalAFK's core behavior: owner-controlled Discord bot dashboard, text chat, persistent 24/7 voice presence, reconnect, and restore after restart.

## Required response format

### A. Overall verdict

State one of:

- audit mostly correct;
- audit partly correct with material corrections;
- audit materially flawed.

Explain why in a few paragraphs.

### B. P0/P1 verification table

For every P0/P1 item from the audit, return:

- finding;
- agree / partly agree / disagree;
- evidence;
- actual severity;
- minimal fix.

### C. Missed findings

List only meaningful omissions, with severity and evidence.

### D. Overengineering / unnecessary recommendations

Call out anything that should be dropped or deferred.

### E. Native systemd vs Docker decision

Compare both and give a recommendation for this exact VPS, including why the losing option is less suitable.

### F. Minimal remediation plan

Ordered steps. No implementation yet.

### G. Acceptance gates

Concrete tests/checks that must pass before deployment.

### H. Questions or decisions for the owner

Ask only questions that genuinely change architecture/security/deployment. Do not ask for information already present in the repository/context.

End after the review. **Do not begin fixes and do not deploy.**
