const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { mockNuvioDesktop } = require('./fixtures/nuvio_desktop_fetch');

const url = 'https://fixture.invalid/metadata';
const deadline = 25;
const turn = () => new Promise(setImmediate);

function loadHttp(fetch, controller = AbortController) {
    let now = 0;
    let nextId = 0;
    const timers = new Map();
    const cleared = [];
    const globals = {
        AbortController: controller,
        Headers,
        fetch,
        Date: { now: () => now },
        setTimeout(callback, delay) {
            const id = nextId++;
            timers.set(id, { callback, at: now + delay });
            return id;
        },
        clearTimeout(id) {
            cleared.push(id);
            timers.delete(id);
        }
    };
    function load(name) {
        const module = { exports: {} };
        runInNewContext(readFileSync(require.resolve('../src/shared/' + name), 'utf8'), {
            ...globals, module, require: load
        });
        return module.exports;
    }
    return {
        ...load('http.js'), timers, cleared,
        advance(ms) {
            now += ms;
            for (const [id, timer] of timers) {
                if (timer.at <= now) {
                    timers.delete(id);
                    timer.callback();
                }
            }
        }
    };
}

test('enforces the deadline when Nuvio Desktop ignores cancellation', { timeout: 1000 }, async (t) => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const requests = mockNuvioDesktop(t, new Map([[url, pending]]));
    let signal;
    const http = loadHttp((input, options) => {
        signal = options.signal;
        return fetch(input, options);
    });
    const result = http.fetchWithTimeout(url, {}, deadline);
    const rejected = assert.rejects(result, { message: 'Request timeout' });
    await turn();
    assert.deepEqual(requests, [url]);
    http.advance(deadline);
    await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(http.timers.size, 0);
    assert.deepEqual(http.cleared, [0]);
    finish({ json: () => ({}) });
    await turn();
});

test('reuses frozen options and headers with a fresh signal and cleans up after success', async () => {
    const response = { status: 200 };
    const requests = [];
    const http = loadHttp((_, options) => {
        requests.push(options);
        return response;
    });
    const headers = Object.freeze({ Accept: 'application/json' });
    const options = Object.freeze({ headers, method: 'GET' });

    assert.equal((await http.fetchWithTimeout(url, options, deadline)).status, response.status);
    http.advance(deadline);
    assert.equal((await http.fetchWithTimeout(url, options, deadline)).status, response.status);
    assert.deepEqual(http.cleared, [0, 1]);
    assert.equal(http.timers.size, 0);
    assert.notEqual(requests[0].signal, requests[1].signal);
    for (const request of requests) {
        assert.equal(request.signal.aborted, false);
        assert.equal(request.method, 'GET');
        assert.equal(request.headers.Accept, headers.Accept);
        assert.equal(request.headers['User-Agent'], http.DEFAULT_UA);
        assert.notEqual(request.headers, headers);
    }
});

test('keeps caller cancellation and removes its listener after abort, timeout or fetch failure', { timeout: 1000 }, async (t) => {
    for (const mode of ['abort', 'timeout', 'failure']) {
        await t.test(mode, async (t) => {
            const controller = new AbortController();
            const { signal } = controller;
            const add = t.mock.method(signal, 'addEventListener');
            const remove = t.mock.method(signal, 'removeEventListener');
            const error = new Error(mode);
            let forwarded;
            const http = loadHttp((_, options) => {
                forwarded = options.signal;
                if (mode === 'failure') throw error;
                return new Promise(() => {});
            });
            const result = http.fetchWithTimeout(url, { signal }, deadline);
            const rejected = mode === 'timeout'
                ? assert.rejects(result, { message: 'Request timeout' })
                : assert.rejects(result, actual => actual === error);
            await turn();
            if (mode === 'abort') controller.abort(error);
            if (mode === 'timeout') http.advance(deadline);
            await rejected;
            assert.equal(forwarded, signal);
            assert.equal(signal.aborted, mode === 'abort');
            assert.deepEqual(http.cleared, [0]);
            assert.equal(http.timers.size, 0);
            assert.equal(add.mock.callCount(), 1);
            assert.equal(remove.mock.callCount(), 1);
            assert.deepEqual(remove.mock.calls[0].arguments, add.mock.calls[0].arguments);
        });
    }
});

test('body readers and clones share the original deadline with native response properties', { timeout: 1000 }, async () => {
    let transportSignal;
    const original = new Response(new ReadableStream({}), {
        status: 202, headers: { 'Content-Type': 'text/plain' }
    });
    const http = loadHttp((_, options) => {
        transportSignal = options.signal;
        return original;
    });
    const response = await http.fetchWithTimeout(url, {}, deadline);
    assert.ok(response instanceof Response);
    assert.equal(response.constructor, Response);
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('content-type'), 'text/plain');
    assert.equal(response.body, original.body);
    assert.equal(response.bodyUsed, false);
    const clone = response.clone();
    http.advance(deadline - 1);
    const first = assert.rejects(response.text(), { message: 'Request timeout' });
    const second = assert.rejects(clone.arrayBuffer(), { message: 'Request timeout' });
    await turn();
    assert.equal(response.bodyUsed, true);
    http.advance(1);
    await Promise.all([first, second]);
    assert.equal(transportSignal.aborted, true);
    assert.equal(http.timers.size, 0);
    await assert.rejects(response.json(), { message: 'Request timeout' });
    assert.equal(http.timers.size, 0);
});

test('caller cancellation still interrupts a pending body read', { timeout: 1000 }, async () => {
    const controller = new AbortController();
    const http = loadHttp((_, options) => {
        assert.equal(options.signal, controller.signal);
        return {
            text() { return new Promise(() => {}); },
            json() { return { fixture: true }; }
        };
    });
    const response = await http.fetchWithTimeout(url, { signal: controller.signal }, deadline);
    assert.deepEqual(await response.json(), { fixture: true });
    assert.equal(http.timers.size, 0);
    const reason = new Error('caller cancelled');
    const rejected = assert.rejects(response.text(), error => error === reason);
    await turn();
    controller.abort(reason);
    await rejected;
    assert.equal(http.timers.size, 0);
});
