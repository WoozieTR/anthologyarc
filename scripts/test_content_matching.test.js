const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

function loadProvider(name, responseFor, mocks = {}) {
    const filename = path.resolve(__dirname, '../src', name, 'index.js');
    const requireFromProvider = createRequire(filename);
    const module = { exports: {} };
    const unexpected = [];
    runInNewContext(readFileSync(filename, 'utf8'), {
        module,
        AbortSignal,
        async fetch(input) {
            const url = new URL(input);
            const data = responseFor(url);
            if (data === undefined) {
                unexpected.push(url.origin + url.pathname);
                throw new Error('No fixture for ' + url.pathname);
            }
            return { ok: true, json: async () => data };
        },
        require(id) {
            if (id === '../shared/config.js') {
                return { loadConfig: async () => {}, val: () => {}, wrapAll: (exports) => exports };
            }
            return mocks[id] || requireFromProvider(id);
        }
    }, { filename });
    return async (...args) => {
        const streams = await module.exports.getStreams(...args);
        assert.deepEqual(unexpected, []);
        return Array.from(streams);
    };
}

function youtube(titles, metadata) {
    const contents = titles.map((title, index) => ({
        videoRenderer: {
            videoId: 'fixture-' + index,
            title: { simpleText: title },
            lengthText: { simpleText: '52:00' }
        }
    }));
    return loadProvider('youtube_dizifilm', (url) => {
        if (url.origin === 'https://www.youtube.com' && url.pathname === '/youtubei/v1/search') {
            return { contents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents } }] } } };
        }
    }, {
        '../shared/turkish_series.js': {
            normalizeSeriesId: (id) => ({ id }),
            resolveSeriesInfo: async () => metadata
        },
        '../shared/ytmp4.js': { resolveYouTubeMp4: async () => null }
    });
}

test('YouTube rejects episode markers belonging to other titles or episodes', async (t) => {
    for (const title of [
        'Yeraltı Dünyası 1. Bölüm',
        'Başka Dizi 1. Bölüm | Yeraltı',
        'Yeraltı 10. Bölüm'
    ]) {
        await t.test(title, async () => {
            const getStreams = youtube([title], { title: 'Yeraltı' });
            assert.deepEqual(await getStreams('901', 'series', 1, 1), []);
        });
    }
});

test('YouTube accepts the requested series before or after the episode marker', async () => {
    const getStreams = youtube([
        'NOW | Yeraltı - 1. Bölüm | Tek Parça',
        'Bölüm 1 - YERALTİ'
    ], { title: 'Yeraltı' });
    const streams = await getStreams('901', 'series', 1, 1);
    assert.deepEqual(streams.map((stream) => stream.ytId), ['fixture-0', 'fixture-1']);
});

test('YouTube retains matching cumulative episodes and rejects known spin-offs', async () => {
    const getStreams = youtube([
        'Kurtlar Vadisi Pusu 21. Bölüm',
        'Kurtlar Vadisi 21. Bölüm',
        'Kurtlar Vadisi 2. Sezon 1. Bölüm'
    ], { title: 'Kurtlar Vadisi', seasons: [{ season_number: 1, episode_count: 20 }] });
    const streams = await getStreams('902', 'tv', 2, 1);
    assert.deepEqual(streams.map((stream) => stream.ytId), ['fixture-1', 'fixture-2']);
});

test('YouTube matches film titles as an ordered phrase', async () => {
    const getStreams = youtube([
        'Sınıfı Geçen Hababam | Tek Parça',
        'Hababam Sınıfı | Tek Parça'
    ], { title: 'Hababam Sınıfı' });
    const streams = await getStreams('903', 'movie');
    assert.deepEqual(streams.map((stream) => stream.ytId), ['fixture-1']);
});

function anime(slug, name, type = 'series', fields = {}) {
    return { anime_link: slug, anime_name: name, anime_type: type, ...fields };
}

function sonanime({ titles = ['Yeraltı'], genres, results = [], type = 'tv', detailSlug }) {
    const field = type === 'tv' ? 'name' : 'title';
    const calls = [];
    const getStreams = loadProvider('sonanime', (url) => {
        calls.push(url.pathname);
        if (url.origin === 'https://api.themoviedb.org') {
            if (url.pathname === '/3/' + type + '/901') return { [field]: titles[0], genres };
            if (url.pathname === '/3/' + type + '/901/alternative_titles') {
                return { results: titles.slice(1).map((title) => ({ title })) };
            }
        }
        if (url.origin === 'https://api.sonanime.com') {
            if (url.pathname === '/api/anime/search') return results;
            if (url.pathname === '/api/anime/link/' + detailSlug) {
                return { episodes: [{ anime_season: 1, episode_number: 1, episode_link_1080: 'https://fixture.invalid/episode.mp4' }] };
            }
        }
    });
    return { calls, getStreams };
}

const animation = [{ id: 16, name: 'Animation' }];

test('SonAnime skips a title with known live-action metadata even for an exact name match', async () => {
    const { calls, getStreams } = sonanime({
        genres: [{ id: 18, name: 'Drama' }],
        results: [anime('same-name', 'Yeraltı')],
        detailSlug: 'same-name'
    });
    assert.deepEqual(await getStreams('901', 'series', 1, 1), []);
    assert.ok(calls.every((route) => !route.startsWith('/api/anime/')));
});

test('SonAnime rejects unrelated, blank and partial titles without a matching ID', async (t) => {
    for (const name of ['Başka Anime', '', 'Yeraltı Dünyası']) {
        await t.test(JSON.stringify(name), async () => {
            const { calls, getStreams } = sonanime({
                genres: animation, results: [anime('wrong-title', name)], detailSlug: 'wrong-title'
            });
            assert.deepEqual(await getStreams('901', 'tv', 1, 1), []);
            assert.ok(calls.includes('/api/anime/search'));
            assert.ok(!calls.includes('/api/anime/link/wrong-title'));
        });
    }
});

test('SonAnime filters movie and series candidates before looking at their IDs or names', async (t) => {
    for (const [type, candidateType] of [['tv', 'movie'], ['movie', 'series']]) {
        for (const fields of [{}, { tmdb_id: 901 }]) {
            await t.test(type + (fields.tmdb_id ? ' with same numeric ID' : ' with same title'), async () => {
                const { getStreams } = sonanime({
                    type, genres: animation,
                    results: [anime('wrong-type', 'Yeraltı', candidateType, fields)],
                    detailSlug: 'wrong-type'
                });
                assert.deepEqual(await getStreams('901', type, 1, 1), []);
            });
        }
    }
});

test('SonAnime retains exact aliases without genre metadata and typed IDs for anime films', async () => {
    const series = sonanime({
        titles: ['First Title', 'Çizgi Dizi'],
        results: [anime('alias', '', 'series', { anime_name_en: 'Cizgi Dizi' })],
        detailSlug: 'alias'
    });
    assert.equal((await series.getStreams({ id: '901', type: 'series' })).length, 1);

    const movie = sonanime({
        type: 'movie', genres: animation,
        results: [anime('anime-film', 'Different Translation', 'movie', { tmdb_id: '901' })],
        detailSlug: 'anime-film'
    });
    assert.equal((await movie.getStreams('901', 'movie')).length, 1);
});

test('SonAnime retains direct episode IDs without looking up metadata', async () => {
    const { calls, getStreams } = sonanime({ detailSlug: 'anime-episode' });
    assert.equal((await getStreams('sonanime:ep:anime-episode:1:1', 'series')).length, 1);
    assert.deepEqual(calls, ['/api/anime/link/anime-episode']);
});
