const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const filename = path.resolve(__dirname, '../src/ddizi/index.js');
const requireFromProvider = createRequire(filename);
const base = 'https://ddizi.fixture.invalid';
const show = '/diziler/123/yeralti';
const videoId = 'fixture0001';
const otherVideoId = 'fixture0002';
const video = 'https://media.fixture.invalid/360p.mp4?token=fixture';
const anchor = (href, title) => `<a href="${href}">${title}</a>`;

function fixture(routes, player, seasons = [{ season_number: 1, episode_count: 16 }], streamingData = { formats: [{ url: video, mimeType: 'video/mp4', qualityLabel: '360p' }] }) {
    const candidates = typeof player === 'string' ? { [videoId]: player } : player;
    const module = { exports: {} };
    const requests = [];
    const origins = [];
    runInNewContext(readFileSync(filename, 'utf8'), {
        module, AbortSignal, URL, URLSearchParams,
        console: { log: (...args) => origins.push(args.join(' ')) },
        require(id) {
            if (id === '../shared/config.js') {
                return {
                    loadConfig: async () => {},
                    val: () => base,
                    wrapAll: (exports, ready) => ({
                        getMeta: async (...args) => { await ready(); return exports.getMeta(...args); }
                    })
                };
            }
            if (id === '../shared/turkish_series.js') {
                return {
                    ...requireFromProvider(id),
                    resolveSeriesInfo: async () => ({
                        title: 'Yeraltı', seasons
                    })
                };
            }
            return requireFromProvider(id);
        },
        async fetch(input, options) {
            const url = new URL(input);
            requests.push(url.pathname);
            if (url.origin === base && Object.hasOwn(routes, url.pathname)) {
                return { ok: true, text: async () => routes[url.pathname] };
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
    }, { filename });
    return {
        getStreams: (season = 2, episode = 7) => module.exports.getStreams('901', 'tv', season, episode),
        getMeta: () => module.exports.getMeta('ddizi:show:123/yeralti'),
        requests,
        origins
    };
}

function episodePage(routes, episodePath) {
    routes[episodePath] = '<iframe src="/player/oynat/fixture"></iframe>';
    routes['/player/oynat/fixture'] = `file: "${video}"`;
    return routes;
}

test('DDizi rejects a similarly named series and an empty search-result label', async (t) => {
    for (const label of ['Yeraltı Dünyası', '<img src="fixture.png">']) {
        await t.test(label, async () => {
            const unrelatedShow = '/diziler/456/yeralti-dunyasi';
            const unrelatedEpisode = '/izle/456/yeralti-dunyasi-23-bolum';
            const f = fixture(episodePage({
                '/arama/': anchor(unrelatedShow, label),
                [unrelatedShow]: anchor(unrelatedEpisode, 'Yeraltı Dünyası 23. Bölüm')
            }, unrelatedEpisode));
            assert.equal((await f.getStreams()).length, 0);
            assert.ok(!f.requests.includes(unrelatedShow));
        });
    }
});

test('DDizi verifies the series, episode and season in episode links', async (t) => {
    for (const [slug, label, episodeNum] of [
        ['baska-dizi-23-bolum', '23. Bölüm'],
        ['baska-dizi-23-bolum', 'Yeraltı 23. Bölüm'],
        ['yeralti-24-bolum', '23. Bölüm'],
        ['yeralti-1-sezon-7-bolum', 'Yeraltı 1. Sezon 7. Bölüm'],
        ['yeralti-7-bolum', '7. Bölüm'],
        ['yeralti-23-bolum', 'Yeraltı 1. Sezon 23. Bölüm'],
        ['baska-dizi-22-bolum', '22. Bölüm', 6]
    ]) {
        await t.test(`${slug} / ${label}`, async () => {
            const episode = '/izle/456/' + slug;
            const f = fixture(episodePage({
                '/arama/': anchor(show, 'Yeraltı'),
                [show]: anchor(episode, label)
            }, episode));
            assert.equal((await f.getStreams(2, episodeNum)).length, 0);
            assert.ok(!f.requests.includes(episode));
        });
    }
});

test('DDizi accepts exact titles, image-only series slugs, and labeled or cumulative episodes', async (t) => {
    for (const [label, slug, episodeNum] of [
        ['YERALTI', 'yeralti-23-bolum'],
        ['<img src="fixture.png">', 'yeralti-2-sezon-7-bolum'],
        ['Yeraltı', 'yeralti-sezon-2-bolum-7'],
        ['Yeraltı', 'yeralti-2-sezon-23-bolum'],
        ['Yeraltı', 'yeralti-22-bolum', 6]
    ]) {
        await t.test(slug, async () => {
            const episode = '/izle/123/' + slug;
            const f = fixture(episodePage({
                '/arama/': anchor(show, label),
                [show]: anchor('/izle/456/baska-dizi-23-bolum', '23. Bölüm')
                    + anchor(episode, 'Bölümü izle')
            }, episode));
            const [stream] = await f.getStreams(2, episodeNum);
            assert.equal(stream?.url, video);
            assert.equal(stream.quality, '360p');
            assert.deepEqual(f.origins, ['[DDizi] result origin=episode-direct']);
        });
    }
});

test('DDizi show metadata excludes unrelated episode links', async () => {
    const f = fixture({
        [show]: '<h1>Yeraltı</h1>'
            + anchor('/izle/456/yeralti-dunyasi-23-bolum', 'Yeraltı Dünyası 23. Bölüm')
            + anchor('/izle/123/yeralti-23-bolum', '23. Bölüm')
    });
    const { meta } = await f.getMeta();
    assert.deepEqual(Array.from(meta.videos, (entry) => entry.id), ['ddizi:ep:123/yeralti-23-bolum']);
});

test('DDizi YouTube search rejects long videos with unrelated or conflicting titles', async (t) => {
    for (const title of [
        'Başka Dizi 23. Bölüm | Yeraltı',
        'Yeraltı Dünyası 23. Bölüm',
        'Yeraltı 1. Sezon 7. Bölüm',
        'Yeraltı 24. Bölüm',
        'Yeraltı 7. Bölüm',
        ''
    ]) {
        await t.test(title || 'missing title', async () => {
            const f = fixture({}, title);
            assert.equal((await f.getStreams()).length, 0);
            assert.deepEqual(f.origins, []);
        });
    }
});

test('DDizi YouTube search returns matching episodes with existing quality and native playback', async (t) => {
    for (const [title, season, episode] of [
        ['NOW | Yeraltı - 23. Bölüm | Tek Parça', 2, 7],
        ['Yeraltı 2. Sezon 7. Bölüm', 2, 7],
        ['Yeraltı 2. Sezon 23. Bölüm', 2, 7],
        ['Bölüm 1 - YERALTİ', 1, 1]
    ]) {
        await t.test(title, async () => {
            const f = fixture({}, title);
            const streams = await f.getStreams(season, episode);
            assert.ok(streams.some((stream) => stream.url === video && stream.quality === '360p'));
            assert.ok(streams.some((stream) => stream.ytId === videoId));
            assert.deepEqual(f.origins, ['[DDizi] result origin=youtube-search']);
        });
    }
});

test('DDizi YouTube search skips an unrelated 360p candidate before a matching result', async () => {
    const f = fixture({}, {
        [otherVideoId]: 'Başka Dizi 23. Bölüm',
        [videoId]: 'Yeraltı 23. Bölüm'
    });
    const streams = await f.getStreams();
    assert.deepEqual(Array.from(streams.filter(stream => stream.ytId), stream => stream.ytId), [videoId]);
});

test('DDizi uses an explicit season on the anchor when the same series link has local numbering', async () => {
    const episode = '/izle/123/yeralti-7-bolum';
    const f = fixture(episodePage({
        '/arama/': anchor(show, 'Yeraltı'),
        [show]: anchor(episode, 'Yeraltı 2. Sezon 7. Bölüm')
    }, episode));
    assert.equal((await f.getStreams())[0]?.url, video);
});

test('DDizi requires complete previous season counts for unlabeled matches', async () => {
    for (const [seasons, season, number] of [
        [[], 2, 7],
        [[{ season_number: 1, episode_count: 16 }], 3, 23],
        [[{ season_number: 1, episode_count: 16 }, { season_number: 2 }], 3, 23]
    ]) {
        const episode = '/izle/123/yeralti-' + number + '-bolum';
        const routes = episodePage({
            '/arama/': anchor(show, 'Yeraltı'),
            [show]: anchor(episode, number + '. Bölüm')
        }, episode);
        const f = fixture(routes, 'Yeraltı ' + number + '. Bölüm', seasons);
        assert.equal((await f.getStreams(season, 7)).length, 0);
        assert.ok(!f.requests.includes(episode));

        const explicit = fixture({}, 'Yeraltı ' + season + '. Sezon 7. Bölüm', seasons);
        assert.ok((await explicit.getStreams(season, 7)).some(stream => stream.ytId === videoId));

        const explicitPath = '/izle/123/yeralti-' + season + '-sezon-7-bolum';
        const matching = fixture(episodePage({
            '/arama/': anchor(show, 'Yeraltı'),
            [show]: anchor(explicitPath, '7. Bölüm')
        }, explicitPath), undefined, seasons);
        assert.equal((await matching.getStreams(season, 7))[0]?.url, video);
    }
});

test('DDizi compares visible episode numbers with the episode link', async () => {
    for (const [slug, label, accepted] of [
        ['yeralti-23-bolum', '24. Bölüm', false],
        ['yeralti-23-bolum', 'Bölüm 24', false],
        ['yeralti-23-bolum', '7. Bölüm', false],
        ['yeralti-23-bolum', '2. Sezon 7. Bölüm', true],
        ['yeralti-2-sezon-7-bolum', '23. Bölüm', true]
    ]) {
        const episode = '/izle/123/' + slug;
        const f = fixture(episodePage({
            '/arama/': anchor(show, 'Yeraltı'),
            [show]: anchor(episode, label)
        }, episode));
        assert.equal((await f.getStreams())[0]?.url, accepted ? video : undefined, label);
        assert.equal(f.requests.includes(episode), accepted);
    }
});


test('DDizi labels direct streams only when the path provides a resolution', async () => {
    const episode = '/izle/123/yeralti-23-bolum';
    for (const [path, quality] of [
        ['/episode.mp4', ''],
        ['/episode.mp4?token=720-480-360&itag=22', ''],
        ['/episode1720480.mp4', ''],
        ['/720/episode.mp4', '720p'],
        ['/episode-1080.mp4', '1080p'],
        ['/1080/episode.mp4', '1080p'],
        ['/episode_720.mp4', '720p'],
        ['/720/episode-1080.mp4', ''],
        ['/episode1080.mp4', ''],
        ['/episode-1080.txt', ''],
        ['/720p/episode-1080.mp4', '720p'],
        ['/720p/episode-1280x720.mp4', '720p'],
        ['/720p-1080p/episode.mp4', ''],
        ['/1280x720/episode.mp4?token=480', '720p']
    ]) {
        const url = 'https://media.fixture.invalid' + path;
        const routes = episodePage({
            '/arama/': anchor(show, 'Yeraltı'),
            [show]: anchor(episode, '23. Bölüm')
        }, episode);
        routes['/player/oynat/fixture'] = `file: "${url}"`;
        const f = fixture(routes);
        const [stream] = await f.getStreams();
        assert.equal(stream?.url, url);
        assert.equal(stream.quality, quality, path);
        assert.equal(stream.title.includes('720p'), quality === '720p', path);
        assert.equal(stream.title.includes('1080p'), quality === '1080p', path);
        assert.doesNotMatch(stream.title, /(?:480|360)p/);
    }
});

test('DDizi uses explicit YouTube format labels and leaves unlabeled results without a resolution', async () => {
    const hlsManifestUrl = 'https://media.fixture.invalid/master.m3u8';
    for (const qualityLabel of [undefined, '480p']) {
        const streamingData = {
            hlsManifestUrl,
            formats: [{ url: video, mimeType: 'video/mp4', qualityLabel }]
        };
        const f = fixture({}, 'Yeraltı 23. Bölüm', undefined, streamingData);
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
