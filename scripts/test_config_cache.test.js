const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const configDir = path.resolve(__dirname, '../src/shared');
const source = readFileSync(path.join(configDir, 'config.js'), 'utf8');
const cacheTtl = 10 * 60 * 1000;
const failureCooldown = 30 * 1000;

function loadFixture(fetch, localGlobals = {}) {
    let now = 0;
    const module = { exports: {} };
    runInNewContext(source, { module, fetch, Date: { now: () => now }, ...localGlobals });
    return { ...module.exports, advance: (ms) => { now += ms; } };
}

test('shares one request across three calls and expires the cache from load completion', async (t) => {
    const config = { provider: { url: 'fixture' } };
    const updated = { provider: { url: 'updated' } };
    let finishLoading;
    let startLoading;
    const loading = new Promise((resolve) => { startLoading = resolve; });
    const fetch = t.mock.fn(async () => ({
        ok: true,
        json: () => new Promise((resolve) => {
            finishLoading = resolve;
            startLoading();
        })
    }));
    const { loadConfig, val, advance } = loadFixture(fetch);
    const calls = [loadConfig(), loadConfig(), loadConfig()];

    await loading;
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(calls[0], calls[1]);
    assert.equal(calls[0], calls[2]);
    advance(5_000);
    finishLoading(config);
    for (const result of await Promise.all(calls)) assert.equal(result, config);
    assert.equal(val('provider.url'), 'fixture');

    fetch.mock.mockImplementation(async () => ({ ok: true, json: () => updated }));
    advance(cacheTtl - 1);
    assert.equal(await loadConfig(), config);
    assert.equal(fetch.mock.callCount(), 1);

    advance(1);
    assert.equal(await loadConfig(), updated);
    assert.equal(fetch.mock.callCount(), 2);
    assert.equal(val('provider.url'), 'updated');
});

for (const [name, fail] of [
    ['rejected fetch', () => Promise.reject(new Error('offline'))],
    ['synchronous fetch error', () => { throw new Error('offline'); }]
]) {
    test(`suppresses requests for 30 seconds after a ${name} and recovers`, async (t) => {
        const fetch = t.mock.fn(() => {
            advance(5_000);
            return fail();
        });
        const { loadConfig, val, advance } = loadFixture(fetch);
        assert.equal(await loadConfig(), null);
        assert.equal(val('provider.url'), undefined);
        assert.equal(await loadConfig(), null);
        advance(failureCooldown - 1);
        assert.equal(await loadConfig(), null);
        assert.equal(fetch.mock.callCount(), 1);

        advance(1);
        const config = { provider: { url: 'recovered' } };
        fetch.mock.mockImplementation(async () => ({ ok: true, json: () => config }));
        assert.equal(await loadConfig(), config);
        assert.equal(await loadConfig(), config);
        assert.equal(fetch.mock.callCount(), 2);
    });
}

test('prefers the local config file without making a request', async (t) => {
    const fetch = t.mock.fn();
    const { loadConfig } = loadFixture(fetch, { require, __dirname: configDir });
    const config = await loadConfig();
    assert.equal(JSON.stringify(config), JSON.stringify(require('../config.json')));
    assert.equal(await loadConfig(), config);
    assert.equal(fetch.mock.callCount(), 0);
});
