const os = require('node:os');

const DEFAULT_SAMPLE_MS = 200;

/**
 * Samples this Node process's own CPU usage over a short window and returns it as a
 * percentage of *total* VPS CPU capacity (i.e. divided by core count, so a single-core-busy
 * process on an 8-core host reads ~12.5%, not ~100%) — this is what an owner asking "how much
 * of the VPS does LocalAFK use" wants, not a per-core percentage. Uses process.cpuUsage()
 * deltas (real elapsed CPU time), never process.uptime()-based cumulative-time tricks.
 */
async function sampleProcessCpuPercent(options = {}) {
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const cpuUsage = options.cpuUsage || process.cpuUsage.bind(process);
  const hrtime = options.hrtime || process.hrtime.bigint;
  const cpuCount = options.cpuCount ?? (os.cpus()?.length || 1);
  const sampleMs = options.sampleMs ?? DEFAULT_SAMPLE_MS;

  const startUsage = cpuUsage();
  const startTime = hrtime();
  await sleep(sampleMs);
  const delta = cpuUsage(startUsage);
  const elapsedMs = Number(hrtime() - startTime) / 1e6;
  if (elapsedMs <= 0) return null;

  const usedMs = (delta.user + delta.system) / 1000;
  const percent = (usedMs / (elapsedMs * Math.max(cpuCount, 1))) * 100;
  return Math.max(0, percent);
}

module.exports = { sampleProcessCpuPercent };
