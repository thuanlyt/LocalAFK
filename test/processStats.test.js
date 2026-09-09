const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sampleProcessCpuPercent } = require('../src/system/processStats');

function makeCpuUsageSequence(sequence) {
  let call = 0;
  return (prev) => {
    const result = sequence[Math.min(call, sequence.length - 1)];
    call += 1;
    if (!prev) return result;
    return { user: result.user - prev.user, system: result.system - prev.system };
  };
}

test('normalizes process CPU usage against total core count, not per-core', async () => {
  // 100ms of combined user+system CPU time used over a 200ms window on a 4-core host:
  // (100ms used) / (200ms elapsed * 4 cores) * 100 = 12.5%
  const cpuUsage = makeCpuUsageSequence([
    { user: 0, system: 0 },
    { user: 60_000, system: 40_000 }, // microseconds: 60ms + 40ms = 100ms
  ]);
  let time = 0n;
  const hrtime = () => {
    const value = time;
    time += 200_000_000n; // 200ms in nanoseconds, advances on each call
    return value;
  };

  const percent = await sampleProcessCpuPercent({
    cpuCount: 4,
    sampleMs: 1,
    sleep: async () => {},
    cpuUsage,
    hrtime,
  });

  assert.ok(Math.abs(percent - 12.5) < 0.01, 'expected ~12.5%, got ' + percent);
});

test('a fully busy single core on a single-core host reads close to 100%, not 25% or similar', async () => {
  const cpuUsage = makeCpuUsageSequence([
    { user: 0, system: 0 },
    { user: 100_000, system: 0 }, // 100ms used over a 100ms window
  ]);
  let time = 0n;
  const hrtime = () => {
    const value = time;
    time += 100_000_000n;
    return value;
  };

  const percent = await sampleProcessCpuPercent({ cpuCount: 1, sampleMs: 1, sleep: async () => {}, cpuUsage, hrtime });
  assert.ok(Math.abs(percent - 100) < 1, 'expected ~100%, got ' + percent);
});

test('returns null instead of NaN/Infinity when elapsed time cannot be measured', async () => {
  const cpuUsage = () => ({ user: 0, system: 0 });
  const hrtime = () => 0n; // no time ever elapses
  const percent = await sampleProcessCpuPercent({ cpuCount: 2, sampleMs: 1, sleep: async () => {}, cpuUsage, hrtime });
  assert.equal(percent, null);
});

test('uses the real process.cpuUsage()/hrtime by default and resolves a finite number', async () => {
  const percent = await sampleProcessCpuPercent({ sampleMs: 20 });
  assert.equal(typeof percent, 'number');
  assert.ok(Number.isFinite(percent));
  assert.ok(percent >= 0);
});
