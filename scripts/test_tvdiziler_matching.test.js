const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const filename = path.resolve(__dirname, '../src/tvdiziler/index.js');
const requireFromProvider = createRequire(filename);
const base = 'https://tvdiziler.fixture.invalid';
const show = '/dizi/yeralti-son-bolum-izle';
const player = '/vid/ply/fixture';
const video = 'https://media.fixture.invalid/360.mp4?token=fixture';
const videoId = 'fixture0001';
const otherVideoId = 'fixture0002';
const card = (href, title) => `<a href="${href.slice(1)}"><h2>${title}</h2></a>`;
const row = (href, number, title) => `<a data-navigo class="truncate" href="${href}">Bölüm <data>${number}</data></a><h6><a itemprop="name">${title}</a></h6>`;

function fixture({ cards, listing, href, candidates, seasons = [{ season_number: 1, episode_count: 16 }] } = {}) {
    const module = { exports: {} };
    const requests = [];
    runInNewContext(readFileSync(filename, 'utf8'), {
        module, AbortSignal, URL, URLSearchParams,
        require(id) {
            if (id === '../shared/config.js') {
                return { loadConfig: async () => {}, val: () => base, wrapAll: exports => exports };
            }
            if (id === '../shared/turkish_series.js') {
                return {
                    ...requireFromProvider(id),
                    resolveSeriesInfo: async () => ({ title: 'Yeraltı', seasons })
                };
            }
            return requireFromProvider(id);
        },
        async fetch(input, options) {
            const url = new URL(input);
            requests.push(url.pathname);
            if (url.origin === base) {
                if (url.pathname === '/search') {
                    return { ok: true, json: async () => ({ data: cards || (listing && card(show, 'Yeraltı')) }) };
                }
                if (url.pathname === player) return { ok: true, text: async () => `file: "${video}"` };
                if (url.pathname === href) {
                    return { ok: true, text: async () => `<button data-hhs="${player}">Tek Parça</button>` };
                }
                if (url.pathname.startsWith('/dizi/') && listing) return { ok: true, text: async () => listing };
            }
            if (url.origin === 'https://www.youtube.com' && candidates) {
                if (url.pathname === '/results') {
                    return { ok: true, text: async () => JSON.stringify(Object.keys(candidates).map(videoId => ({ videoId }))) };
                }
                if (url.pathname === '/youtubei/v1/player') {
                    const title = candidates[JSON.parse(options.body).videoId];
                    return { ok: true, json: async () => ({
                        videoDetails: { lengthSeconds: '3600', title },
                        streamingData: { formats: [{ url: video, mimeType: 'video/mp4', qualityLabel: '360p' }] }
                    }) };
                }
            }
            return { ok: false };
        }
    }, { filename });
    return { getStreams: (season = 2, episode = 7) => module.exports.getStreams('901', 'tv', season, episode), requests };
}

test('TvDiziler skips similar and unrelated series search results', async () => {
    const href = '/yeralti-dunyasi-23-bolum';
    for (const [slug, title] of [['yeralti-dunyasi', 'Yeraltı Dünyası'], ['baska-dizi', 'Başka Dizi']]) {
        const wrongShow = '/dizi/' + slug;
        const f = fixture({ cards: card(wrongShow, title), listing: row(href, 23, '23. Bölüm'), href });
        assert.equal((await f.getStreams()).length, 0, title);
        assert.ok(!f.requests.includes(wrongShow));
    }
});

test('TvDiziler verifies episode identity against every numbering source', async (t) => {
    for (const [slug, number, title, accepted] of [
        ['baska-dizi-23-bolum', 23, '23. Bölüm', false],
        ['yeralti-24-bolum', 23, '23. Bölüm', false],
        ['yeralti-23-bolum', 24, '23. Bölüm', false],
        ['yeralti-23-bolum', 23, 'Bölüm 24', false],
        ['yeralti-23-bolum', 23, '7. Bölüm', false],
        ['yeralti-1-sezon-7-bolum', 7, '2. Sezon 7. Bölüm', false],
        ['yeralti-23-bolum', 23, '1. Sezon 23. Bölüm', false],
        ['yeralti-23-bolum', 23, '23. Bölüm | Sezon 1', false],
        ['yeralti-7-bolum', 7, '7. Bölüm', false],
        ['yeralti-23-bolum', 23, '23. Bölüm', true],
        ['yeralti-23-bolum', 23, '2. Sezon 7. Bölüm', true],
        ['yeralti-2-sezon-7-bolum', 23, '23. Bölüm', true],
        ['yeralti-sezon-2-bolum-7', 7, '7. Bölüm', true]
    ]) {
        await t.test(slug + ' / ' + number + ' / ' + title, async () => {
            const href = '/' + slug;
            const f = fixture({ cards: card(show, 'YERALTI (2026)'), listing: row(href, number, title), href });
            const [stream] = await f.getStreams();
            assert.equal(stream?.url, accepted ? video : undefined);
            assert.equal(f.requests.includes(href), accepted);
            if (accepted) assert.equal(stream.quality, '360p');
        });
    }
});

test('TvDiziler checks fallback links and keeps valid cumulative links', async () => {
    const href = '/yeralti-23-bolum';
    const f = fixture({
        listing: '<a href="/baska-dizi-23-bolum">23. Bölüm</a><a href="' + href + '">Bölüm 23</a>',
        href
    });
    assert.equal((await f.getStreams())[0]?.url, video);
    assert.ok(!f.requests.includes('/baska-dizi-23-bolum'));
});

test('TvDiziler requires every previous season count for unlabeled matches', async () => {
    const seasons = [{ season_number: 1, episode_count: 16 }, { season_number: 2 }];
    for (const [season, number, counts] of [[2, 7, []], [3, 23, seasons]]) {
        const href = '/yeralti-' + number + '-bolum';
        const f = fixture({
            listing: row(href, number, number + '. Bölüm'), href, seasons: counts,
            candidates: { [videoId]: 'Yeraltı ' + number + '. Bölüm' }
        });
        assert.equal((await f.getStreams(season)).length, 0);
        assert.ok(!f.requests.includes(href));
    }

    const href = '/yeralti-3-sezon-7-bolum';
    const f = fixture({ listing: row(href, 7, '3. Sezon 7. Bölüm'), href, seasons });
    assert.equal((await f.getStreams(3))[0]?.url, video);
    const yt = fixture({ seasons, candidates: { [videoId]: 'Yeraltı 3. Sezon 7. Bölüm' } });
    assert.ok((await yt.getStreams(3)).some(stream => stream.ytId === videoId));
});

test('TvDiziler rejects long YouTube videos with unrelated or conflicting titles', async () => {
    for (const title of [
        'Başka Dizi 23. Bölüm | Yeraltı', 'Yeraltı Dünyası 23. Bölüm', 'Yeraltı 1. Sezon 7. Bölüm',
        'Yeraltı 24. Bölüm', 'Yeraltı 7. Bölüm', 'Yeraltı 23. Bölüm | Sezon 1', 'Yeraltı 23. Bölüm | 24. Bölüm', ''
    ]) {
        const f = fixture({ candidates: { [videoId]: title } });
        assert.equal((await f.getStreams()).length, 0, title);
    }
});

test('TvDiziler skips wrong YouTube results and keeps existing quality and native playback', async () => {
    for (const [title, season, episode] of [
        ['NOW | Yeraltı - 23. Bölüm | Tek Parça', 2, 7],
        ['Yeraltı 2. Sezon 7. Bölüm', 2, 7],
        ['Yeraltı 2. Sezon 23. Bölüm', 2, 7],
        ['Yeraltı Sezon 2, Bölüm 7', 2, 7],
        ['Bölüm 1 - YERALTİ', 1, 1]
    ]) {
        const f = fixture({ candidates: { [otherVideoId]: 'Başka Dizi 23. Bölüm', [videoId]: title } });
        const streams = await f.getStreams(season, episode);
        assert.ok(streams.some(stream => stream.url === video && stream.quality === '360p'), title);
        assert.deepEqual(Array.from(streams.filter(stream => stream.ytId), stream => stream.ytId), [videoId]);
    }
});
