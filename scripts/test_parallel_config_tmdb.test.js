const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const configUrl = 'https://raw.githubusercontent.com/falsisdev/anthology/main/config.json';
const tmdb = 'https://api.themoviedb.org/3/tv/123';
const video = 'https://media.fixture.invalid/episode.mp4';
const seriesTitle = 'Örnek Dizi';
const slug = 'ornek-dizi';
const episode = slug + '-1-bolum';

const providers = {
    ddizi: {
        base: 'https://www.ddizi.tel',
        search: '/arama/',
        show: '/diziler/' + slug,
        episode: '/izle/' + episode,
        player: '/player/oynat/fixture'
    },
    tvdiziler: {
        base: 'https://tvdiziler.tv',
        search: '/search?qr=' + encodeURIComponent(seriesTitle),
        show: '/dizi/' + slug,
        episode: '/' + episode,
        player: '/vid/ply/fixture'
    }
};

function createFixture(name, host, configDelay) {
    const provider = providers[name];
    const isDDizi = name === 'ddizi';
    const routes = new Map([
        [tmdb, { name: seriesTitle, original_name: seriesTitle, seasons: [] }],
        [tmdb + '/external_ids', {}],
        [tmdb + '/translations', { translations: [] }],
        [host + provider.search, isDDizi
            ? '<a href="' + provider.show + '">' + seriesTitle + '</a>'
            : { data: '<a href="dizi/' + slug + '"><h2>' + seriesTitle + '</h2></a>' }],
        [host + provider.show, isDDizi
            ? '<h1>' + seriesTitle + '</h1><a href="' + provider.episode + '">1. Bölüm</a>'
            : '<a data-navigo class="truncate" href="' + provider.episode + '">Bölüm <data>1</data></a>'
                + '<h6><a itemprop="name">1. Bölüm</a>'],
        [host + provider.episode, isDDizi
            ? '<iframe src="' + provider.player + '"></iframe>'
            : '<button data-hhs="' + provider.player + '">Tek Parça</button>'],
        [host + provider.player, 'file: "' + video + '"']
    ]);

    let now = 0;
    let timerId = 0;
    const timers = new Map();
    const requests = [];
    const unexpected = [];
    function setTimeout(callback, delay) {
        timers.set(++timerId, { callback, at: now + delay });
        return timerId;
    }

    async function fetch(input, options) {
        const url = new URL(input);
        requests.push({ url: input, at: now, referer: options?.headers?.Referer });
        if (input === configUrl) {
            if (configDelay === null) return new Promise(() => {});
            await new Promise(resolve => setTimeout(resolve, configDelay));
            return { ok: true, json: () => ({ urls: { series: { [name]: { base: host + '///' } } } }) };
        }

        const isTmdb = input.startsWith(tmdb);
        const route = isTmdb ? url.origin + url.pathname : input;
        if (!routes.has(route)) {
            unexpected.push(route);
            throw new Error('No offline fixture for ' + route);
        }
        await new Promise(resolve => setTimeout(resolve, isTmdb ? 100 : 40));
        const data = routes.get(route);
        return { ok: true, text: async () => data, json: async () => data };
    }

    const filename = path.resolve(__dirname, '../providers', name + '.js');
    const module = { exports: {} };
    const context = {
        module, require: () => undefined, fetch, URL, URLSearchParams, AbortController, AbortSignal,
        Date: { now: () => now }, setTimeout, clearTimeout: id => timers.delete(id)
    };
    runInNewContext(readFileSync(filename, 'utf8'), context, { filename });
    assert.equal(context.getStreams, module.exports.getStreams);
    assert.deepEqual(requests, []);

    return async (method, ...args) => {
        let settled = false;
        const result = context[method](...args);
        const markSettled = () => { settled = true; };
        result.then(markSettled, markSettled);
        while (true) {
            await new Promise(setImmediate);
            if (settled) break;
            assert.ok(timers.size, 'The fixture stalled');
            now = Math.min(...Array.from(timers.values(), timer => timer.at));
            for (const [id, timer] of timers) {
                if (timer.at <= now) {
                    timers.delete(id);
                    timer.callback();
                }
            }
        }
        assert.deepEqual(unexpected, []);
        return { output: JSON.parse(JSON.stringify(await result)), requests, elapsed: now };
    };
}

function assertStreams(streams, name, host) {
    const isDDizi = name === 'ddizi';
    const referer = isDDizi ? host + providers[name].player : host + '/';
    assert.equal(streams.length, 1);
    const [stream] = streams;
    const headers = { 'User-Agent': stream.headers['User-Agent'], Referer: referer };
    assert.ok(headers['User-Agent']);
    assert.deepEqual(stream, {
        name: isDDizi ? 'DDizi' : 'TvDiziler',
        title: isDDizi ? '⌜ DDizi ⌟ | CDN (MP4)' : '⌜ TvDiziler ⌟ | Tek Parça (MP4)',
        url: video, quality: '', provider: name, headers, format: 'mp4', isHls: false,
        behaviorHints: { notWebReady: true, proxyHeaders: { request: headers } }
    });
}

for (const [name, provider] of Object.entries(providers)) {
    const override = 'https://' + name + '.fixture.invalid';

    for (const { configDelay, host, firstSite } of [
        { configDelay: 120, host: override, firstSite: 120 },
        { configDelay: 1000, host: override, firstSite: 1000 },
        { configDelay: null, host: provider.base, firstSite: 8000 }
    ]) {
        const scenario = configDelay === null ? 'configuration times out' : 'configuration resolves in ' + configDelay + ' ms';
        test(name + ' overlaps TMDB lookup when ' + scenario, async () => {
            const { output: streams, requests, elapsed } = await createFixture(name, host, configDelay)(
                'getStreams', { id: '123:1:1', type: 'tv' }
            );
            assert.equal(requests.length, 8);
            assert.deepEqual(requests.filter(req => req.url === configUrl).map(req => req.at), [0]);
            assert.deepEqual(requests.filter(req => req.url.startsWith(tmdb)).map(req => req.at), [0, 0, 0]);
            const siteRequests = requests.filter(req => req.url.startsWith(host + '/'));
            assert.deepEqual(siteRequests.map(req => req.url), [
                provider.search, provider.show, provider.episode, provider.player
            ].map(route => host + route));
            assert.equal(siteRequests[0].at, firstSite);
            assert.deepEqual(siteRequests.map(req => req.referer), [
                host + '/', host + '/', host + '/', host + provider.episode
            ]);
            assert.equal(elapsed, firstSite + 160);
            assertStreams(streams, name, host);
        });
    }

    test(name + ' waits for configuration on a direct episode ID', async () => {
        const directId = name === 'ddizi' ? 'ddizi:ep:' + episode : 'tvdiziler:ep:' + provider.episode;
        const { output: streams, requests, elapsed } = await createFixture(name, override, 120)('getStreams', directId);
        assert.deepEqual(requests, [
            { url: configUrl, at: 0, referer: undefined },
            { url: override + provider.episode, at: 120, referer: override + '/' },
            { url: override + provider.player, at: 160, referer: override + provider.episode }
        ]);
        assert.equal(elapsed, 200);
        assertStreams(streams, name, override);
    });

    test(name + ' still initializes configuration for standalone metadata and catalog calls', async () => {
        const showId = name + ':show:' + (name === 'ddizi' ? slug : 'dizi/' + slug);
        const meta = await createFixture(name, override, 120)('getMeta', showId);
        const catalog = await createFixture(name, override, 120)('getCatalog', { search: seriesTitle });
        assert.equal(meta.output.meta.id, showId);
        assert.deepEqual(catalog.output.metas.map(item => item.id), [showId]);
        for (const [result, firstPath] of [[meta, provider.show], [catalog, provider.search]]) {
            assert.deepEqual(result.requests.slice(0, 2), [
                { url: configUrl, at: 0, referer: undefined },
                { url: override + firstPath, at: 120, referer: override + '/' }
            ]);
        }
    });
}

test('DDizi resolves a show object and its recursive episode lookup with one configuration request', async () => {
    const host = 'https://ddizi.fixture.invalid';
    const { output: streams, requests, elapsed } = await createFixture('ddizi', host, 120)(
        'getStreams', { id: 'ddizi:show:' + slug }
    );
    assert.deepEqual(requests.map(req => [req.url, req.at]), [
        [configUrl, 0],
        [host + providers.ddizi.show, 120],
        [host + providers.ddizi.episode, 160],
        [host + providers.ddizi.player, 200]
    ]);
    assert.equal(elapsed, 240);
    assertStreams(streams, 'ddizi', host);
});
