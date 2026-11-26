const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getStreams } = require('../src/trdiziizle');

const title = 'Örnek Dizi';
const base = require('../config.json').urls.series.trdiziizle.base;
const seriesPage = 'https://fixture.invalid/dizi/ornek/';
const episodePage = 'https://fixture.invalid/ornek-3-bolum/';
const iframe = 'https://fixture.invalid/player';
const hls = 'https://fixture.invalid/video.m3u8';
const mp4 = 'https://fixture.invalid/video.mp4';
const youtubeWatch = 'https://www.youtube.com/watch?v=fixture0001';
const youtubeEmbed = 'https://youtu.be/fixture0001';

function fetchFixtures(t, routes, youtube = {}, metadata) {
    const queries = [];
    const unexpected = [];
    t.mock.method(globalThis, 'fetch', async (input, opts) => {
        const url = new URL(input);
        let body;
        if (metadata && url.origin === 'https://api.themoviedb.org' && /^\/3\/tv\/123(?:\/(?:external_ids|translations))?$/.test(url.pathname)) {
            body = url.pathname === '/3/tv/123' ? metadata : {};
        } else if (routes.has(input)) {
            body = routes.get(input);
        } else if (url.origin === 'https://www.youtube.com' && url.pathname === '/results' && youtube.search) {
            const query = url.searchParams.get('search_query');
            queries.push(query);
            body = (youtube.search(query) || []).map(id => JSON.stringify({ videoId: id })).join('');
        } else if (url.origin === 'https://www.youtube.com' && url.pathname === '/youtubei/v1/player' && youtube.videos) {
            body = youtube.videos[JSON.parse(opts.body).videoId];
        }
        if (body === undefined) {
            unexpected.push(url.origin + url.pathname);
            throw new Error('No fixture for ' + url.pathname);
        }
        if (body instanceof Error) throw body;
        return { ok: true, status: 200, text: async () => body, json: async () => body };
    });
    t.after(() => assert.deepEqual(unexpected, []));
    return queries;
}

function video(title, streamingData = { hlsManifestUrl: hls }) {
    return { videoDetails: { title, lengthSeconds: '2400' }, streamingData };
}

const siteDown = [[base + '/', 'parked']];

function link(url, label) {
    return '<a href="' + url + '">' + label + '</a>';
}

function embed(url) {
    return '<iframe src="' + url + '"></iframe>';
}

test('YouTube does not search for episode one when another episode is requested', async (t) => {
    const queries = fetchFixtures(t, new Map(siteDown), {
        search: (query) => query === title + ' 1. Bölüm' ? ['fixture0001'] : [],
        videos: { fixture0001: video(title + ' 1. Bölüm') }
    });
    assert.deepEqual(await getStreams(title, 'tv', 1, 3), []);
    assert.deepEqual(queries, [title + ' 3. Bölüm']);
});

test('YouTube rejects mismatched or unverified results and keeps a verified episode', async (t) => {
    fetchFixtures(t, new Map(siteDown), {
        search: () => ['fixture0001', 'fixture0002', 'fixture0003', 'fixture0004'],
        videos: {
            fixture0001: video(title + ' 3. Bölüm', { hlsManifestUrl: 'https://fixture.invalid/season-one.m3u8' }),
            fixture0002: video(title + ' 2. Sezon 30. Bölüm', { hlsManifestUrl: 'https://fixture.invalid/episode-thirty.m3u8' }),
            fixture0003: video('Başka Dizi 2. Sezon 3. Bölüm', { hlsManifestUrl: 'https://fixture.invalid/wrong-series.m3u8' }),
            fixture0004: video('ÖRNEK DİZİ | 2. Sezon 3. Bölüm | 1080p')
        }
    });
    const streams = await getStreams({ id: title, type: 'series', season: '2', episode: '3' });
    assert.deepEqual(streams.map(stream => stream.url), [hls]);
    assert.equal(streams[0].quality, undefined);
    assert.doesNotMatch(streams[0].title, /1080p|720p/);
});

test('YouTube retains a real first episode and labels MP4 using its own metadata', async (t) => {
    fetchFixtures(t, new Map(siteDown), {
        search: () => ['fixture0001'],
        videos: {
            fixture0001: video('Bölüm 1 - ' + title, {
                hlsManifestUrl: hls,
                formats: [{ url: mp4, mimeType: 'video/mp4', qualityLabel: '480p' }]
            })
        }
    });
    const [stream, hlsStream] = await getStreams(title, 'tv', 1, 1);
    assert.equal(stream.url, mp4);
    assert.equal(stream.quality, '480p');
    assert.match(stream.title, /480p/);
    assert.equal(hlsStream.url, hls);
    assert.equal(hlsStream.quality, undefined);
});

test('YouTube MP4 without resolution metadata has no resolution label', async (t) => {
    fetchFixtures(t, new Map(siteDown), {
        search: () => ['fixture0001'],
        videos: {
            fixture0001: video(title + ' 3. Bölüm | 1080p', {
                formats: [
                    { url: mp4, mimeType: 'video/mp4' },
                    { url: 'https://fixture.invalid/1080p/video.mp4', mimeType: 'video/mp4', qualityLabel: 'hd1080' }
                ]
            })
        }
    });
    const [stream] = await getStreams(title, 'tv', 1, 3);
    assert.equal(stream.url, mp4);
    assert.equal(stream.quality, undefined);
    assert.doesNotMatch(stream.title, /\d+p/i);
});

test('YouTube selects the highest resolution from unordered progressive MP4 formats', async (t) => {
    const best = 'https://fixture.invalid/best.mp4';
    const mimeType = 'video/mp4; codecs="avc1.640028, mp4a.40.2"';
    fetchFixtures(t, new Map(siteDown), {
        search: () => ['fixture0001'],
        videos: {
            fixture0001: video(title + ' 3. Bölüm', {
                hlsManifestUrl: hls,
                formats: [
                    { url: mp4, mimeType },
                    { url: 'https://fixture.invalid/low.mp4', mimeType, qualityLabel: '360p' },
                    { url: best, mimeType, qualityLabel: '1080p' },
                    { url: 'https://fixture.invalid/mid.mp4', mimeType, qualityLabel: '720p60 HDR' }
                ]
            })
        }
    });
    const streams = await getStreams(title, 'tv', 1, 3);
    assert.deepEqual(streams.map(stream => [stream.url, stream.format, stream.isHls, stream.quality]), [
        [best, 'mp4', false, '1080p'],
        [hls, 'hls', true, undefined]
    ]);
});

test('YouTube uses explicit height when the MP4 has no resolution label', async (t) => {
    fetchFixtures(t, new Map(siteDown), {
        search: () => ['fixture0001'],
        videos: {
            fixture0001: video(title + ' 3. Bölüm', {
                formats: [
                    { url: 'https://fixture.invalid/mid.mp4', mimeType: 'video/mp4', qualityLabel: '720p' },
                    { url: mp4, mimeType: 'video/mp4', height: 1080 }
                ]
            })
        }
    });
    const [stream] = await getStreams(title, 'tv', 1, 3);
    assert.equal(stream.url, mp4);
    assert.equal(stream.quality, undefined);
    assert.doesNotMatch(stream.title, /\d+p/i);
});

test('YouTube excludes video-only and audio-only formats and leaves adaptive HLS available', async (t) => {
    const videoOnly = { url: 'https://fixture.invalid/silent.mp4', mimeType: 'video/mp4; codecs="avc1.640028"', qualityLabel: '1080p' };
    const noAudioChannels = { url: 'https://fixture.invalid/no-audio.mp4', mimeType: 'video/mp4', audioChannels: 0, qualityLabel: '1440p' };
    const audioOnly = { url: 'https://fixture.invalid/audio.m4a', mimeType: 'audio/mp4; codecs="mp4a.40.2"' };
    const progressive = { url: mp4, mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"', qualityLabel: '720p' };
    fetchFixtures(t, new Map(siteDown), {
        search: () => ['fixture0001', 'fixture0002'],
        videos: {
            fixture0001: video(title + ' 3. Bölüm', {
                hlsManifestUrl: hls,
                formats: [videoOnly, noAudioChannels, audioOnly, progressive],
                adaptiveFormats: [{ ...progressive, url: 'https://fixture.invalid/adaptive.mp4', qualityLabel: '2160p' }]
            }),
            fixture0002: video(title + ' 4. Bölüm', { hlsManifestUrl: hls, formats: [videoOnly, audioOnly] })
        }
    });
    assert.deepEqual((await getStreams(title, 'tv', 1, 3)).map(stream => stream.url), [mp4, hls]);
    assert.deepEqual((await getStreams(title, 'tv', 1, 4)).map(stream => stream.url), [hls]);
});

test('direct episode IDs preserve iframe streams without claiming a resolution', async (t) => {
    fetchFixtures(t, new Map([
        [episodePage, embed(iframe) + embed(youtubeEmbed)],
        [iframe, '"' + hls + '" "' + mp4 + '" "' + mp4 + '"']
    ]));
    const streams = await getStreams('trdiziizle:link:' + episodePage, 'series');
    assert.deepEqual(new Map(streams.map(stream => [stream.url, [stream.format, stream.isHls]])), new Map([
        [hls, ['hls', true]], [mp4, ['mp4', false]], [youtubeWatch, ['mp4', false]]
    ]));
    assert.equal(streams.length, 3);
    for (const stream of streams) {
        assert.equal(stream.quality, undefined);
        assert.doesNotMatch(stream.title, /1080p|720p/);
    }
});

function wp(t, links) {
    return fetchFixtures(t, new Map([
        [base + '/', 'reachable'],
        [base + '/?s=' + encodeURIComponent(title), '<article>' + link(seriesPage, title) + '</article>'],
        [seriesPage, links],
        [episodePage, embed(iframe)],
        [iframe, '"' + hls + '"']
    ]), { search: () => [] });
}

test('WordPress does not fall back to unmarked season-one links for season two', async (t) => {
    wp(t, link(episodePage, 'Bölüm 3'));
    assert.deepEqual(await getStreams(title, 'tv', 2, 3), []);
});

test('WordPress reads a Turkish number-first episode label on the requested season page', async (t) => {
    const seasonPage = 'https://fixture.invalid/ornek-2-sezon-izle/';
    fetchFixtures(t, new Map([
        [base + '/', 'reachable'],
        [base + '/?s=' + encodeURIComponent(title), '<article>' + link(seriesPage, title) + '</article>'],
        [seriesPage, link(seasonPage, '2. Sezon')],
        [seasonPage, link(episodePage, title + ' 3. Bölüm')],
        [episodePage, embed(iframe)],
        [iframe, '"' + hls + '"']
    ]), { search: () => [] });
    assert.deepEqual((await getStreams(title, 'tv', 2, 3)).map(stream => stream.url), [hls]);
});

test('WordPress rejects an episode link with a conflicting season label', async (t) => {
    wp(t, link(episodePage, '2. Sezon Bölüm 3'));
    assert.deepEqual(await getStreams(title, 'tv', 1, 3), []);
});

test('WordPress accepts an explicitly numbered episode on the series page', async (t) => {
    wp(t, link(episodePage, '2. Sezon 3. Bölüm'));
    assert.deepEqual((await getStreams('Örnek Dizi:2:3', 'tv')).map(stream => stream.url), [hls]);
});

const seriesMetadata = {
    name: title,
    seasons: [
        { season_number: 2, episode_count: 12 },
        { season_number: 0, episode_count: 3 },
        { season_number: 1, episode_count: 16 }
    ]
};

test('YouTube accepts the exact compact season and episode and retains verified 360p', async (t) => {
    fetchFixtures(t, new Map(siteDown), {
        search: () => ['fixture0001', 'fixture0002', 'fixture0003', 'fixture0004'],
        videos: {
            fixture0001: video(title + ' S01E08'),
            fixture0002: video(title + ' S02E09'),
            fixture0003: video('Başka Dizi S02E08'),
            fixture0004: video(title + ' | S02E08', {
                formats: [{ url: mp4, mimeType: 'video/mp4; codecs="avc1.42001e, mp4a.40.2"', height: 360, qualityLabel: '360p' }]
            })
        }
    }, seriesMetadata);
    const streams = await getStreams('123', 'tv', 2, 8);
    assert.deepEqual(streams.map(stream => [stream.url, stream.quality]), [[mp4, '360p']]);
});

test('YouTube tries the verified cumulative search before the other sequential searches', async (t) => {
    const cumulativeQuery = title + ' 24. Bölüm';
    const queries = fetchFixtures(t, new Map(siteDown), {
        search: query => query === cumulativeQuery ? ['fixture0001'] : [],
        videos: { fixture0001: video(title + ' 24. Bölüm') }
    }, seriesMetadata);
    assert.deepEqual((await getStreams('123', 'tv', 2, 8)).map(stream => stream.url), [hls]);
    assert.deepEqual(queries, [cumulativeQuery]);
});

test('WordPress checks the series index if the season page is empty or throws', async (t) => {
    const seasonPage = 'https://fixture.invalid/ornek-2-sezon-izle/';
    for (const [name, response] of [
        ['empty', '<p>No episodes</p>'],
        ['exception', new Error('fixture season page error')]
    ]) {
        await t.test(name, async (child) => {
            fetchFixtures(child, new Map([
                [base + '/', 'reachable'],
                [base + '/?s=' + encodeURIComponent(title), '<article>' + link(seriesPage, title) + '</article>'],
                [seriesPage, link(seasonPage, 'Season 2') +
                    link('https://fixture.invalid/wrong-episode/', 'Bölüm 8') +
                    link(episodePage, 'Bölüm 8 | Season 2')],
                [seasonPage, response],
                [episodePage, embed(iframe)],
                [iframe, '"' + mp4 + '"']
            ]), { search: () => [] }, seriesMetadata);
            const streams = await getStreams('123', 'tv', 2, 8);
            assert.deepEqual(streams.map(stream => [stream.url, stream.quality]), [[mp4, undefined]]);
        });
    }
});

test('an empty fallback logs stage counts and elapsed time without response data', async (t) => {
    const log = t.mock.method(console, 'log', () => {});
    fetchFixtures(t, new Map(siteDown), {
        search: () => ['fixture0001', 'fixture0002', 'fixture0003', 'fixture0004'],
        videos: {
            fixture0001: new Error('private exception text ' + mp4),
            fixture0002: { videoDetails: { title, lengthSeconds: '899' } },
            fixture0003: video(title + ' 4. Bölüm'),
            fixture0004: video(title + ' 3. Bölüm', {
                formats: [{ url: mp4, mimeType: 'video/mp4; codecs="avc1.42001e"', audioChannels: 0 }]
            })
        }
    });
    assert.deepEqual(await getStreams(title, 'tv', 1, 3), []);
    assert.equal(log.mock.callCount(), 1);
    assert.equal(log.mock.calls[0].arguments.length, 1);
    assert.match(log.mock.calls[0].arguments[0],
        /^\[trdiziizle\] empty stage=youtube elapsedMs=\d+ cumulative=false wordpress=unavailable seasonPageErrors=0 searchErrors=0 playerErrors=1 shortCandidates=1 episodeMismatches=1 noPlayableFormats=1$/);
});

test('YouTube finds cumulative episode 24 and preserves strict season, episode and title checks', async (t) => {
    const queries = fetchFixtures(t, new Map(siteDown), {
        search: query => {
            if (query === title + ' 24. Bölüm') return ['fixture0001', 'fixture0002', 'fixture0003', 'fixture0004'];
            if (query === title + ' 2. Sezon 9. Bölüm') return ['fixture0005'];
            return [];
        },
        videos: {
            fixture0001: video(title + ' 1. Sezon 24. Bölüm', { hlsManifestUrl: mp4 }),
            fixture0002: video(title + ' 25. Bölüm', { hlsManifestUrl: mp4 }),
            fixture0003: video('Başka Dizi 24. Bölüm', { hlsManifestUrl: mp4 }),
            fixture0004: video(title + ' 24. Bölüm'),
            fixture0005: video(title + ' 2. Sezon 9. Bölüm')
        }
    }, seriesMetadata);
    assert.deepEqual((await getStreams('123', 'tv', 2, 8)).map(stream => stream.url), [hls]);
    assert.ok(queries.includes(title + ' 24. Bölüm'));
    assert.deepEqual((await getStreams('123', 'tv', 2, 9)).map(stream => stream.url), [hls]);
});

test('WordPress uses cumulative numbering on the series page with complete season metadata', async (t) => {
    fetchFixtures(t, new Map([
        [base + '/', 'reachable'],
        [base + '/?s=' + encodeURIComponent(title), '<article>' + link(seriesPage, title) + '</article>'],
        [seriesPage, link('https://fixture.invalid/wrong-bolum/', '1. Sezon 24. Bölüm') +
            link('https://fixture.invalid/wrong-bolum/', '8. Bölüm') +
            link('https://fixture.invalid/wrong-bolum/', '25. Bölüm') + link(episodePage, '24. Bölüm')],
        [episodePage, embed(iframe)],
        [iframe, '"' + hls + '"']
    ]), { search: () => [] }, seriesMetadata);
    assert.deepEqual((await getStreams('123', 'tv', 2, 8)).map(stream => stream.url), [hls]);
});

test('YouTube does not guess a cumulative episode when a previous season count is missing', async (t) => {
    const queries = fetchFixtures(t, new Map(siteDown), {
        search: () => ['fixture0001'],
        videos: { fixture0001: video(title + ' 24. Bölüm') }
    }, { name: title, seasons: [{ season_number: 2, episode_count: 12 }] });
    assert.deepEqual(await getStreams('123', 'tv', 2, 8), []);
    assert.deepEqual(queries, [title + ' 2. Sezon 8. Bölüm', title + ' 8. Bölüm']);
});
