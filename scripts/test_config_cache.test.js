const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const configDir = path.resolve(__dirname, '../src/shared');
const source = readFileSync(path.join(configDir, 'config.js'), 'utf8');
const cacheTtl = 10 * 60 * 1000;
const failureCooldown = 30 * 1000;
const remoteDeadline = 8_000;

function loadFixture(fetch, localGlobals = {}) {
    let now = 0;
    let nextTimer = 0;
    const timers = new Map();
    const clearedTimers = [];
    const module = { exports: {} };
    runInNewContext(source, {
        module,
        fetch,
        Date: { now: () => now },
        setTimeout(callback, ms) {
            const id = nextTimer++;
            timers.set(id, { callback, deadline: now + ms });
            return id;
        },
        clearTimeout(id) {
            clearedTimers.push(id);
            timers.delete(id);
        },
        ...localGlobals
    });
    function advance(ms) {
        now += ms;
        for (const [id, timer] of timers) {
            if (timer.deadline <= now) {
                timers.delete(id);
                timer.callback();
            }
        }
    }
    return { ...module.exports, advance, timers, clearedTimers };
}

function deferred() {
    let resolve;
    const promise = new Promise((finish) => { resolve = finish; });
    return { promise, resolve };
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
    const { loadConfig, val, advance, timers, clearedTimers } = loadFixture(fetch);
    const calls = [loadConfig(), loadConfig(), loadConfig()];

    await loading;
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(calls[0], calls[1]);
    assert.equal(calls[0], calls[2]);
    advance(5_000);
    finishLoading(config);
    for (const result of await Promise.all(calls)) assert.equal(result, config);
    assert.equal(val('provider.url'), 'fixture');
    assert.equal(timers.size, 0);
    assert.deepEqual(clearedTimers, [0]);

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
        const { loadConfig, val, advance, timers, clearedTimers } = loadFixture(fetch);
        assert.equal(await loadConfig(), null);
        assert.equal(val('provider.url'), undefined);
        assert.equal(timers.size, 0);
        assert.deepEqual(clearedTimers, [0]);
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

for (const [stage, controller] of [
    ['fetch', AbortController],
    ['json', AbortController],
    ['text', undefined]
]) {
    test(`times out during ${stage}, ignores late results and recovers after cooldown`, async (t) => {
        const late = { provider: { url: 'late' } };
        const recovered = { provider: { url: 'recovered' } };
        const pendingFetch = deferred();
        const pendingBody = deferred();
        const readingBody = deferred();
        const fetch = t.mock.fn(() => pendingFetch.promise);
        const { loadConfig, val, advance, timers, clearedTimers } = loadFixture(fetch, {
            AbortController: controller
        });
        const loading = loadConfig();
        assert.equal(loadConfig(), loading);
        let settled = false;
        loading.then(() => { settled = true; });

        await new Promise(setImmediate);
        assert.equal(fetch.mock.callCount(), 1);
        const options = fetch.mock.calls[0].arguments[1];
        if (controller) assert.equal(options.signal.aborted, false);
        else assert.equal('signal' in options, false);
        assert.deepEqual(Array.from(timers.values(), (timer) => timer.deadline), [remoteDeadline]);

        advance(5_000);
        if (stage !== 'fetch') {
            pendingFetch.resolve({
                ok: true,
                [stage]() {
                    readingBody.resolve();
                    return pendingBody.promise;
                }
            });
            await readingBody.promise;
        }

        advance(remoteDeadline - 5_000 - 1);
        await new Promise(setImmediate);
        assert.equal(settled, false);
        advance(1);
        assert.equal(await loading, null);
        if (controller) assert.equal(options.signal.aborted, true);
        assert.equal(timers.size, 0);
        assert.deepEqual(clearedTimers, [0]);
        assert.equal(val('provider.url'), undefined);

        advance(failureCooldown - 1);
        assert.equal(await loadConfig(), null);
        assert.equal(fetch.mock.callCount(), 1);
        advance(1);
        fetch.mock.mockImplementation(async () => ({ ok: true, json: () => recovered }));
        assert.equal(await loadConfig(), recovered);
        assert.equal(fetch.mock.callCount(), 2);
        assert.deepEqual(clearedTimers, [0, 1]);
        assert.equal(timers.size, 0);
        if (controller) assert.equal(fetch.mock.calls[1].arguments[1].signal.aborted, false);

        if (stage === 'fetch') pendingFetch.resolve({ ok: true, json: () => late });
        else pendingBody.resolve(stage === 'text' ? JSON.stringify(late) : late);
        await new Promise(setImmediate);
        assert.equal(val('provider.url'), 'recovered');
        assert.equal(await loadConfig(), recovered);
        assert.equal(fetch.mock.callCount(), 2);
    });
}

test('discards a body parsed past the deadline before the timer can run', async (t) => {
    let now = 0;
    const fetch = t.mock.fn(async () => ({
        ok: true,
        text: async () => '{"provider":{"url":"late"}}'
    }));
    const { loadConfig, val, timers, clearedTimers } = loadFixture(fetch, {
        AbortController,
        Date: { now: () => now },
        JSON: {
            parse(text) {
                now = remoteDeadline;
                return JSON.parse(text);
            }
        }
    });
    assert.equal(await loadConfig(), null);
    assert.equal(val('provider.url'), undefined);
    assert.equal(fetch.mock.calls[0].arguments[1].signal.aborted, true);
    assert.equal(timers.size, 0);
    assert.deepEqual(clearedTimers, [0]);
});

test('prefers the local config file without making a request', async (t) => {
    const fetch = t.mock.fn();
    const { loadConfig, timers, clearedTimers } = loadFixture(fetch, { require, __dirname: configDir });
    const config = await loadConfig();
    assert.equal(JSON.stringify(config), JSON.stringify(require('../config.json')));
    assert.equal(await loadConfig(), config);
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(timers.size, 0);
    assert.deepEqual(clearedTimers, []);
});
