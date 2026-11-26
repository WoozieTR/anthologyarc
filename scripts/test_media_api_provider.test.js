const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createMediaApiProvider } = require('../src/shared/media_api_provider.js');
const fixtures = require('./fixtures/media_api_providers.js');

const { config, provider } = fixtures[0];
const movie = {
    id: '42',
    type: 'movie',
    streams: [{ url: config.streamOrigins[0] + '/film.mp4', format: 'mp4' }]
};
const series = { ...movie, type: 'series', season: 2, episode: 3 };

function mockApi(t, body, overrides = {}, expectedUrl) {
    return t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (expectedUrl) assert.equal(url, expectedUrl);
        assert.equal(options.method, 'GET');
        assert.equal(options.headers.Accept, 'application/json');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal);

        if (overrides instanceof Error) throw overrides;
        return {
            ok: true,
            status: 200,
            redirected: false,
            url,
            headers: new Headers({ 'Content-Type': 'application/json; charset=utf-8' }),
            json: async () => body,
            ...overrides
        };
    });
}

for (const { config, provider } of fixtures) {
    test(config.name + ' uses the common series contract with its own configuration', async (t) => {
        const streams = [
            { url: config.streamOrigins[0] + '/sd.mp4', format: 'mp4', quality: '480p' },
            { url: config.streamOrigins[0] + '/hd.m3u8?sig=a%2Bb', format: 'hls', quality: '1080p' }
        ];
        const fetch = mockApi(t, { id: 'tt0123456', type: 'series', season: 0, episode: 3, streams }, {},
            config.apiOrigin + config.streamsPath + '?id=tt0123456&type=series&season=0&episode=3');

        assert.deepEqual(Object.keys(provider), ['getStreams']);
        assert.deepEqual(await provider.getStreams('tt0123456', 'tv', 0, 3), [
            { ...streams[1], name: config.name, title: config.name + ' • 1080p', isHls: true },
            { ...streams[0], name: config.name, title: config.name + ' • 480p', isHls: false }
        ]);
        assert.equal(fetch.mock.callCount(), 1);
    });
}

test('movies omit episode parameters and map streams without optional quality', async (t) => {
    const fetch = mockApi(t, movie, {}, config.apiOrigin + config.streamsPath + '?id=42&type=movie');
    assert.deepEqual(await provider.getStreams(42, 'movie', null, null), [
        { ...movie.streams[0], name: config.name, title: config.name, isHls: false }
    ]);
    assert.equal(fetch.mock.callCount(), 1);
});

test('rejects invalid input before making an HTTP request', async (t) => {
    const fetch = mockApi(t, movie);
    for (const id of [null, {}, '', 0, -1, 1.5, 9007199254740992, '9007199254740992',
        '01', '1e3', ' 42 ', '42:2:3', 'tmdb:42', '42&id=7', 'tt123', 'tt0000000', 'tt0123456\n']) {
        assert.deepEqual(await provider.getStreams(id, 'movie'), [], String(id));
    }
    for (const args of [[42], [42, 'MOVIE'], [42, 'anime'], [42, 'movie', 1, 2],
        [42, 'movie', 0], [42, 'series'], [42, 'series', -1, 3], [42, 'series', 2, 0],
        [42, 'series', '2', 3], [42, 'series', 2, 1.5], [42, 'series', 2, 9007199254740992]]) {
        assert.deepEqual(await provider.getStreams(...args), [], JSON.stringify(args));
    }
    assert.equal(fetch.mock.callCount(), 0);
});

test('requires exact response identity and episode coordinates', async (t) => {
    for (const [label, patch] of Object.entries({
        'wrong ID': { id: '43' },
        'numerical response ID': { id: 42 },
        'wrong media type': { type: 'movie' },
        'response media type alias': { type: 'tv' },
        'wrong season': { season: 1 },
        'wrong episode': { episode: 4 },
        'string season': { season: '2' },
        'missing episode': { episode: undefined }
    })) {
        await t.test(label, async (t) => {
            const fetch = mockApi(t, { ...series, ...patch });
            assert.deepEqual(await provider.getStreams('42', 'series', 2, 3), []);
            assert.equal(fetch.mock.callCount(), 1);
        });
    }
    await t.test('movie response with episode coordinates', async (t) => {
        mockApi(t, { ...movie, episode: 3 });
        assert.deepEqual(await provider.getStreams('42', 'movie'), []);
    });
});

test('rejects the whole response if any stream uses an unapproved URL', async (t) => {
    for (const url of ['http://media.alpha.invalid/film.mp4', 'https://api.alpha.invalid/film.mp4',
        'https://sub.media.alpha.invalid/film.mp4', 'https://media.alpha.invalid.evil.invalid/film.mp4',
        'https://media.alpha.invalid:9443/film.mp4', 'https://user@media.alpha.invalid/film.mp4',
        'https://@media.alpha.invalid/film.mp4', '//media.alpha.invalid/film.mp4',
        'https://media.alpha.invalid/film.mp4#fragment', 'https://media.beta.invalid:9443/film.mp4']) {
        await t.test(url, async (t) => {
            mockApi(t, { ...movie, streams: [...movie.streams, { url, format: 'mp4' }] });
            assert.deepEqual(await provider.getStreams('42', 'movie'), []);
        });
    }
});

test('rejects network failures, redirects, and unexpected response URLs before reading JSON', async (t) => {
    const expectedUrl = config.apiOrigin + config.streamsPath + '?id=42&type=movie';
    for (const [label, overrides] of Object.entries({
        'redirect rejected by Fetch': new TypeError('redirect'),
        'redirect status': { status: 302, headers: new Headers({ Location: expectedUrl }) },
        'redirected back to the same URL': { redirected: true },
        'different origin': { url: 'https://other.invalid/v1/streams?id=42&type=movie' },
        'different path on same origin': { url: config.apiOrigin + '/other?id=42&type=movie' },
        'missing final URL': { url: '' },
        'missing redirect flag': { redirected: undefined },
        'HTTP error': { status: 500 }
    })) {
        await t.test(label, async (t) => {
            const json = t.mock.fn();
            const fetch = mockApi(t, movie, overrides instanceof Error ? overrides : { ...overrides, json });
            assert.deepEqual(await provider.getStreams('42', 'movie'), []);
            assert.equal(fetch.mock.callCount(), 1);
            assert.equal(json.mock.callCount(), 0);
        });
    }
});

test('rejects malformed responses', async (t) => {
    for (const [label, body] of Object.entries({
        'missing body': null,
        'non-object body': [movie],
        'missing streams': { ...movie, streams: undefined },
        'non-array streams': { ...movie, streams: {} },
        'non-object stream': { ...movie, streams: [null] },
        'missing URL': { ...movie, streams: [{ format: 'mp4' }] },
        'unknown format': { ...movie, streams: [{ ...movie.streams[0], format: 'mkv' }] },
        'wrong quality type': { ...movie, streams: [{ ...movie.streams[0], quality: 1080 }] }
    })) {
        await t.test(label, async (t) => {
            mockApi(t, body);
            assert.deepEqual(await provider.getStreams('42', 'movie'), []);
        });
    }
    await t.test('invalid JSON', async (t) => {
        mockApi(t, movie, { json: () => JSON.parse('{') });
        assert.deepEqual(await provider.getStreams('42', 'movie'), []);
    });
    await t.test('non-JSON content type', async (t) => {
        mockApi(t, movie, { headers: new Headers({ 'Content-Type': 'text/html' }) });
        assert.deepEqual(await provider.getStreams('42', 'movie'), []);
    });
});

test('rejects invalid endpoint and origin configuration', () => {
    for (const patch of [
        { apiOrigin: 'http://api.alpha.invalid' },
        { apiOrigin: 'https://user@api.alpha.invalid' },
        { apiOrigin: 'https://api.alpha.invalid/path' },
        { streamsPath: 'https://other.invalid/streams' },
        { streamsPath: '//other.invalid/streams' },
        { streamsPath: '/v1/../streams' },
        { streamsPath: '/streams?fixed=1' },
        { streamOrigins: [] },
        { streamOrigins: ['http://media.alpha.invalid'] },
        { streamOrigins: ['https://media.alpha.invalid/path'] }
    ]) {
        assert.throws(() => createMediaApiProvider({ ...config, ...patch }), TypeError);
    }
});
