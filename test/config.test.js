const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createConfig } = require('../src/config');

function baseEnv(overrides = {}) {
  return {
    BOT_TOKEN: 'controller-token',
    OWNER_DISCORD_IDS: '111',
    ...overrides,
  };
}

test('BOT_TOKEN is required', () => {
  assert.throws(() => createConfig(baseEnv({ BOT_TOKEN: '' })), /BOT_TOKEN/);
});

test('worker tokens are optional and do not prevent startup', () => {
  const config = createConfig(baseEnv());
  assert.equal(config.tokens[1], 'controller-token');
  assert.equal(config.tokens[2], '');
  assert.equal(config.tokens[3], '');
  assert.equal(config.tokens[4], '');
  assert.equal(config.tokens[5], '');
  assert.equal(config.botToken, 'controller-token');
});

test('TOKEN_2..TOKEN_5 are parsed into config.tokens', () => {
  const config = createConfig(
    baseEnv({ TOKEN_2: 'worker-2', TOKEN_3: 'worker-3', TOKEN_4: 'worker-4', TOKEN_5: 'worker-5' })
  );
  assert.equal(config.tokens[2], 'worker-2');
  assert.equal(config.tokens[3], 'worker-3');
  assert.equal(config.tokens[4], 'worker-4');
  assert.equal(config.tokens[5], 'worker-5');
});

test('duplicate tokens across slots are detected without leaking the token value', () => {
  let error;
  try {
    createConfig(baseEnv({ TOKEN_3: 'controller-token' }));
  } catch (err) {
    error = err;
  }
  assert.ok(error, 'expected createConfig to throw');
  assert.match(error.message, /Duplicate bot token configured for slots 1 and 3/);
  assert.doesNotMatch(error.message, /controller-token/);
});

test('duplicate tokens among worker-only slots are also detected', () => {
  assert.throws(
    () => createConfig(baseEnv({ TOKEN_2: 'same', TOKEN_4: 'same' })),
    /Duplicate bot token configured for slots 2 and 4/
  );
});

test('two empty worker slots are never reported as duplicates of each other', () => {
  assert.doesNotThrow(() => createConfig(baseEnv({ TOKEN_2: '', TOKEN_3: '' })));
});
