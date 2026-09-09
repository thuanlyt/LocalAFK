const os = require('node:os');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DEFAULT_CPU_SAMPLE_INTERVAL_MS = 200;
const DEFAULT_EXEC_TIMEOUT_MS = 2_000;
const DEFAULT_EXEC_MAX_BUFFER = 1024 * 1024; // 1 MB — these are short, line-oriented outputs.
const DEFAULT_PORT_LIMIT = 15;
const DEFAULT_PROCESS_LIMIT = 8;

/**
 * Host/VPS-level, read-only statistics. Deliberately Discord-agnostic (no client, no
 * interaction) so it can be unit tested without a real OS and reused outside commandManager.
 *
 * Every OS call is behind an injectable dependency (`os`, `fs`, `execFile`, `platform`) so
 * tests can simulate Linux/Windows/missing-binary behavior without touching the real host.
 * Nothing here ever builds a shell string or accepts user-controlled arguments: only
 * fixed-argument execFile() calls against a small allowlist (`ps`, `ss`) on Linux.
 */
class StatsProvider {
  constructor(options = {}) {
    this.os = options.os || os;
    this.fs = options.fs || fsp;
    this.execFile = options.execFile || execFileAsync;
    this.platform = options.platform || process.platform;
    this.cpuSampleIntervalMs = options.cpuSampleIntervalMs ?? DEFAULT_CPU_SAMPLE_INTERVAL_MS;
    this.execTimeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    this.execMaxBuffer = options.execMaxBuffer ?? DEFAULT_EXEC_MAX_BUFFER;
    this.portLimit = options.portLimit ?? DEFAULT_PORT_LIMIT;
    this.processLimit = options.processLimit ?? DEFAULT_PROCESS_LIMIT;
    this.showHostname = Boolean(options.showHostname);
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async collect() {
    const [system, ports, processes] = await Promise.all([
      this.collectSystem(),
      this.collectPorts(),
      this.collectProcesses(),
    ]);
    return { system, ports, processes };
  }

  // ---- SYSTEM ----

  async collectSystem() {
    const [cpuUtilizationPercent, disk, swap] = await Promise.all([
      this.sampleCpuUtilization(),
      this.readRootDisk(),
      this.readSwap(),
    ]);

    const totalMemBytes = this.os.totalmem();
    const freeMemBytes = this.os.freemem();

    return {
      hostname: this.showHostname ? this.os.hostname() : null,
      hostnameOmitted: !this.showHostname,
      platform: this.platform,
      release: this.os.release(),
      nodeVersion: process.version,
      uptimeSeconds: this.os.uptime(),
      cpuCount: this.os.cpus()?.length ?? 0,
      cpuUtilizationPercent,
      loadAverage: this.platform === 'linux' ? this.os.loadavg() : null,
      memory: {
        totalBytes: totalMemBytes,
        usedBytes: totalMemBytes - freeMemBytes,
        freeBytes: freeMemBytes,
      },
      swap,
      disk,
    };
  }

  async sampleCpuUtilization() {
    const before = this.os.cpus();
    if (!before?.length) return null;
    await this.sleep(this.cpuSampleIntervalMs);
    const after = this.os.cpus();
    if (!after?.length || after.length !== before.length) return null;

    let idleDelta = 0;
    let totalDelta = 0;
    for (let i = 0; i < before.length; i += 1) {
      const a = before[i].times;
      const b = after[i].times;
      const idleBefore = a.idle;
      const idleAfter = b.idle;
      const totalBefore = a.user + a.nice + a.sys + a.idle + a.irq;
      const totalAfter = b.user + b.nice + b.sys + b.idle + b.irq;
      idleDelta += idleAfter - idleBefore;
      totalDelta += totalAfter - totalBefore;
    }
    if (totalDelta <= 0) return null;
    const utilization = 100 * (1 - idleDelta / totalDelta);
    return Math.max(0, Math.min(100, utilization));
  }

  async readRootDisk() {
    const target = this.platform === 'win32' ? path.parse(process.cwd()).root : '/';
    try {
      if (typeof this.fs.statfs !== 'function') throw new Error('fs.statfs is not available');
      const stats = await this.fs.statfs(target);
      const totalBytes = Number(stats.blocks) * Number(stats.bsize);
      const availableBytes = Number(stats.bavail) * Number(stats.bsize);
      const freeBytes = Number(stats.bfree) * Number(stats.bsize);
      const usedBytes = totalBytes - freeBytes;
      return { totalBytes, usedBytes, availableBytes, unavailableReason: null };
    } catch (err) {
      return { totalBytes: null, usedBytes: null, availableBytes: null, unavailableReason: err.message };
    }
  }

  async readSwap() {
    if (this.platform !== 'linux') return null;
    try {
      const raw = await this.fs.readFile('/proc/meminfo', 'utf8');
      const totalMatch = /^SwapTotal:\s+(\d+)\s*kB$/m.exec(raw);
      const freeMatch = /^SwapFree:\s+(\d+)\s*kB$/m.exec(raw);
      if (!totalMatch || !freeMatch) return null;
      const totalBytes = Number(totalMatch[1]) * 1024;
      const freeBytes = Number(freeMatch[1]) * 1024;
      return { totalBytes, usedBytes: totalBytes - freeBytes };
    } catch {
      return null;
    }
  }

  // ---- PORTS (Linux only: `ss`) ----

  async collectPorts() {
    if (this.platform !== 'linux') {
      return { available: false, reason: 'Unavailable on this platform', entries: [], truncatedCount: 0, establishedCount: null };
    }

    let stdout;
    try {
      ({ stdout } = await this.execFile('ss', ['-H', '-t', '-u', '-n', '-a', '-p'], {
        timeout: this.execTimeoutMs,
        maxBuffer: this.execMaxBuffer,
      }));
    } catch (err) {
      const reason = err.code === 'ENOENT' ? '`ss` is not installed on this host.' : `\`ss\` failed: ${err.message}`;
      return { available: false, reason, entries: [], truncatedCount: 0, establishedCount: null };
    }

    const listening = [];
    let establishedCount = 0;
    for (const line of stdout.split('\n')) {
      const parsed = parseSsLine(line);
      if (!parsed) continue;
      if (parsed.state === 'LISTEN' || parsed.state === 'UNCONN') listening.push(parsed);
      else if (parsed.state === 'ESTAB') establishedCount += 1;
    }

    const entries = listening.slice(0, this.portLimit);
    return {
      available: true,
      reason: null,
      entries,
      truncatedCount: Math.max(0, listening.length - entries.length),
      establishedCount,
    };
  }

  // ---- PROCESSES (Linux only: `ps`) ----

  async collectProcesses() {
    if (this.platform !== 'linux') {
      return { available: false, reason: 'Unavailable on this platform', entries: [], truncatedCount: 0, totalCount: null };
    }

    let stdout;
    try {
      ({ stdout } = await this.execFile(
        'ps',
        ['-eo', 'pid,pcpu,pmem,comm', '--no-headers', '--sort=-pcpu'],
        { timeout: this.execTimeoutMs, maxBuffer: this.execMaxBuffer }
      ));
    } catch (err) {
      const reason = err.code === 'ENOENT' ? '`ps` is not installed on this host.' : `\`ps\` failed: ${err.message}`;
      return { available: false, reason, entries: [], truncatedCount: 0, totalCount: null };
    }

    const all = [];
    for (const line of stdout.split('\n')) {
      const parsed = parsePsLine(line);
      if (parsed) all.push(parsed);
    }

    const entries = all.slice(0, this.processLimit);
    return {
      available: true,
      reason: null,
      entries,
      truncatedCount: Math.max(0, all.length - entries.length),
      totalCount: all.length,
    };
  }
}

/**
 * Parses one `ss -H -t -u -n -a -p` line. Never includes the remote address — only
 * protocol, local bind/port, state, and (when visible) the owning process name.
 * Example line:
 *   tcp   LISTEN 0      128        0.0.0.0:22        0.0.0.0:*     users:(("sshd",pid=123,fd=3))
 */
function parseSsLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const fields = trimmed.split(/\s+/);
  if (fields.length < 5) return null;
  const [protocol, state, , , localAddress] = fields;
  if (!protocol || !state || !localAddress) return null;

  const lastColon = localAddress.lastIndexOf(':');
  if (lastColon === -1) return null;
  const bind = localAddress.slice(0, lastColon) || '*';
  const port = localAddress.slice(lastColon + 1);

  const processMatch = /users:\(\("([^"]+)"/.exec(trimmed);
  const processName = processMatch ? processMatch[1] : 'unknown';

  return {
    protocol: protocol.toLowerCase(),
    localAddress: bind,
    port,
    state: state.toUpperCase(),
    process: processName,
  };
}

/** Parses one `ps -eo pid,pcpu,pmem,comm --no-headers` line. `comm` never contains argv/env. */
function parsePsLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const match = /^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/.exec(trimmed);
  if (!match) return null;
  const [, pid, cpu, mem, name] = match;
  return { pid: Number(pid), cpuPercent: Number(cpu), memPercent: Number(mem), name };
}

module.exports = { StatsProvider, parseSsLine, parsePsLine };
