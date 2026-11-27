const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { mediaApiProviders } = require('./fixtures/media_api_config.json');

const root = path.resolve(__dirname, '..');
const modules = path.dirname(path.dirname(require.resolve('esbuild/package.json')));
const [alpha, beta] = mediaApiProviders;

function buildFixture(t) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'anthology-media-api-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

    fs.mkdirSync(path.join(cwd, 'src/shared'), { recursive: true });
    for (const file of ['build.js', 'config.js', 'package.json', 'src/shared/quality.js',
        'src/shared/media_api_entry.js', 'src/shared/media_api_provider.js']) {
        fs.copyFileSync(path.join(root, file), path.join(cwd, file));
    }
    return cwd;
}

function build(cwd, definitions, ...args) {
    fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({ mediaApiProviders: definitions }));
    const result = spawnSync(process.execPath, ['build.js', ...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: modules },
        timeout: 10_000
    });
    assert.ifError(result.error);
    return result;
}

test('both configured providers build from the shared entry and export isolated getStreams functions', async (t) => {
    const cwd = buildFixture(t);
    const result = build(cwd, mediaApiProviders);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const outDir = path.join(cwd, 'providers');
    assert.deepEqual(fs.readdirSync(outDir).sort(), mediaApiProviders.map(({ id }) => `${id}.js`).sort());

    for (const config of mediaApiProviders) {
        const { id, apiOrigin, streamsPath, streamOrigins, name } = config;
        const bundle = fs.readFileSync(path.join(outDir, `${id}.js`), 'utf8');
        assert.match(bundle, /Built from src\/shared\/media_api_entry\.js/);
        const other = config === alpha ? beta : alpha;
        assert.ok(!bundle.includes(other.apiOrigin));

        const stream = { url: streamOrigins[0] + '/film.mp4', format: 'mp4' };
        let jsonReads = 0;
        let fetchCalls = 0;
        let redirectMetadata = { redirected: false };
        let playback = stream;
        const context = vm.createContext({
            module: { exports: {} }, URL, setTimeout, clearTimeout,
            fetch: async (url, options) => {
                fetchCalls++;
                assert.equal(url, apiOrigin + streamsPath + '?id=42&type=movie');
                assert.equal(options.redirect, 'manual');
                return {
                    ok: true, status: 200, url,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    json: async () => {
                        jsonReads++;
                        return { id: '42', type: 'movie', streams: [playback] };
                    },
                    ...redirectMetadata
                };
            }
        });
        vm.runInContext(bundle, context);
        const { getStreams } = context.module.exports;
        assert.deepEqual(Object.keys(context.module.exports), ['getStreams']);
        assert.equal(typeof getStreams, 'function');
        assert.equal(context.getStreams, getStreams);

        assert.deepEqual(JSON.parse(JSON.stringify(await getStreams(42, 'movie'))), [
            { ...stream, name, title: name, isHls: false }
        ]);
        redirectMetadata = {};
        assert.equal((await getStreams(42, 'movie')).length, 0);
        assert.equal(jsonReads, 1);

        redirectMetadata = { redirected: false };
        playback = { ...stream, url: other.streamOrigins[0] + '/film.mp4' };
        assert.equal((await getStreams(42, 'movie')).length, 0);
        assert.equal(jsonReads, 2);
        assert.equal(fetchCalls, 3);
    }
});

test('a configured provider can be selected by ID and minified', (t) => {
    const cwd = buildFixture(t);
    const result = build(cwd, mediaApiProviders, beta.id, '--minify');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\(minified\)/);
    assert.deepEqual(fs.readdirSync(path.join(cwd, 'providers')), [`${beta.id}.js`]);
});

test('invalid definitions fail before writing any bundle', (t) => {
    const cwd = buildFixture(t);
    fs.mkdirSync(path.join(cwd, 'src/legacy'));
    for (const [definitions, error] of [
        [null, /must be an array/],
        [{}, /must be an array/],
        [[alpha, null], /Invalid mediaApiProviders\[1\]/],
        [[alpha, { ...beta, output: '../outside.js' }], /unsupported field/],
        [[alpha, { ...beta, name: '' }], /Invalid media API configuration/],
        [[alpha, { ...beta, apiOrigin: 'https://api.beta.invalid/path' }], /canonical HTTPS origin/],
        [[alpha, { ...beta, streamOrigins: ['http://media.beta.invalid'] }], /absolute HTTPS URL/],
        [[alpha, { ...beta, streamsPath: '/streams?' }], /canonical endpoint path/],
        [[alpha, { ...beta, trustManualRedirects: 'true' }], /Expected a boolean/],
        [[alpha, alpha], /Duplicate or reserved provider ID/],
        ...['legacy', 'shared', 'm3u_list'].map(id => [[alpha, { ...beta, id }], /Duplicate or reserved provider ID/]),
        ...[undefined, '../escape', 'nested/file', 'nested\\file', '/tmp/escape', 'A', 'nul', 'a'.repeat(253)]
            .map(id => [[alpha, { ...beta, id }], /Invalid provider ID/])
    ]) {
        const result = build(cwd, definitions, alpha.id);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, error);
        assert.ok(!fs.existsSync(path.join(cwd, 'providers')));
    }

    for (const args of [['../escape'], [alpha.id, alpha.id]]) {
        const result = build(cwd, mediaApiProviders, ...args);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /provider ID/);
        assert.ok(!fs.existsSync(path.join(cwd, 'providers')));
    }
});

test('configured output cannot follow a symlink or overwrite a hard link', (t) => {
    const cwd = buildFixture(t);
    const outDir = path.join(cwd, 'providers');
    const outside = path.join(cwd, 'outside');
    const target = path.join(outside, `${alpha.id}.js`);
    fs.mkdirSync(outside);
    fs.writeFileSync(target, 'untouched');

    fs.symlinkSync(outside, outDir, 'junction');
    assertUnsafeOutput();
    fs.unlinkSync(outDir);
    fs.mkdirSync(outDir);

    const output = path.join(outDir, `${alpha.id}.js`);
    fs.symlinkSync(target, output, 'file');
    assertUnsafeOutput();
    fs.unlinkSync(output);
    fs.linkSync(target, output);
    assertUnsafeOutput();

    function assertUnsafeOutput() {
        const result = build(cwd, mediaApiProviders);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /Unsafe media API output path/);
        assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
    }
});

test('repository defaults exclude the synthetic providers', () => {
    const production = require('../config.js').mediaApiProviders;
    for (const { id, apiOrigin } of mediaApiProviders) {
        assert.ok(!production.some(config => config.id === id || config.apiOrigin === apiOrigin));
    }
    for (const file of ['manifest.json', 'stremio/manifest.json']) {
        const manifest = fs.readFileSync(path.join(root, file), 'utf8');
        for (const { id, apiOrigin } of mediaApiProviders) {
            assert.ok(!manifest.includes(id));
            assert.ok(!manifest.includes(apiOrigin));
        }
    }
});
