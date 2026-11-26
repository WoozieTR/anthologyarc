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
const video = 'https://media.fixture.invalid/360p.mp4?token=fixture';
const videoId = 'fixture0001';
const otherVideoId = 'fixture0002';
const card = (href, title) => `<a href="${href.slice(1)}"><h2>${title}</h2></a>`;
const row = (href, number, title) => `<a data-navigo class="truncate" href="${href}">Bölüm <data>${number}</data></a><h6><a itemprop="name">${title}</a></h6>`;

function fixture({ cards, listing, href, candidates, playerUrl = video, streamingData = { formats: [{ url: video, mimeType: 'video/mp4', qualityLabel: '360p' }] }, title = 'Yeraltı', aliases, seasons = [{ season_number: 1, episode_count: 16 }] } = {}) {
    const module = { exports: {} };
    const requests = [];
    const diagnostics = [];
    const context = {
        module, AbortController, URL, URLSearchParams, setTimeout, clearTimeout,
        console: { log: message => diagnostics.push(message) },
        require(id) {
            if (id === '../shared/http_request.js' || id === './http_deadline.js') {
                const helper = path.resolve(__dirname, '../src/shared', path.basename(id));
                const module = { exports: {} };
                runInNewContext(readFileSync(helper, 'utf8'), {
                    ...context, module, require: child => {
                        if (child === './http_deadline.js') return context.require(child);
                        throw new Error('Unexpected native module');
                    }
                }, { filename: helper });
                return module.exports;
            }
            if (id === '../shared/config.js') {
                return { loadConfig: async () => {}, val: () => base, wrapAll: exports => exports };
            }
            if (id === '../shared/turkish_series.js') {
                return {
                    ...requireFromProvider(id),
                    resolveSeriesInfo: async () => ({ title, aliases, seasons })
                };
            }
            return requireFromProvider(id);
        },
        async fetch(input, options) {
            const url = new URL(input);
            requests.push(url.pathname);
            if (url.origin === base) {
                if (url.pathname === '/search') {
                    const data = typeof cards === 'function'
                        ? cards(url.searchParams.get('qr'))
                        : cards || (listing && card(show, 'Yeraltı'));
                    return { ok: true, json: async () => ({ data }) };
                }
                if (url.pathname === player) return { ok: true, text: async () => `file: "${playerUrl}"` };
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
                        streamingData
                    }) };
                }
            }
            return { ok: false };
        }
    };
    runInNewContext(readFileSync(filename, 'utf8'), context, { filename });
    return {
        getStreams: (season = 2, episode = 7, id = '901') => module.exports.getStreams(id, 'tv', season, episode),
        getDirectStreams: slug => module.exports.getStreams('tvdiziler:ep:' + slug),
        requests,
        diagnostics
    };
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

test('TvDiziler normalizes HTML entities before exact series matching', async () => {
    const href = '/isik-sokagi-23-bolum';
    const matchingShow = '/dizi/isik-sokagi-son-bolum-izle';
    const wrongShow = '/dizi/isik-sokagi-dunyasi';
    const wrongCard = card(wrongShow, '&#304;&#351;&#305;k&nbsp;Soka&#287;&#305;&nbsp;Dünyası');
    const listing = row(href, 23, '23. Bölüm');

    for (const encodedTitle of [
        '&#304;&#351;&#305;k&#160;Soka&#287;&#305; (2026)',
        '&#x130;&#x15F;&#X131;k&#x20;Soka&#x11F;&#x131;&nbsp;&#40;2026&#41;&nbsp;',
        'Işık&nbsp;Sokağı&nbsp;(2026)',
        'Işık\u00a0Sokağı\u00a0(2026)\u00a0'
    ]) {
        const f = fixture({
            cards: wrongCard + card(matchingShow, encodedTitle), listing, href, title: 'Işık Sokağı'
        });
        assert.equal((await f.getStreams())[0]?.url, video, encodedTitle);
        assert.ok(f.requests.includes(matchingShow));
        assert.ok(!f.requests.includes(wrongShow));
    }

    for (const suffix of [' Dünyası', '&#x110000;', '&#xD800;', '&#999999999999999999999;']) {
        const f = fixture({
            cards: card(wrongShow, 'Işık&nbsp;Sokağı' + suffix), listing, href, title: 'Işık Sokağı'
        });
        assert.equal((await f.getStreams()).length, 0, suffix);
        assert.ok(!f.requests.includes(wrongShow));
        assert.ok(f.diagnostics.includes(
            '[TvDiziler] series_match {"accepted":0,"rejected":1,"title_mismatch":1,"missing_slug":0}'
        ));
    }
});

test('TvDiziler strips a standalone watch suffix around the year in candidate metadata', async () => {
    const href = '/yeralti-23-bolum';
    const listing = row(href, 23, '23. Bölüm');

    for (const title of ['Yeraltı izle', 'Yeraltı (2026) izle', 'Yeraltı&nbsp;İZLE&nbsp;(2026)']) {
        const f = fixture({ cards: card(show, title), listing, href });
        assert.equal((await f.getStreams())[0]?.url, video, title);
        assert.ok(f.requests.includes(show));
    }
});

test('TvDiziler rejects unrelated titles and keeps non-suffix uses of izle distinct', async () => {
    const href = '/yeralti-23-bolum';
    const listing = row(href, 23, '23. Bölüm');

    for (const title of ['Yeraltı Dünyası izle', 'Yeraltıizle', 'Yeraltı izle Dünyası', 'Yeraltı izle izle']) {
        const f = fixture({ cards: card(show, title), listing, href });
        assert.equal((await f.getStreams()).length, 0, title);
        assert.ok(!f.requests.includes(show));
        assert.ok(f.diagnostics.includes(
            '[TvDiziler] series_match {"accepted":0,"rejected":1,"title_mismatch":1,"missing_slug":0}'
        ));
    }
});

test('TvDiziler prefers exact titles and preserves genuine titles ending in izle', async () => {
    const collision = '/dizi/yeralti-izle';
    const href = '/yeralti-23-bolum';
    const listing = row(href, 23, '23. Bölüm');
    const cards = card(collision, 'Yeraltı izle (2025)') + card(show, 'Yeraltı (2026)');
    const f = fixture({ cards, listing, href });
    assert.equal((await f.getStreams())[0]?.url, video);
    assert.ok(f.requests.includes(show));
    assert.ok(!f.requests.includes(collision));

    const genuineHref = '/yeralti-izle-23-bolum';
    const genuine = fixture({
        cards, listing: row(genuineHref, 23, '23. Bölüm'), href: genuineHref, title: 'Yeraltı İzle'
    });
    assert.equal((await genuine.getStreams())[0]?.url, video);
    assert.ok(genuine.requests.includes(collision));
    assert.ok(!genuine.requests.includes(show));
});

test('TvDiziler does not reuse a suffix match when the next title search has no matches', async () => {
    const queries = [];
    const f = fixture({
        aliases: ['Gizli Sokak'],
        cards(query) {
            queries.push(query);
            return query === 'Yeraltı' ? card(show, 'Yeraltı izle') : '';
        },
        listing: row('/yeralti-24-bolum', 24, '24. Bölüm')
    });

    assert.equal((await f.getStreams()).length, 0);
    assert.deepEqual(queries, ['Yeraltı', 'Gizli Sokak']);
    assert.equal(f.requests.filter(request => request === show).length, 1);
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

test('TvDiziler reports fixed series and episode decisions and the successful origin', async () => {
    const href = '/yeralti-2-sezon-7-bolum';
    const f = fixture({
        cards: card('/dizi/private-series', 'Başka Dizi') + card(show, 'Yeraltı'),
        listing: row('/private-link?token=fixture', 7, 'Private response') +
            row('/other-23-bolum', 23, '23. Bölüm') +
            row('/yeralti-24-bolum', 24, '24. Bölüm') +
            row(href, 7, '2. Sezon 7. Bölüm') +
            row('/uninspected-23-bolum', 23, '23. Bölüm'),
        href
    });

    assert.equal((await f.getStreams())[0]?.url, video);
    assert.deepEqual(f.diagnostics, [
        '[TvDiziler] series_match {"accepted":1,"rejected":1,"title_mismatch":1,"missing_slug":0}',
        '[TvDiziler] episode_match {"origin":"episode_list","accepted":1,"rejected":3,"invalid_link":1,"series_mismatch":1,"number_mismatch":1}',
        '[TvDiziler] result {"origin":"episode_list","count":1}'
    ]);
});

test('TvDiziler reports fallback decisions and empty results without response data', async () => {
    const empty = fixture();
    assert.equal((await empty.getStreams()).length, 0);
    assert.equal(empty.diagnostics.at(-1), '[TvDiziler] empty_result {"reason":"no_streams"}');

    const fallback = fixture({
        candidates: { [otherVideoId]: 'Private response', [videoId]: 'Yeraltı 2. Sezon 7. Bölüm' }
    });
    assert.equal((await fallback.getStreams()).length, 2);
    assert.deepEqual(fallback.diagnostics.slice(-2), [
        '[TvDiziler] episode_match {"origin":"youtube_fallback","accepted":1,"rejected":1,"duration":0,"title_mismatch":1}',
        '[TvDiziler] result {"origin":"youtube_fallback","count":2}'
    ]);
});

test('TvDiziler reports direct episode results without identifying the episode', async () => {
    const href = '/private-episode';
    const f = fixture({ href });

    assert.equal((await f.getDirectStreams(href))[0]?.url, video);
    assert.equal((await f.getDirectStreams('/missing-private-episode')).length, 0);
    assert.deepEqual(f.diagnostics, [
        '[TvDiziler] result {"origin":"direct_episode","count":1}',
        '[TvDiziler] empty_result {"reason":"direct_episode_empty"}'
    ]);
});


test('TvDiziler labels direct streams only when the path provides a resolution', async () => {
    const episode = '/yeralti-23-bolum';
    for (const [path, quality] of [
        ['/episode.mp4', ''],
        ['/episode.mp4?token=720-480-360&itag=22', ''],
        ['/episode1720480.mp4', ''],
        ['/720/episode.mp4', ''],
        ['/episode-1080.mp4', ''],
        ['/720p/episode-1080.mp4', '720p'],
        ['/720p/episode-1280x720.mp4', '720p'],
        ['/720p-1080p/episode.mp4', ''],
        ['/1280x720/episode.mp4?token=480', '720p']
    ]) {
        const url = 'https://media.fixture.invalid' + path;
        const f = fixture({ listing: row(episode, 23, '23. Bölüm'), href: episode, playerUrl: url });
        const [stream] = await f.getStreams();
        assert.equal(stream?.url, url);
        assert.equal(stream.quality, quality, path);
        assert.equal(stream.title.includes('720p'), quality === '720p', path);
        assert.doesNotMatch(stream.title, /(?:1080|480|360)p/);
    }
});

test('TvDiziler uses explicit YouTube format labels and leaves unlabeled results without a resolution', async () => {
    const hlsManifestUrl = 'https://media.fixture.invalid/master.m3u8';
    for (const qualityLabel of [undefined, '480p']) {
        const streamingData = {
            hlsManifestUrl,
            formats: [{ url: video, mimeType: 'video/mp4', qualityLabel }]
        };
        const f = fixture({ candidates: { [videoId]: 'Yeraltı 23. Bölüm' }, streamingData });
        const streams = await f.getStreams();
        const hls = streams.find(stream => stream.url === hlsManifestUrl);
        const mp4 = streams.find(stream => stream.url === video);
        assert.equal(hls?.quality, '');
        assert.equal(mp4?.quality, qualityLabel || '');
        assert.equal(mp4.title.includes('480p'), !!qualityLabel);
        assert.doesNotMatch(mp4.title, /(?:1080|720|360)p/);
        assert.ok(streams.some(stream => stream.ytId === videoId));
        assert.equal(f.requests.filter(request => request === '/youtubei/v1/player').length, 1);
    }
});
