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
const tvDetails = { name: 'Gölge Dizi', original_name: 'Original Series', seasons };
const tvIdentity = {
    title: 'Gölge Dizi', origTitle: 'Original Series', numericId: '123', imdbId: 'tt456',
    aliases: ['tt456', 'Diğer Ad'], seasons, kind: 'tmdb', type: 'tv'
};

function translations(...names) {
    return { translations: names.map(name => ({ data: { name } })) };
}

async function resolve(routes, rawId, type) {
    let now = 0;
    const requests = [];
    const pending = [];
    const unexpected = [];
    const module = { exports: {} };
    runInNewContext(source, {
        module,
        async fetch(url, { headers }) {
            const route = routes.find(([expected]) => expected === url);
            requests.push([url, now, headers.Accept, headers['User-Agent']]);
            if (!route) {
                unexpected.push(url);
                throw new Error('Unexpected request: ' + url);
            }
            const [, delay, data] = route;
            await new Promise(done => pending.push({ at: now + delay, done }));
            if (data instanceof Error) throw data;
            if (data === null) return { ok: false, status: 429 };
            return {
                ok: true,
                json() {
                    if (data === undefined) throw new SyntaxError('Invalid JSON');
                    return data;
                }
            };
        }
    });

    let settled = false;
    const result = module.exports.resolveSeriesInfo(rawId, type, 'fixture');
    result.then(() => { settled = true; }, () => { settled = true; });
    while (!settled) {
        await new Promise(setImmediate);
        if (settled) break;
        assert.ok(pending.length, 'Resolver stalled');
        pending.sort((a, b) => a.at - b.at);
        now = pending[0].at;
        while (pending[0]?.at === now) pending.shift().done();
    }
    assert.deepEqual(unexpected, []);
    assert.deepEqual(requests.map(([url]) => url), routes.map(([url]) => url));
    for (const [, , accept, userAgent] of requests) {
        assert.equal(accept, 'application/json');
        assert.match(userAgent, /Chrome\/122\.0\.0\.0/);
    }
    return { output: JSON.parse(JSON.stringify(await result)), starts: requests.map(([, at]) => at), elapsed: now };
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
        seasons: [], kind: 'imdb', type: 'movie'
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
    assert.deepEqual(result.output, { ...tvIdentity, aliases: ['tt456'], seasons: [], kind: 'title' });
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
        aliases: ['Çeviri', 'Alternatif'], seasons: [], kind: 'tmdb', type: 'movie'
    });
    assert.deepEqual(result.starts, [0, 0, 0, 0]);
    assert.equal(result.elapsed, 100);
});

test('IMDb lookup without a hit stops before requesting metadata', async () => {
    const result = await resolve([[find, 30, {}]], 'tt123', 'tv');
    assert.deepEqual(result.output, {
        title: '', origTitle: '', numericId: '', imdbId: '', aliases: [], seasons: [], kind: 'imdb', type: 'tv'
    });
});
