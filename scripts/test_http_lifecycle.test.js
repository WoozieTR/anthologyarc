const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

function loadFetch(provider, globals = {}) {
    const filename = path.resolve(__dirname, '../src', provider, 'index.js');
    const requireFromProvider = createRequire(filename);
    const context = {
        URL, setTimeout, clearTimeout, AbortSignal, AbortController,
        ...globals,
        module: { exports: {} },
        require(id) {
            if (id === '../shared/http_request.js' || id === './http_deadline.js') {
                const helper = path.resolve(__dirname, '../src/shared', path.basename(id));
                const module = { exports: {} };
                runInNewContext(readFileSync(helper, 'utf8'), {
                    ...context, module
                }, { filename: helper });
                return module.exports;
            }
            return requireFromProvider(id);
        }
    };
    return runInNewContext(readFileSync(filename, 'utf8') + '\n;safeFetch', context, { filename });
}

function clock() {
    let now = 0;
    let sequence = 0;
    const timers = new Map();
    return {
        timers,
        Date: { now: () => now },
        setTimeout(callback, ms) {
            const id = ++sequence;
            timers.set(id, { callback, at: now + ms });
            return id;
        },
        clearTimeout: id => timers.delete(id),
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

const url = 'http://fixture.invalid/resource';
const pending = () => new Promise(() => {});

test('native fetch enforces one deadline for headers and body without abort support', { timeout: 1000 }, async () => {
    const timers = clock();
    let fetch = pending;
    let bodyReads = 0;
    const safeFetch = loadFetch('tvdiziler', {
        ...timers, AbortController: undefined, AbortSignal: undefined,
        fetch: (...args) => fetch(...args)
    });

    const stalled = assert.rejects(safeFetch(url, {}, 100), /Request timeout/);
    timers.advance(100);
    await stalled;
    assert.equal(timers.timers.size, 0);

    let sendHeaders;
    fetch = () => new Promise(resolve => { sendHeaders = resolve; });
    const result = safeFetch(url, {}, 100);
    await new Promise(setImmediate);
    timers.advance(80);
    sendHeaders({ ok: true, text() { bodyReads++; return pending(); } });
    const response = await result;
    const stalledBody = assert.rejects(response.text(), /Request timeout/);
    await new Promise(setImmediate);
    assert.equal(bodyReads, 1);
    timers.advance(20);
    await stalledBody;
    assert.equal(timers.timers.size, 0);
});

test('native fetch clears timers and preserves status, JSON and errors', { timeout: 1000 }, async () => {
    const timers = clock();
    const networkError = new Error('fixture transport failed');
    let fetch = () => ({
        ok: true, status: 201, headers: { 'x-fixture': 'value' },
        json() { return { header: this.headers['x-fixture'] }; }
    });
    const safeFetch = loadFetch('yabancidizi', { ...timers, fetch: () => fetch() });
    const result = await safeFetch(url);
    assert.equal(result.status, 201);
    assert.equal(result.headers['x-fixture'], 'value');
    assert.equal(timers.timers.size, 0);
    assert.deepEqual(await result.json(), { header: 'value' });
    assert.equal(timers.timers.size, 0);
    fetch = () => ({ ok: false, status: 404, text: pending });
    assert.equal((await safeFetch(url)).status, 404);
    assert.equal(timers.timers.size, 0);
    const parseError = new SyntaxError('invalid fixture JSON');
    fetch = () => ({ ok: true, json() { throw parseError; } });
    const invalid = await safeFetch(url);
    await assert.rejects(invalid.json(), error => error === parseError);
    assert.equal(timers.timers.size, 0);
    fetch = () => { throw networkError; };
    await assert.rejects(async () => safeFetch(url), error => error === networkError);
    assert.equal(timers.timers.size, 0);
});

test('native fetch aborts a pending body and releases the caller signal listener', { timeout: 1000 }, async () => {
    const timers = clock();
    const controller = new AbortController();
    const listeners = new Set();
    const signal = {
        get aborted() { return controller.signal.aborted; },
        get reason() { return controller.signal.reason; },
        addEventListener(name, listener) {
            listeners.add(listener);
            controller.signal.addEventListener(name, listener);
        },
        removeEventListener(name, listener) {
            listeners.delete(listener);
            controller.signal.removeEventListener(name, listener);
        }
    };
    let transportSignal;
    const safeFetch = loadFetch('yabancidizi', {
        ...timers, fetch: (_, options) => {
            transportSignal = options.signal;
            return { ok: true, json: pending };
        }
    });
    const response = await safeFetch(url, { signal });
    assert.equal(listeners.size, 0);
    const reason = new Error('fixture cancelled');
    const reading = assert.rejects(response.json(), error => error === reason);
    assert.equal(listeners.size, 1);
    controller.abort(reason);
    await reading;
    assert.equal(transportSignal.aborted, true);
    assert.equal(listeners.size, 0);
    assert.equal(timers.timers.size, 0);
    transportSignal = undefined;
    await assert.rejects(safeFetch(url, { signal }), error => error === reason);
    assert.equal(transportSignal, undefined);
});

test('Node HTTP preserves the response on success and rejects a truncated body', { timeout: 2000 }, async (t) => {
    const server = createServer((req, res) => {
        if (req.url === '/closed') {
            req.socket.destroy();
            return;
        }
        if (req.url === '/truncated') {
            res.writeHead(200, { 'content-length': '30' });
            res.write('partial', () => res.destroy());
            return;
        }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            res.writeHead(201, { 'x-fixture': 'value' });
            res.end(body);
        });
    });
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const local = 'http://127.0.0.1:' + server.address().port;
    const timers = clock();
    for (const provider of ['tvdiziler', 'yabancidizi']) {
        const safeFetch = loadFetch(provider, { ...timers, process });
        const response = await safeFetch(local, {
            method: 'POST', body: '{"ok":true}', headers: { 'content-type': 'application/json' }
        });
        assert.equal(response.ok, true);
        assert.equal(response.status, 201);
        assert.equal(response.headers['x-fixture'], 'value');
        assert.equal(await response.text(), '{"ok":true}');
        assert.equal((await response.json()).ok, true);
        assert.equal(timers.timers.size, 0);
        await assert.rejects(safeFetch(local + '/closed'), { code: 'ECONNRESET' });
        await assert.rejects(safeFetch(local + '/truncated'), { code: 'ECONNRESET' });
        assert.equal(timers.timers.size, 0);
    }
});

test('Node HTTP enforces a total deadline and closes timed-out or cancelled requests', { timeout: 2000 }, async (t) => {
    let notifyRequest;
    const server = createServer((req, res) => {
        if (req.url === '/body') {
            res.writeHead(200);
            res.write('first chunk');
        }
        notifyRequest(res);
    });
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const local = 'http://127.0.0.1:' + server.address().port;
    const timers = clock();
    const safeFetch = loadFetch('yabancidizi', { ...timers, process });

    for (const route of ['/headers', '/body', '/cancel']) {
        const controller = new AbortController();
        const received = new Promise(resolve => { notifyRequest = resolve; });
        const request = safeFetch(local + route, { signal: controller.signal }, 100);
        const response = await received;
        const disconnected = new Promise(resolve => response.once('close', resolve));
        if (route === '/body') {
            timers.advance(80);
            await new Promise(resolve => response.write('another chunk', resolve));
            assert.equal(timers.timers.size, 1);
        }
        if (route === '/cancel') {
            const reason = new Error('cancel loopback request');
            const rejected = assert.rejects(request, error => error === reason);
            controller.abort(reason);
            await rejected;
        } else {
            const rejected = assert.rejects(request, { message: 'Request timeout' });
            timers.advance(route === '/body' ? 20 : 100);
            await rejected;
        }
        await disconnected;
        assert.equal(timers.timers.size, 0);
    }
});
