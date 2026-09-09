const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StatsProvider, parseSsLine, parsePsLine } = require('../src/system/statsProvider');

function makeCpuSequence(sequence) {
  let call = 0;
  return () => {
    const result = sequence[Math.min(call, sequence.length - 1)];
    call += 1;
    return result;
  };
}

function makeOsStub(overrides = {}) {
  return {
    hostname: () => 'test-host',
    release: () => '6.8.0-test',
    totalmem: () => 2 * 1024 * 1024 * 1024,
    freemem: () => 512 * 1024 * 1024,
    uptime: () => 12_345,
    cpus: () => [{ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
    loadavg: () => [0.1, 0.2, 0.3],
    ...overrides,
  };
}

test('samples CPU utilization from two os.cpus() snapshots', async () => {
  // totalBefore = 100+0+50+850+0 = 1000, totalAfter = 150+0+60+890+0 = 1100 -> totalDelta = 100
  // idleDelta = 890-850 = 40 -> utilization = 100 * (1 - 40/100) = 60
  const before = [{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }];
  const after = [{ times: { user: 150, nice: 0, sys: 60, idle: 890, irq: 0 } }];
  const provider = new StatsProvider({
    platform: 'linux',
    os: makeOsStub({ cpus: makeCpuSequence([before, after]) }),
    sleep: async () => {},
  });

  const utilization = await provider.sampleCpuUtilization();
  assert.ok(Math.abs(utilization - 60) < 0.01);
});

test('CPU utilization is null when no cores are reported', async () => {
  const provider = new StatsProvider({ os: makeOsStub({ cpus: () => [] }), sleep: async () => {} });
  assert.equal(await provider.sampleCpuUtilization(), null);
});

test('reads root disk usage via fs.statfs', async () => {
  const provider = new StatsProvider({
    platform: 'linux',
    fs: { statfs: async () => ({ bsize: 4096, blocks: 1000, bfree: 400, bavail: 380 }) },
  });

  const disk = await provider.readRootDisk();
  assert.equal(disk.totalBytes, 4096 * 1000);
  assert.equal(disk.availableBytes, 4096 * 380);
  assert.equal(disk.usedBytes, 4096 * 1000 - 4096 * 400);
  assert.equal(disk.unavailableReason, null);
});

test('disk read failure reports unavailableReason instead of throwing', async () => {
  const provider = new StatsProvider({
    platform: 'linux',
    fs: {
      statfs: async () => {
        throw new Error('statfs not supported');
      },
    },
  });

  const disk = await provider.readRootDisk();
  assert.equal(disk.totalBytes, null);
  assert.match(disk.unavailableReason, /statfs not supported/);
});

test('parses swap totals from /proc/meminfo on Linux', async () => {
  const provider = new StatsProvider({
    platform: 'linux',
    fs: { readFile: async () => 'SwapTotal:       2097152 kB\nSwapFree:        1048576 kB\n' },
  });

  const swap = await provider.readSwap();
  assert.equal(swap.totalBytes, 2_097_152 * 1024);
  assert.equal(swap.usedBytes, (2_097_152 - 1_048_576) * 1024);
});

test('swap is null on non-Linux platforms and never reads /proc', async () => {
  let readCalled = false;
  const provider = new StatsProvider({
    platform: 'win32',
    fs: {
      readFile: async () => {
        readCalled = true;
        return '';
      },
    },
  });

  assert.equal(await provider.readSwap(), null);
  assert.equal(readCalled, false);
});

test('parseSsLine extracts protocol/bind/port/state/pid/process without the remote address', () => {
  const line = 'tcp    LISTEN  0      128    0.0.0.0:22        0.0.0.0:*     users:(("sshd",pid=111,fd=3))';
  const parsed = parseSsLine(line);
  assert.equal(parsed.protocol, 'tcp');
  assert.equal(parsed.localAddress, '0.0.0.0');
  assert.equal(parsed.port, '22');
  assert.equal(parsed.state, 'LISTEN');
  assert.equal(parsed.pid, 111);
  assert.equal(parsed.process, 'sshd');
});

test('parseSsLine falls back to unknown/null when process info is not visible (unprivileged ss)', () => {
  const line = 'tcp    LISTEN  0      128    127.0.0.1:3000     0.0.0.0:*';
  const parsed = parseSsLine(line);
  assert.equal(parsed.process, 'unknown');
  assert.equal(parsed.pid, null);
});

test('parsePsLine only extracts pid/cpu/mem/comm, never full argv', () => {
  const parsed = parsePsLine('  123   12.3   4.5 node');
  assert.deepEqual(parsed, { pid: 123, cpuPercent: 12.3, memPercent: 4.5, name: 'node' });
});

test('collectPorts never surfaces a remote peer address, and drops non-listening rows', async () => {
  const sample = [
    'tcp   LISTEN 0 128    0.0.0.0:22         0.0.0.0:*     users:(("sshd",pid=1,fd=3))',
    'tcp   ESTAB  0 0      10.0.0.5:22        203.0.113.77:54321 users:(("sshd",pid=2,fd=4))',
    'udp   UNCONN 0 0      0.0.0.0:53         0.0.0.0:*     users:(("systemd-resolve",pid=3,fd=5))',
  ].join('\n');
  const provider = new StatsProvider({
    platform: 'linux',
    enablePortsHelper: false,
    execFile: async () => ({ stdout: sample }),
  });

  const ports = await provider.collectPorts();
  assert.equal(ports.available, true);
  assert.equal(ports.entries.length, 2); // LISTEN + UNCONN kept, ESTAB dropped
  assert.ok(ports.entries.some((entry) => entry.port === '22' && entry.state === 'LISTEN'));
  assert.ok(!ports.entries.some((entry) => entry.state === 'ESTAB'));
  assert.doesNotMatch(JSON.stringify(ports), /203\.0\.113\.77/);
});

test('collectPorts degrades gracefully when ss is missing, instead of throwing', async () => {
  const missing = Object.assign(new Error('not found'), { code: 'ENOENT' });
  const provider = new StatsProvider({ platform: 'linux', enablePortsHelper: false, execFile: async () => { throw missing; } });

  const ports = await provider.collectPorts();
  assert.equal(ports.available, false);
  assert.match(ports.reason, /ss/);
});

test('collectPorts uses the privileged helper via sudo -n when it succeeds, and never runs plain ss', async () => {
  const calls = [];
  const provider = new StatsProvider({
    platform: 'linux',
    sudoPath: '/usr/bin/sudo',
    portsHelperPath: '/usr/local/libexec/localafk-portstats',
    execFile: async (bin, args) => {
      calls.push([bin, args]);
      return { stdout: 'tcp LISTEN 0 1 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=42,fd=1))' };
    },
  });

  const ports = await provider.collectPorts();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/usr/bin/sudo');
  assert.deepEqual(calls[0][1], ['-n', '/usr/local/libexec/localafk-portstats']);
  assert.equal(ports.entries[0].pid, 42);
});

test('collectPorts falls back to plain ss when the privileged helper is unavailable', async () => {
  const calls = [];
  const provider = new StatsProvider({
    platform: 'linux',
    execFile: async (bin, args) => {
      calls.push(bin);
      if (bin === '/usr/bin/sudo') {
        const err = Object.assign(new Error('sudo: a password is required'), { code: 1 });
        throw err;
      }
      return { stdout: 'tcp LISTEN 0 1 0.0.0.0:22 0.0.0.0:* users:()' };
    },
  });

  const ports = await provider.collectPorts();
  assert.deepEqual(calls, ['/usr/bin/sudo', 'ss']);
  assert.equal(ports.available, true);
  assert.equal(ports.entries[0].process, 'unknown');
});

test('collectPorts skips the helper entirely when enablePortsHelper is false', async () => {
  const calls = [];
  const provider = new StatsProvider({
    platform: 'linux',
    enablePortsHelper: false,
    execFile: async (bin) => {
      calls.push(bin);
      return { stdout: '' };
    },
  });

  await provider.collectPorts();
  assert.deepEqual(calls, ['ss']);
});

test('collectProcesses limits rows and reports totalCount/truncatedCount', async () => {
  const lines = [];
  for (let i = 1; i <= 20; i += 1) lines.push(i + ' 1.0 1.0 proc' + i);
  const provider = new StatsProvider({
    platform: 'linux',
    processLimit: 8,
    execFile: async () => ({ stdout: lines.join('\n') }),
  });

  const processes = await provider.collectProcesses();
  assert.equal(processes.entries.length, 8);
  assert.equal(processes.totalCount, 20);
  assert.equal(processes.truncatedCount, 12);
});

test('ports and processes are marked unavailable — not crashed — on non-Linux platforms, and never shell out', async () => {
  let execCalled = false;
  const provider = new StatsProvider({
    platform: 'win32',
    execFile: async () => {
      execCalled = true;
      return { stdout: '' };
    },
  });

  const ports = await provider.collectPorts();
  const processes = await provider.collectProcesses();
  assert.equal(ports.available, false);
  assert.equal(processes.available, false);
  assert.equal(execCalled, false);
});

test('hostname is omitted by default and only included when explicitly enabled', async () => {
  const hidden = new StatsProvider({ os: makeOsStub(), sleep: async () => {} });
  const shown = new StatsProvider({ os: makeOsStub(), sleep: async () => {}, showHostname: true });

  const hiddenSystem = await hidden.collectSystem();
  const shownSystem = await shown.collectSystem();
  assert.equal(hiddenSystem.hostname, null);
  assert.equal(hiddenSystem.hostnameOmitted, true);
  assert.equal(shownSystem.hostname, 'test-host');
});

test('collect() aggregates system/ports/processes on a fully-stubbed Linux host', async () => {
  const provider = new StatsProvider({
    platform: 'linux',
    enablePortsHelper: false,
    os: makeOsStub(),
    fs: {
      statfs: async () => ({ bsize: 4096, blocks: 100, bfree: 50, bavail: 45 }),
      readFile: async () => 'SwapTotal:       0 kB\nSwapFree:        0 kB\n',
    },
    execFile: async (bin) =>
      bin === 'ss'
        ? { stdout: 'tcp LISTEN 0 1 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=1))' }
        : { stdout: '1 0.5 0.5 init' },
    sleep: async () => {},
  });

  const stats = await provider.collect();
  assert.ok(stats.system.cpuCount >= 1);
  assert.equal(stats.ports.available, true);
  assert.equal(stats.processes.available, true);
});
