const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../src/store/stateStore');

async function withTempStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'localafk-state-'));
  try {
    return await run(dir, path.join(dir, 'state.json'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('persists set values atomically and returns them from get', async () => {
  await withTempStore(async (dir, filePath) => {
    const store = new StateStore(filePath);
    const value = { guildId: 'guild-1', channelId: 'channel-1' };

    await store.set('desiredVoice', value);

    assert.deepEqual(await store.get('desiredVoice'), value);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')), {
      desiredVoice: value,
    });
  });
});

test('serializes overlapping writes using a snapshot for each logical set', async () => {
  await withTempStore(async (_dir, filePath) => {
    const firstWriteStarted = deferred();
    const releaseFirstWrite = deferred();
    const snapshots = [];
    const testFs = {
      ...fs,
      writeFile: async (tmpPath, payload, ...args) => {
        snapshots.push(JSON.parse(payload));
        if (snapshots.length === 1) {
          firstWriteStarted.resolve();
          await releaseFirstWrite.promise;
        }
        return fs.writeFile(tmpPath, payload, ...args);
      },
    };
    const store = new StateStore(filePath, { fs: testFs, randomUUID: () => 'overlap' });

    const first = store.set('first', 1);
    const second = store.set('second', 2);
    await firstWriteStarted.promise;

    assert.deepEqual(snapshots, [{ first: 1 }]);
    releaseFirstWrite.resolve();
    await Promise.all([first, second]);

    assert.deepEqual(snapshots, [{ first: 1 }, { first: 1, second: 2 }]);
    assert.deepEqual(await store.get('first'), 1);
    assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), { first: 1, second: 2 });
  });
});

test('a failed write rejects its caller without poisoning the next write', async () => {
  await withTempStore(async (_dir, filePath) => {
    let shouldFail = true;
    const failure = new Error('intentional write failure');
    const testFs = {
      ...fs,
      writeFile: async (tmpPath, payload, ...args) => {
        if (shouldFail) {
          shouldFail = false;
          throw failure;
        }
        return fs.writeFile(tmpPath, payload, ...args);
      },
    };
    const store = new StateStore(filePath, { fs: testFs, randomUUID: () => 'failure' });

    await assert.rejects(store.set('first', 1), (err) => err === failure);
    await store.set('second', 2);

    assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), { first: 1, second: 2 });
  });
});

test('malformed JSON is reported as empty controlled state', async () => {
  await withTempStore(async (_dir, filePath) => {
    await fs.writeFile(filePath, '{not valid json');
    const store = new StateStore(filePath);

    assert.equal(await store.get('desiredVoice'), undefined);
    await store.set('healthy', true);
    assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), { healthy: true });
  });
});

test('failed rename removes the temporary file without masking the original error', async () => {
  await withTempStore(async (dir, filePath) => {
    const failure = new Error('intentional rename failure');
    const testFs = {
      ...fs,
      rename: async () => {
        throw failure;
      },
    };
    const store = new StateStore(filePath, { fs: testFs, randomUUID: () => 'cleanup' });

    await assert.rejects(store.set('value', 1), (err) => err === failure);
    const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});
