const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const source = readFileSync(require.resolve('../src/shared/turkish_series'), 'utf8');
const base = 'https://api.themoviedb.org/3';
const key = '?api_key=fixture';
const localized = '&language=tr-TR';
const tv = base + '/tv/123';
const movie = base + '/movie/456';
const find = base + '/find/tt123' + key + '&external_source=imdb_id' + localized;
const search = base + '/search/tv?query=G%C3%B6lge%20Dizi&api_key=fixture' + localized + '&page=1';
const seasons = [{ id: 7, season_number: 2, episode_count: 8 }];
const tvDetails = { name: 'Gölge Dizi', original_name: 'Original Series', original_language: 'tr', origin_country: ['TR'], seasons };
const tvIdentity = {
    title: 'Gölge Dizi', origTitle: 'Original Series', numericId: '123', imdbId: 'tt456',
    aliases: ['tt456', 'Diğer Ad'], seasons, kind: 'tmdb', type: 'tv', originalLanguage: 'tr', originCountry: ['TR']
};

function translations(...names) {
    return { translations: names.map(name => ({ data: { name } })) };
}

async function resolve(routes, rawId, type, { withAbortController = true } = {}) {
    let now = 0;
    const requests = [];
    const jsonCalls = [];
    const pending = new Set();
    const deadlines = new Set();
    const unexpected = [];
    const module = { exports: {} };

    function schedule(done, delay) {
        const event = { at: now + delay, done };
        pending.add(event);
        return event;
    }

    function wait(delay) {
        return new Promise(done => {
            if (delay !== Infinity) schedule(done, delay);
        });
    }

    async function advance() {
        const next = [...pending].sort((a, b) => a.at - b.at)[0];
        now = next.at;
        for (const event of pending) {
            if (event.at !== now) continue;
            pending.delete(event);
            event.done();
        }
        await new Promise(setImmediate);
    }

    runInNewContext(source, {
        module,
        Date: { now: () => now },
        AbortController: withAbortController ? AbortController : undefined,
        setTimeout(done, delay) {
            const event = schedule(done, delay);
            deadlines.add(event);
            return event;
        },
        clearTimeout(event) {
            pending.delete(event);
            deadlines.delete(event);
        },
        async fetch(url, { headers, signal }) {
            const route = routes.find(([expected]) => expected === url);
            requests.push([url, now, headers.Accept, headers['User-Agent'], signal]);
            if (!route) {
                unexpected.push(url);
                throw new Error('Unexpected request: ' + url);
            }
            const [, delay, data, jsonDelay = 0] = route;
            // The transport deliberately ignores cancellation.
            await wait(delay);
            if (data instanceof Error) throw data;
            if (data === null) return { ok: false, status: 429 };
            return {
                ok: true,
                async json() {
                    jsonCalls.push(url);
                    if (jsonDelay) await wait(jsonDelay);
                    if (data === undefined) throw new SyntaxError('Invalid JSON');
                    return data;
                }
            };
        }
    });

    let settled = false;
    const result = module.exports.resolveSeriesInfo(rawId, type, 'fixture');
    result.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(setImmediate);
    while (!settled) {
        assert.ok(pending.size, 'Resolver stalled');
        await advance();
    }
    const elapsed = now;
    assert.equal(deadlines.size, 0, 'Resolver must clear every deadline timer');
    const identity = await result;
    while (pending.size) await advance();
    assert.deepEqual(unexpected, []);
    assert.deepEqual(requests.map(([url]) => url), routes.map(([url]) => url));
    for (const [, , accept, userAgent] of requests) {
        assert.equal(accept, 'application/json');
        assert.match(userAgent, /Chrome\/122\.0\.0\.0/);
    }
    return {
        output: JSON.parse(JSON.stringify(identity)),
        starts: requests.map(([, at]) => at),
        signals: requests.map(([, , , , signal]) => signal),
        jsonCalls,
        elapsed
    };
}

test('numeric TV ID overlaps three requests and preserves seasons and folded alias order', async () => {
    const result = await resolve([
        [tv + key + localized, 100, tvDetails],
        [tv + '/external_ids' + key, 70, { imdb_id: 'tt456' }],
        [tv + '/translations' + key, 40, translations('Golge Dizi', 'Diğer Ad', 'Diger Ad', 'TT456', 'Original Series')]
    ], 'tmdb:123:2:3', 'series');
    assert.deepEqual(result.output, tvIdentity);
    assert.deepEqual(result.starts, [0, 0, 0]);
    assert.equal(result.elapsed, 100);
});

test('IMDb movie waits for find, then overlaps four requests and preserves alias precedence and cap', async () => {
    const result = await resolve([
        [find, 30, { tv_results: [{ id: 123 }], movie_results: [{ id: 456, title: 'Find Title' }] }],
        [movie + key + localized, 100, { title: 'Film', original_title: 'Original Film', seasons }],
        [movie + '/external_ids' + key, 70, { imdb_id: 'tt123' }],
        [movie + '/translations' + key, 40, translations('Film', 'Çeviri', 'Ceviri', 'Original Film')],
        [movie + '/alternative_titles' + key + '&country=TR', 20, {
            titles: ['Ceviri', 'Alt A', 'Alt A', 'Alt B', 'Alt C', 'Alt D', 'Alt E', 'Alt F', 'Alt G'].map(title => ({ title }))
        }]
    ], 'imdb:tt123', 'movie');
    assert.deepEqual(result.output, {
        title: 'Film', origTitle: 'Original Film', numericId: '456', imdbId: 'tt123',
        aliases: ['tt123', 'Çeviri', 'Alt A', 'Alt B', 'Alt C', 'Alt D', 'Alt E', 'Alt F'],
        seasons: [], kind: 'imdb', type: 'movie', originalLanguage: '', originCountry: []
    });
    assert.deepEqual(result.starts, [0, 30, 30, 30, 30]);
    assert.equal(result.elapsed, 130);
});

test('raw title preserves best-match fallback when details fail and translations return HTTP 429', async () => {
    const result = await resolve([
        [search, 30, { results: [{ id: 999, name: 'Gölge' }, { id: 123, ...tvDetails }] }],
        [tv + key + localized, 100, new Error('Network failure')],
        [tv + '/external_ids' + key, 70, { imdb_id: 'tt456' }],
        [tv + '/translations' + key, 40, null]
    ], 'Gölge Dizi', 'tv');
    const { originalLanguage, originCountry, ...fallbackIdentity } = tvIdentity;
    assert.deepEqual(result.output, { ...fallbackIdentity, aliases: ['tt456'], seasons: [], kind: 'title' });
    assert.deepEqual(result.starts, [0, 30, 30, 30]);
    assert.equal(result.elapsed, 130);
});

test('movie alternatives survive invalid JSON from external IDs', async () => {
    const result = await resolve([
        [movie + key + localized, 100, { title: 'Film' }],
        [movie + '/external_ids' + key, 70, undefined],
        [movie + '/translations' + key, 40, translations('Çeviri')],
        [movie + '/alternative_titles' + key + '&country=TR', 20, { titles: [{ title: 'Alternatif' }] }]
    ], '456', 'movie');
    assert.deepEqual(result.output, {
        title: 'Film', origTitle: 'Film', numericId: '456', imdbId: '',
        aliases: ['Çeviri', 'Alternatif'], seasons: [], kind: 'tmdb', type: 'movie', originalLanguage: '', originCountry: []
    });
    assert.deepEqual(result.starts, [0, 0, 0, 0]);
    assert.equal(result.elapsed, 100);
});

const unresolvedImdb = {
    title: '', origTitle: '', numericId: '', imdbId: '', aliases: [], seasons: [], kind: 'imdb', type: 'tv'
};

test('IMDb lookup without a hit stops before requesting metadata', async () => {
    const result = await resolve([[find, 30, {}]], 'tt123', 'tv');
    assert.deepEqual(result.output, unresolvedImdb);
});

test('stalled fetch stops at eight seconds when the transport ignores cancellation', async () => {
    const result = await resolve([[find, Infinity, {}]], 'tt123', 'tv');
    assert.deepEqual(result.output, unresolvedImdb);
    assert.equal(result.elapsed, 8000);
    assert.equal(result.signals[0].aborted, true);
});

test('stalled JSON shares the fetch deadline', async () => {
    const result = await resolve([[find, 5000, {}, Infinity]], 'tt123', 'tv');
    assert.deepEqual(result.output, unresolvedImdb);
    assert.deepEqual(result.jsonCalls, [find]);
    assert.equal(result.elapsed, 8000);
    assert.equal(result.signals[0].aborted, true);
});

test('late fetch and late JSON results cannot extend or change a lookup', async () => {
    const hit = { tv_results: [{ id: 123, name: tvDetails.name }] };
    for (const [fetchDelay, jsonDelay, jsonCalls] of [[8100, 0, []], [5000, 3100, [find]]]) {
        const result = await resolve([[find, fetchDelay, hit, jsonDelay]], 'tt123', 'tv');
        assert.equal(result.elapsed, 8000);
        assert.deepEqual(result.output, unresolvedImdb);
        assert.deepEqual(result.jsonCalls, jsonCalls);
    }
});

test('one timed-out metadata request preserves successful parallel results', async () => {
    const result = await resolve([
        [tv + key + localized, 100, tvDetails],
        [tv + '/external_ids' + key, 5000, { imdb_id: 'tt456' }, Infinity],
        [tv + '/translations' + key, 40, translations('Diğer Ad')]
    ], '123', 'tv');
    assert.deepEqual(result.output, { ...tvIdentity, imdbId: '', aliases: ['Diğer Ad'] });
    assert.deepEqual(result.starts, [0, 0, 0]);
    assert.deepEqual(result.signals.map(signal => signal.aborted), [false, true, false]);
    assert.equal(result.elapsed, 8000);
});

test('lookup still enforces the deadline without AbortController', async () => {
    const result = await resolve([
        [tv + key + localized, 100, tvDetails],
        [tv + '/external_ids' + key, 70, { imdb_id: 'tt456' }],
        [tv + '/translations' + key, Infinity, translations('Diğer Ad')]
    ], '123', 'tv', { withAbortController: false });
    assert.deepEqual(result.output, { ...tvIdentity, aliases: ['tt456'] });
    assert.deepEqual(result.signals, [undefined, undefined, undefined]);
    assert.equal(result.elapsed, 8000);
});
