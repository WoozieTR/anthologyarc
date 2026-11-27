const { sortStreamsByQuality } = require('../shared/quality.js');
const { getResolutionFromPath, getDeclaredSourceMetadata } = require('../shared/resolution.js');
const { loadConfig, val, wrapAll } = require('../shared/config.js');
const { safeFetch } = require('../shared/http_request.js');
const { asciiFold, normalizeSeriesId, seriesSearchTitles, resolveSeriesInfo } = require('../shared/turkish_series.js');

var _cfgReady = null;
function cfgReady() {
    if (!_cfgReady) {
        _cfgReady = loadConfig().then(function () {
            var v = val('urls.series.tvdiziler.base');
            if (v) BASE_URL = String(v).replace(/\/+$/, '');
            if (HEADERS) HEADERS.Referer = BASE_URL + '/';
        });
    }
    return _cfgReady;
}

/**
 * Anthology - TvDiziler Provider
 * https://tvdiziler.tv/
 * Yerli TV dizileri arşivi üzerinden HLS (Twitter Amplify), doğrudan MP4 (Ciner/CDN) ve YouTube akışları.
 */

var BASE_URL = 'https://tvdiziler.tv';
var TMDB_API_KEY = '500330721680edb6d5f7f12ba7cd9023';

var HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
    'Referer': BASE_URL + '/'
};

// Callers pass fixed fields and sanitize any public title metadata.
function diagnostic(stage, fields) {
    try {
        if (typeof console !== 'undefined' && typeof console.log === 'function') {
            console.log('[TvDiziler] ' + stage + ' ' + JSON.stringify(fields));
        }
    } catch (e) {}
}

async function resolveYouTubeMp4(ytId) {
    try {
        var key = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
        var res = await safeFetch('https://www.youtube.com/youtubei/v1/player?key=' + key, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'
            },
            body: JSON.stringify({
                context: {
                    client: {
                        clientName: 'ANDROID',
                        clientVersion: '20.10.38'
                    }
                },
                videoId: ytId
            })
        }, 3500);

        if (res.ok) {
            var data = await res.json();
            if (data.streamingData) {
                if (data.streamingData.hlsManifestUrl) {
                    return {
                        url: data.streamingData.hlsManifestUrl,
                        quality: '',
                        isHls: true,
                        format: 'hls',
                        headers: {
                            'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'
                        }
                    };
                }
                if (data.streamingData.formats) {
                    var formats = data.streamingData.formats.filter(function (f) {
                        return f.url && (f.mimeType || '').includes('mp4');
                    });
                    if (formats.length > 0) {
                        return {
                            url: formats[0].url,
                            quality: formats[0].qualityLabel || '',
                            isHls: false,
                            format: 'mp4',
                            headers: {
                                'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'
                            }
                        };
                    }
                }
            }
        }
    } catch (e) {}
    return null;
}

function cleanSeriesTitle(title) {
    return String(title || '').replace(/\s*\(\d{4}\)\s*$/, '').trim();
}

function decodeSearchTitle(title) {
    return title.replace(/&(?:nbsp|#([0-9]+)|#x([0-9a-f]+));/gi, (entity, decimal, hex) => {
        if (decimal === undefined && hex === undefined) return ' ';

        const codePoint = decimal === undefined ? parseInt(hex, 16) : Number(decimal);
        if (codePoint === 0 || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
            return entity;
        }
        return codePoint === 0xA0 ? ' ' : String.fromCodePoint(codePoint);
    });
}

function seriesKey(title) {
    return asciiFold(title).replace(/[^a-z0-9]/g, '');
}

function lastPathSegment(href) {
    return href.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop();
}

function showSlugKey(href) {
    return seriesKey(lastPathSegment(href).replace(/-(?:(?:\d+-)?son-bolum|izle)(?:-|$).*$/i, ''));
}

function parseEpisodeLink(href) {
    const slug = asciiFold(lastPathSegment(href));
    const match = slug.match(/^(.+?)-sezon-(\d+)-bolumu?-(\d+)(?:-|$)/) ||
        slug.match(/^(.+?)(?:-(\d+)-sezon)?-(\d+)-bolumu?(?:-|$)/);
    if (!match) return null;
    return { series: seriesKey(match[1]), season: match[2] ? Number(match[2]) : null, episode: Number(match[3]) };
}

const SEASON_LABEL = '(?:([0-9]+)\\s*\\.?\\s*(?:sezon|season)|(?:sezon|season)\\s*[:#-]?\\s*([0-9]+))\\b';
const EPISODE_LABEL = '(?:([0-9]+)\\s*\\.?\\s*(?:bolumu?|episode|ep|b)|(?:bolumu?|episode|ep)\\s*[:#-]?\\s*([0-9]+)|b([0-9]+))\\b';

function episodeLabels(text) {
    // Consume each marker once so adjacent numbers belong to their own labels.
    const labels = new RegExp('\\b(?:' + SEASON_LABEL + '|' + EPISODE_LABEL + ')', 'g');
    const seasons = [];
    const episodes = [];
    for (const match of text.matchAll(labels)) {
        if (match[1] || match[2]) seasons.push(Number(match[1] || match[2]));
        else episodes.push(Number(match[3] || match[4] || match[5]));
    }
    return { seasons, episodes };
}

function matchesEpisodeNumbers(labels, season, episode, cumEpisode) {
    if (labels.seasons.some(number => number !== season)) return false;
    return labels.episodes.every(number =>
        number === cumEpisode || (labels.seasons.length > 0 && number === episode));
}

function matchesYouTubeEpisode(videoTitle, title, season, episode, cumEpisode) {
    const text = asciiFold(videoTitle);
    const series = asciiFold(cleanSeriesTitle(title)).match(/[a-z0-9]+/g);
    if (!series) return false;

    const separator = '[^a-z0-9]*';
    const seriesLabel = series.join('[^a-z0-9]+');
    const episodeLabel = '(?:' + SEASON_LABEL + separator + ')?' + EPISODE_LABEL;
    const titleFirst = new RegExp('(?:^|[|–—])' + separator + seriesLabel + separator + episodeLabel);
    const episodeFirst = new RegExp('^' + separator + episodeLabel + separator + seriesLabel +
        '(?:' + separator + '$|\\s*[|–—-])');
    if (!titleFirst.test(text) && !episodeFirst.test(text)) return false;

    const labels = episodeLabels(text);
    return labels.episodes.length > 0 && matchesEpisodeNumbers(labels, season, episode, cumEpisode);
}

function cumulativeEpisode(seasons, season, episode) {
    const entries = Array.isArray(seasons) ? seasons : [];
    let total = episode;
    for (let s = 1; s < season; s++) {
        const previous = entries.find(entry => entry && entry.season_number === s);
        if (!previous || !Number.isInteger(previous.episode_count) || previous.episode_count <= 0) return null;
        total += previous.episode_count;
    }
    return total;
}

function matchEpisode(episodes, keys, season, episode, cumEpisode) {
    let cumulativeMatch = null;
    const counts = { origin: 'episode_list', accepted: 0, rejected: 0, invalid_link: 0, series_mismatch: 0, number_mismatch: 0 };
    for (const entry of episodes) {
        const identity = parseEpisodeLink(entry.href);
        if (!identity || !keys.includes(identity.series)) {
            counts.rejected++;
            if (identity) counts.series_mismatch++;
            else counts.invalid_link++;
            continue;
        }

        const labels = episodeLabels(asciiFold(entry.title));
        if (identity.season !== null) labels.seasons.push(identity.season);
        labels.episodes.push(identity.episode);
        if (entry.epNum) labels.episodes.push(entry.epNum);
        if (!matchesEpisodeNumbers(labels, season, episode, cumEpisode)) {
            counts.rejected++;
            counts.number_mismatch++;
            continue;
        }

        counts.accepted++;
        if (labels.seasons.length > 0) {
            diagnostic('episode_match', counts);
            return entry;
        }
        if (!cumulativeMatch) cumulativeMatch = entry;
    }
    diagnostic('episode_match', counts);
    return cumulativeMatch;
}

function getValidTmdbKey() {
    if (typeof TMDB_API_KEY === 'string' && TMDB_API_KEY.length === 32 && !TMDB_API_KEY.startsWith('http')) {
        return TMDB_API_KEY;
    }
    return '500330721680edb6d5f7f12ba7cd9023';
}

async function resolveOfficialYouTubeFallback(title, season, episode, cumEpisode) {
    const counts = { origin: 'youtube_fallback', accepted: 0, rejected: 0, duration: 0, title_mismatch: 0 };
    try {
        var queries = [];
        if (season > 1) {
            queries.push(title + ' ' + season + '. Sezon ' + episode + '. Bölüm');
            if (cumEpisode && cumEpisode !== episode) {
                queries.push(title + ' ' + cumEpisode + '. Bölüm');
            }
        }
        queries.push(title + ' ' + episode + '. Bölüm');

        var key = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
        for (var query of queries) {
            try {
                var res = await safeFetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), {
                    headers: {
                        'User-Agent': HEADERS['User-Agent']
                    }
                }, 3500);
                if (!res.ok) continue;
                var html = await res.text();
                var vidMatches = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)].map(function (m) { return m[1]; });
                var uniqueVids = [...new Set(vidMatches)].slice(0, 3);

                for (var ytId of uniqueVids) {
                    try {
                        var pRes = await safeFetch('https://www.youtube.com/youtubei/v1/player?key=' + key, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'
                            },
                            body: JSON.stringify({
                                context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
                                videoId: ytId
                            })
                        }, 3000);
                        if (!pRes.ok) continue;
                        var data = await pRes.json();
                        var duration = parseInt((data.videoDetails && data.videoDetails.lengthSeconds) || '0');
                        var vTitle = (data.videoDetails && data.videoDetails.title) || '';

                        // Duration must be at least 15 minutes (900 seconds) for a full episode
                        if (duration >= 900 && matchesYouTubeEpisode(vTitle, title, season, episode, cumEpisode)) {
                            var streams = [];
                            if (data.streamingData && data.streamingData.hlsManifestUrl) {
                                streams.push({
                                    name: 'TvDiziler',
                                    title: '⌜ TvDiziler ⌟ | Resmi YouTube HLS (' + vTitle.slice(0, 50) + ')',
                                    url: data.streamingData.hlsManifestUrl,
                                    quality: '',
                                    provider: 'tvdiziler',
                                    format: 'hls',
                                    isHls: true,
                                    headers: {
                                        'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'
                                    }
                                });
                            }
                            if (data.streamingData && data.streamingData.formats) {
                                var formats = data.streamingData.formats.filter(function (f) { return f.url && (f.mimeType || '').includes('mp4'); });
                                if (formats.length > 0) {
                                    streams.push({
                                        name: 'TvDiziler',
                                        title: '⌜ TvDiziler ⌟ | Resmi YouTube MP4' + (formats[0].qualityLabel ? ' (' + formats[0].qualityLabel + ')' : ''),
                                        url: formats[0].url,
                                        quality: formats[0].qualityLabel || '',
                                        provider: 'tvdiziler',
                                        format: 'mp4',
                                        isHls: false,
                                        headers: {
                                            'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'
                                        }
                                    });
                                }
                            }
                            // Native Stremio / Nuvio YouTube player fallback
                            streams.push({
                                name: 'TvDiziler',
                                title: '⌜ TvDiziler ⌟ | YouTube (' + vTitle.slice(0, 50) + ')',
                                ytId: ytId,
                                provider: 'tvdiziler'
                            });
                            if (streams.length > 0) {
                                counts.accepted++;
                                diagnostic('episode_match', counts);
                                return streams;
                            }
                        } else {
                            counts.rejected++;
                            if (duration >= 900) counts.title_mismatch++;
                            else counts.duration++;
                        }
                    } catch (e) {}
                }
            } catch (e) {}
        }
    } catch (e) {}
    diagnostic('episode_match', counts);
    return null;
}

async function resolveTmdbInfo(id, mediaType) {
    try {
        var info = await resolveSeriesInfo(id, mediaType, getValidTmdbKey());
        return {
            title: info.title,
            origTitle: info.origTitle,
            numericId: info.numericId || null,
            seasons: info.seasons,
            aliases: info.aliases,
            kind: info.kind,
            type: info.type
        };
    } catch (e) {
        return { title: '', origTitle: '', numericId: null, seasons: [], aliases: [], kind: 'unknown', type: 'tv' };
    }
}

async function searchTvDiziler(query) {
    try {
        var searchUrl = BASE_URL + '/search?qr=' + encodeURIComponent(query);
        var res = await safeFetch(searchUrl, {
            method: 'POST',
            headers: {
                'User-Agent': HEADERS['User-Agent'],
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Referer': BASE_URL + '/'
            }
        });
        if (!res.ok) {
            res = await safeFetch(searchUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': HEADERS['User-Agent'],
                    'X-Requested-With': 'XMLHttpRequest',
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'Referer': BASE_URL + '/'
                }
            });
        }
        if (!res.ok) return [];
        var json = await res.json();
        if (!json || !json.data) return [];

        var items = [];
        var cardRegex = /<a[^>]+href=["'](?:https:\/\/tvdiziler\.tv\/)?(dizi\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        var m;
        while ((m = cardRegex.exec(json.data)) !== null) {
            var slug = m[1];
            var inner = m[2];
            var titleMatch = inner.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i);
            var title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
            var imgMatch = inner.match(/(?:data-src|src)=["']([^"']+)["']/i);
            var poster = imgMatch ? (imgMatch[1].startsWith('http') ? imgMatch[1] : BASE_URL + '/' + imgMatch[1].replace(/^\/+/, '')) : '';
            if (slug && title) {
                items.push({ slug: slug, title: title, poster: poster });
            }
        }
        return items;
    } catch (e) {
        return [];
    }
}

async function getCatalog(args) {
    try {
        var query = (args && args.search) || (args && args.extra && args.extra.search) || (args && args.query) || '';
        if (query) {
            var results = await searchTvDiziler(query);
            var metas = results.map(function (r) {
                return {
                    id: 'tvdiziler:show:' + r.slug,
                    type: 'tv',
                    name: r.title,
                    poster: r.poster || 'https://raw.githubusercontent.com/falsisdev/anthology/main/assets/logo_1_transparent.png',
                    background: r.poster || 'https://raw.githubusercontent.com/falsisdev/anthology/main/assets/logo_1_transparent.png',
                    genres: ['Yerli Dizi', 'TvDiziler'],
                    description: r.title + ' - TvDiziler'
                };
            });
            return { metas: metas };
        }

        var metas = [];
        try {
            var res = await safeFetch(BASE_URL + '/dizi-izle', { headers: HEADERS }, 5000);
            if (res.ok) {
                var html = await res.text();
                var cardRegex = /<a[^>]+href=["'](?:https:\/\/tvdiziler\.[^/"']+\/)?(dizi\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
                var seen = new Set();
                var m;
                while ((m = cardRegex.exec(html)) !== null) {
                    var slug = m[1];
                    if (!slug || seen.has(slug)) continue;
                    seen.add(slug);
                    var inner = m[2];
                    var titleMatch = inner.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i);
                    var title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
                    if (!title) continue;
                    var imgMatch = inner.match(/(?:data-src|src)=["']([^"']+)["']/i);
                    var poster = imgMatch ? (imgMatch[1].startsWith('http') ? imgMatch[1] : BASE_URL + '/' + imgMatch[1].replace(/^\/+/, '')) : 'https://raw.githubusercontent.com/falsisdev/anthology/main/assets/logo_1_transparent.png';
                    metas.push({
                        id: 'tvdiziler:show:' + slug,
                        type: 'tv',
                        name: title,
                        poster: poster,
                        background: poster,
                        genres: ['Yerli Dizi', 'TvDiziler'],
                        description: title + ' - TvDiziler'
                    });
                    if (metas.length >= 50) break;
                }
            }
        } catch (e) {}

        if (metas.length === 0) {
            try {
                var tmdbRes = await safeFetch('https://api.themoviedb.org/3/discover/tv?api_key=' + getValidTmdbKey() + '&with_original_language=tr&sort_by=popularity.desc&language=tr-TR', {}, 6000);
                if (tmdbRes.ok) {
                    var tmdbData = await tmdbRes.json();
                    var results = (tmdbData && tmdbData.results) || [];
                    for (var i = 0; i < results.length; i++) {
                        var item = results[i];
                        var name = item.name || item.original_name || '';
                        if (!name) continue;
                        var pUrl = item.poster_path ? ('https://image.tmdb.org/t/p/w500' + item.poster_path) : 'https://raw.githubusercontent.com/falsisdev/anthology/main/assets/logo_1_transparent.png';
                        metas.push({
                            id: String(item.id),
                            type: 'tv',
                            name: name,
                            poster: pUrl,
                            background: item.backdrop_path ? ('https://image.tmdb.org/t/p/w780' + item.backdrop_path) : pUrl,
                            genres: ['Yerli Dizi', 'TvDiziler'],
                            description: item.overview || (name + ' - TvDiziler')
                        });
                    }
                }
            } catch (e) {}
        }

        return { metas: metas };
    } catch (e) {
        return { metas: [] };
    }
}

async function getMeta(args) {
    try {
        var rawId = (typeof args === 'string') ? args : (args && args.id ? args.id : '');
        if (!rawId) return { meta: null };

        if (rawId.startsWith('tvdiziler:ep:')) {
            var epSlug = rawId.replace('tvdiziler:ep:', '');
            var epUrl = BASE_URL + '/' + epSlug.replace(/^\/+/, '');
            var res = await safeFetch(epUrl, { headers: HEADERS });
            if (!res.ok) return { meta: null };
            var html = await res.text();

            var titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title>([^<]+)<\/title>/i);
            var title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'TvDiziler Bölüm';
            var ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
            var poster = ogImg ? ogImg[1] : 'https://raw.githubusercontent.com/falsisdev/anthology/main/assets/logo_1_transparent.png';

            var numMatch = title.match(/(\d+)\s*\.?\s*bölüm/i) || epSlug.match(/-(\d+)-bolum/i);
            var epNum = numMatch ? parseInt(numMatch[1]) : 1;

            return {
                meta: {
                    id: rawId,
                    type: 'tv',
                    name: title,
                    poster: poster,
                    background: poster,
                    description: title + ' - TvDiziler',
                    genres: ['Yerli Dizi', 'TvDiziler'],
                    videos: [{
                        id: rawId,
                        title: title,
                        season: 1,
                        episode: epNum
                    }]
                }
            };
        }

        if (rawId.startsWith('tvdiziler:show:')) {
            var showSlug = rawId.replace('tvdiziler:show:', '');
            var showUrl = BASE_URL + '/' + showSlug.replace(/^\/+/, '');
            var res = await safeFetch(showUrl, { headers: HEADERS });
            if (!res.ok) return { meta: null };
            var html = await res.text();

            var titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title>([^<]+)<\/title>/i);
            var rawTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'TvDiziler';
            var title = rawTitle.replace(/\s*\(?\d{4}\)?\s*$/i, '').trim() || rawTitle;

            var ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
            var poster = ogImg ? ogImg[1] : 'https://raw.githubusercontent.com/falsisdev/anthology/main/assets/logo_1_transparent.png';

            var ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
                           html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
            var description = ogDesc ? ogDesc[1] : (title + ' - TvDiziler Arşivi');

            var epRegex = /<a data-navigo class="truncate" href="([^"]+)">Bölüm <data[^>]*>([^<]+)<\/data><\/a>\s*<h6[^>]*>\s*<a[^>]*itemprop="name">([^<]+)<\/a>/gi;
            var videos = [];
            var seen = new Set();
            var em;

            while ((em = epRegex.exec(html)) !== null) {
                var href = em[1];
                if (seen.has(href)) continue;
                seen.add(href);

                var epNum = parseInt(em[2]) || 0;
                var epTitle = em[3].trim();

                var sMatch = epTitle.match(/(\d+)\s*\.?\s*sezon\s*(\d+)\s*\.?\s*bölüm/i);
                var season = 1;
                var episode = epNum;
                if (sMatch) {
                    season = parseInt(sMatch[1]);
                    episode = parseInt(sMatch[2]);
                }

                videos.push({
                    id: 'tvdiziler:ep:' + href,
                    title: epTitle || (epNum + '. Bölüm'),
                    season: season,
                    episode: episode
                });
            }

            if (videos.length === 0) {
                var fbRegex = /<a[^>]+href=["'](?:https:\/\/tvdiziler\.tv\/)?([a-zA-Z0-9_-]*bolum[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
                var fbm;
                while ((fbm = fbRegex.exec(html)) !== null) {
                    var href = fbm[1];
                    if (seen.has(href)) continue;
                    seen.add(href);
                    var epText = fbm[2].replace(/<[^>]+>/g, '').trim();
                    var numMatch = epText.match(/(\d+)\s*\.?\s*bölüm/i) || href.match(/-(\d+)-bolum/i);
                    var epNum = numMatch ? parseInt(numMatch[1]) : 1;
                    videos.push({
                        id: 'tvdiziler:ep:' + href,
                        title: epText || (epNum + '. Bölüm'),
                        season: 1,
                        episode: epNum
                    });
                }
            }

            videos.sort(function (a, b) { return (a.season - b.season) || (a.episode - b.episode); });

            return {
                meta: {
                    id: rawId,
                    type: 'tv',
                    name: title,
                    poster: poster,
                    background: poster,
                    description: description,
                    genres: ['Yerli Dizi', 'TvDiziler'],
                    videos: videos
                }
            };
        }

        return { meta: null };
    } catch (e) {
        return { meta: null };
    }
}

async function extractStreamsFromEpisodePage(epUrl) {
    try {
        var epRes = await safeFetch(epUrl, {
            headers: {
                'User-Agent': HEADERS['User-Agent'],
                'Referer': BASE_URL + '/'
            }
        });
        if (!epRes.ok) return [];
        var html = await epRes.text();
        var streams = [];
        var seenUrls = new Set();

        // 1. data-hhs and data-hs elements (JWPlayer ply endpoints, YouTube, and multi-parts)
        var btnRegex = /<[a-zA-Z0-9]+[^>]+(?:data-hhs|data-hs)=["']([^"']+)["'][^>]*>([\s\S]*?)<\/[a-zA-Z0-9]+>/gi;
        var bm;
        while ((bm = btnRegex.exec(html)) !== null) {
            var rawHhs = bm[1];
            var label = bm[2].replace(/<[^>]+>/g, '').trim() || 'Tek Parça';
            var parts = rawHhs.split(',').map(function (s) { return s.trim(); }).filter(Boolean);

            for (var item of parts) {
                // Case A: /vid/ply/
                if (item.startsWith('/vid/ply/') || item.includes('/vid/ply/')) {
                    var plyUrl = item.startsWith('http') ? item : (BASE_URL + (item.startsWith('/') ? '' : '/') + item);
                    try {
                        var plyRes = await safeFetch(plyUrl, {
                            headers: Object.assign({}, HEADERS, { Referer: epUrl })
                        });
                        if (plyRes.ok) {
                            var plyHtml = await plyRes.text();
                            var srcMatch = plyHtml.match(/sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+)["']/i) ||
                                             plyHtml.match(/file\s*:\s*["']([^"']+)["']/i);
                            if (srcMatch) {
                                var streamUrl = srcMatch[1].replace(/\\\/|\//g, function (m) { return m === '\\/' ? '/' : m; }).replace(/\\\//g, '/');
                                if (!seenUrls.has(streamUrl)) {
                                    seenUrls.add(streamUrl);
                                    var isHls = streamUrl.includes('.m3u8');
                                    var metadata = getDeclaredSourceMetadata(plyHtml, streamUrl);
                                    var quality = metadata.quality || getResolutionFromPath(streamUrl);

                                    var streamHeaders = {
                                        'User-Agent': HEADERS['User-Agent']
                                    };
                                    if (streamUrl.includes('twimg.com')) {
                                        streamHeaders['Referer'] = 'https://twitter.com/';
                                        streamHeaders['Origin'] = 'https://twitter.com';
                                    } else if (streamUrl.includes('ciner.com.tr')) {
                                        streamHeaders['Referer'] = 'https://www.ciner.com.tr/';
                                    } else {
                                        streamHeaders['Referer'] = BASE_URL + '/';
                                    }

                                    streams.push({
                                        name: 'TvDiziler',
                                        title: '⌜ TvDiziler ⌟ | ' + label + ' (' + (isHls ? 'HLS' : 'MP4') + (quality ? ' ' + quality : '') + ')',
                                        url: streamUrl,
                                        quality: quality,
                                        ...(metadata.language ? { language: metadata.language } : {}),
                                        format: isHls ? 'hls' : 'mp4',
                                        isHls: isHls,
                                        provider: 'tvdiziler',
                                        headers: streamHeaders,
                                        behaviorHints: {
                                            notWebReady: true,
                                            proxyHeaders: {
                                                request: streamHeaders
                                            }
                                        }
                                    });
                                }
                            }
                        }
                    } catch (e) {}
                }

                // Case B: YouTube
                var ytMatch = item.match(/(?:git\.php\?id=|v=|youtu\.be\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
                if (ytMatch) {
                    var ytId = ytMatch[1];
                    if (!seenUrls.has(ytId)) {
                        seenUrls.add(ytId);

                        var ytStream = await resolveYouTubeMp4(ytId);
                        if (ytStream && ytStream.url) {
                            var isHls = !!ytStream.isHls;
                            var fmt = ytStream.format || (isHls ? 'hls' : 'mp4');
                            var qualLabel = (isHls ? 'HLS' : 'MP4') + (ytStream.quality ? ' ' + ytStream.quality : '');
                            streams.push({
                                name: 'TvDiziler',
                                title: '⌜ TvDiziler ⌟ | ' + (label || 'YouTube') + ' (' + qualLabel + ')',
                                url: ytStream.url,
                                quality: ytStream.quality,
                                format: fmt,
                                isHls: isHls,
                                provider: 'tvdiziler',
                                headers: ytStream.headers,
                                behaviorHints: {
                                    notWebReady: true,
                                    proxyHeaders: {
                                        request: ytStream.headers
                                    }
                                }
                            });
                        }

                        // Native Stremio / Nuvio YouTube player fallback
                        streams.push({
                            name: 'TvDiziler',
                            title: '⌜ TvDiziler ⌟ | YouTube (' + (label || 'Resmi') + ')',
                            ytId: ytId,
                            provider: 'tvdiziler'
                        });
                    }
                }
            }
        }

        // 2. Direct iframes in page
        var ifrRegex = /<iframe[^>]+src=["']([^"']+)["']/gi;
        var im;
        while ((im = ifrRegex.exec(html)) !== null) {
            var src = im[1];
            if (src.startsWith('//')) src = 'https:' + src;
            var ytMatch = src.match(/(?:embed\/|v=)([a-zA-Z0-9_-]{11})/);
            if (ytMatch && !seenUrls.has(ytMatch[1])) {
                var ifrYtId = ytMatch[1];
                seenUrls.add(ifrYtId);

                var ifrYtStream = await resolveYouTubeMp4(ifrYtId);
                if (ifrYtStream && ifrYtStream.url) {
                    var ifrIsHls = !!ifrYtStream.isHls;
                    var ifrFmt = ifrYtStream.format || (ifrIsHls ? 'hls' : 'mp4');
                    var ifrQualLabel = (ifrIsHls ? 'HLS' : 'MP4') + (ifrYtStream.quality ? ' ' + ifrYtStream.quality : '');
                    streams.push({
                        name: 'TvDiziler',
                        title: '⌜ TvDiziler ⌟ | YouTube (' + ifrQualLabel + ')',
                        url: ifrYtStream.url,
                        quality: ifrYtStream.quality,
                        format: ifrFmt,
                        isHls: ifrIsHls,
                        provider: 'tvdiziler',
                        headers: ifrYtStream.headers,
                        behaviorHints: {
                            notWebReady: true,
                            proxyHeaders: {
                                request: ifrYtStream.headers
                            }
                        }
                    });
                }

                streams.push({
                    name: 'TvDiziler',
                    title: '⌜ TvDiziler ⌟ | YouTube (Resmi)',
                    ytId: ifrYtId,
                    provider: 'tvdiziler'
                });
            }
        }

        return streams;
    } catch (e) {
        return [];
    }
}

async function getStreams(tmdbIdOrArgs, mediaType, seasonNum, episodeNum) {
    try {
        if (typeof tmdbIdOrArgs === 'object' && tmdbIdOrArgs && tmdbIdOrArgs.id) {
            return getStreams(tmdbIdOrArgs.id, mediaType || tmdbIdOrArgs.type, seasonNum || tmdbIdOrArgs.season, episodeNum || tmdbIdOrArgs.episode);
        }

        if (typeof tmdbIdOrArgs === 'string' && tmdbIdOrArgs.startsWith('tvdiziler:ep:')) {
            await cfgReady();
            var epSlug = tmdbIdOrArgs.replace('tvdiziler:ep:', '');
            var epUrl = BASE_URL + '/' + epSlug.replace(/^\/+/, '');
            var directStreams = await extractStreamsFromEpisodePage(epUrl);
            if (directStreams.length > 0) {
                diagnostic('result', { origin: 'direct_episode', count: directStreams.length });
            } else {
                diagnostic('empty_result', { reason: 'direct_episode_empty' });
            }
            return directStreams;
        }

        var id = tmdbIdOrArgs;
        var season = parseInt(seasonNum) || 1;
        var episode = parseInt(episodeNum) || 1;

        // Normalize Nuvio/CineMata id shapes: prefixes, colon season:episode, raw titles
        var nrm = normalizeSeriesId(id);
        if (nrm.season > 0) season = nrm.season;
        if (nrm.episode > 0) episode = nrm.episode;
        if (nrm.kind === 'title') id = nrm.id;
        else if (nrm.id) id = nrm.id;
        else if (typeof id === 'string' && id.includes(':')) {
            var parts = id.split(':');
            id = parts[0];
            if (parts.length >= 3) {
                season = parseInt(parts[1]) || season;
                episode = parseInt(parts[2]) || episode;
            }
        }

        var [info] = await Promise.all([resolveTmdbInfo(id, mediaType), cfgReady()]);
        var searchTitles = seriesSearchTitles(info);
        if (nrm.kind === 'title' && searchTitles.length === 0) searchTitles.push(String(id || '').trim());
        if (searchTitles.length === 0) {
            diagnostic('empty_result', { reason: 'missing_titles' });
            return [];
        }

        var cumEpisode = cumulativeEpisode(info.seasons, season, episode);

        for (var title of searchTitles) {
            var cleanQuery = cleanSeriesTitle(title);
            var cleanTarget = seriesKey(cleanQuery);
            if (!cleanTarget) continue;

            var results = await searchTvDiziler(cleanQuery);
            var titleMismatch = 0;
            let suffixMatch;
            var matchedShow = results.find(result => {
                const decoded = decodeSearchTitle(result.title);
                const candidateTitle = cleanSeriesTitle(decoded);
                const decodedKey = seriesKey(candidateTitle);
                if (decodedKey === cleanTarget) return true;

                const watchSuffix = candidateTitle.match(/\s+[iİ]zle$/i);
                const candidateKey = watchSuffix
                    ? seriesKey(cleanSeriesTitle(candidateTitle.slice(0, watchSuffix.index)))
                    : decodedKey;
                if (candidateKey === cleanTarget) {
                    if (!suffixMatch) suffixMatch = result;
                    return false;
                }

                titleMismatch++;
                return false;
            }) || suffixMatch;
            var missingSlug = matchedShow && !matchedShow.slug ? 1 : 0;
            diagnostic('series_match', {
                accepted: matchedShow && matchedShow.slug ? 1 : 0,
                rejected: titleMismatch + missingSlug,
                title_mismatch: titleMismatch,
                missing_slug: missingSlug
            });
            if (!matchedShow || !matchedShow.slug) continue;

            var seriesKeys = [cleanTarget, showSlugKey(matchedShow.slug)];

            var showUrl = BASE_URL + '/' + matchedShow.slug.replace(/^\/+/, '');
            var sRes = await safeFetch(showUrl, { headers: HEADERS });
            if (!sRes.ok) continue;
            var sHtml = await sRes.text();

            var epRegex = /<a data-navigo class="truncate" href="([^"]+)">Bölüm <data[^>]*>([^<]+)<\/data><\/a>\s*<h6[^>]*>\s*<a[^>]*itemprop="name">([^<]+)<\/a>/gi;
            var episodes = [];
            var em;
            while ((em = epRegex.exec(sHtml)) !== null) {
                episodes.push({
                    href: em[1],
                    epNum: Number(em[2]) || 0,
                    title: em[3].trim()
                });
            }

            if (episodes.length === 0) {
                var fbRegex = /<a[^>]+href=["'](?:https:\/\/tvdiziler\.tv\/)?(\/?[a-zA-Z0-9_-]*bolum[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
                var fbm;
                while ((fbm = fbRegex.exec(sHtml)) !== null) {
                    episodes.push({
                        href: fbm[1],
                        title: fbm[2].replace(/<[^>]+>/g, ' ').trim()
                    });
                }
            }

            var targetEp = matchEpisode(episodes, seriesKeys, season, episode, cumEpisode);

            if (targetEp) {
                var epUrl = BASE_URL + '/' + targetEp.href.replace(/^\/+/, '');
                var streams = await extractStreamsFromEpisodePage(epUrl);
                if (streams.length > 0) {
                    diagnostic('result', { origin: 'episode_list', count: streams.length });
                    return streams;
                }
            }
        }

        // Fallback: If no streams found from TvDiziler (e.g. video removed due to DMCA/telif like Son Yaz), search official YouTube full episode
        if (searchTitles.length > 0) {
            var mainTitle = searchTitles[0];
            var ytStreams = await resolveOfficialYouTubeFallback(mainTitle, season, episode, cumEpisode);
            if (ytStreams && ytStreams.length > 0) {
                diagnostic('result', { origin: 'youtube_fallback', count: ytStreams.length });
                return ytStreams;
            }
        }

        diagnostic('empty_result', { reason: 'no_streams' });
        return [];
    } catch (e) {
        diagnostic('empty_result', { reason: 'error' });
        return [];
    }
}

// ── Universal Quality Sorter ──────────────────────────────────────────
if (typeof getStreams === 'function') {
    var _origGetStreams = getStreams;
    getStreams = async function () {
        var res = await _origGetStreams.apply(this, arguments);
        return sortStreamsByQuality(res);
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = wrapAll({ getMeta: getMeta, getCatalog: getCatalog }, cfgReady);
    module.exports.getStreams = getStreams;
}
if (typeof globalThis !== 'undefined') {
    globalThis.getStreams = getStreams;
    globalThis.getMeta = getMeta;
    globalThis.getCatalog = getCatalog;
}
