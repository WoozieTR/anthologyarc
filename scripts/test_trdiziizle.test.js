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

function fetchFixtures(t, routes, youtube = {}) {
    const queries = [];
    const unexpected = [];
    t.mock.method(globalThis, 'fetch', async (input, opts) => {
        const url = new URL(input);
        let body;
        if (routes.has(input)) {
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
            fixture0001: video(title + ' 3. Bölüm', {
                formats: [{ url: mp4, mimeType: 'video/mp4' }]
            })
        }
    });
    const [stream] = await getStreams(title, 'tv', 1, 3);
    assert.equal(stream.url, mp4);
    assert.equal(stream.quality, undefined);
    assert.doesNotMatch(stream.title, /1080p|720p/);
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
