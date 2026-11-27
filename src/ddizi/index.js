const { sortStreamsByQuality } = require("../shared/quality.js");
const { getResolutionFromPath, getDeclaredSourceMetadata } = require("../shared/resolution.js");
const { loadConfig, val, wrapAll } = require("../shared/config.js");
const { timeoutSignal } = require("../shared/http.js");
const { normalizeSeriesId, seriesSearchTitles, resolveSeriesInfo, asciiFold } = require("../shared/turkish_series.js");

var _cfgReady = null;
function cfgReady() {
    if (!_cfgReady) {
        _cfgReady = loadConfig().then(function () {
            var v;
            v = val('urls.series.ddizi.base'); if (v && String(v).indexOf('ddizi.im') === -1) BASE_URL = String(v).replace(/\/+$/, '');
            if (HEADERS) HEADERS.Referer = BASE_URL + '/';
        });
    }
    return _cfgReady;
}

/**
 * Anthology - DDizi Provider
 * Yerli dizi arşivi, güncel bölümler kataloğu ve doğrudan Ciner/Yandex CDN MP4/HLS ve resmi yayın akışları.
 */

var BASE_URL = 'https://www.ddizi.tel';
var TMDB_API_KEY = '500330721680edb6d5f7f12ba7cd9023';

var HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': BASE_URL + '/'
};

async function resolveYouTubeMp4(ytId) {
    try {
        const key = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
        const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${key}`, {
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
            }),
            signal: timeoutSignal(3500)
        });

        if (res.ok) {
            const data = await res.json();
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
                    const formats = data.streamingData.formats.filter(f => f.url && (f.mimeType || '').includes('mp4'));
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

function getValidTmdbKey() {
    if (typeof TMDB_API_KEY === 'string' && TMDB_API_KEY.length === 32 && !TMDB_API_KEY.startsWith('http')) {
        return TMDB_API_KEY;
    }
    return '500330721680edb6d5f7f12ba7cd9023';
}

// Use the same title/episode adjacency rules as YouTube Dizifilm.
function matchesYouTubeEpisode(videoTitle, title, season, episode, cumEpisode) {
    const normalized = asciiFold(videoTitle);
    const series = asciiFold(title).match(/[a-z0-9]+/g);
    if (!series) return false;

    const separator = '[^a-z0-9]*';
    const seasonMarker = '([1-9]\\d?)\\s*\\.?\\s*(?:sezon|season)';
    const labeledSeason = normalized.match(new RegExp('(?:^|[^0-9])' + seasonMarker + '\\b'));
    if (labeledSeason && Number(labeledSeason[1]) !== season) return false;

    // Without a season label, use the cumulative number when TMDB provides it.
    if (!labeledSeason && cumEpisode === null) return false;
    const num = labeledSeason
        ? (cumEpisode !== null && episode !== cumEpisode ? '(?:' + episode + '|' + cumEpisode + ')' : episode)
        : cumEpisode;
    const episodeLabel = '(?:' + num + '\\s*\\.?\\s*(?:bolumu?|episode|ep|b)' +
        '|(?:bolumu?|episode|ep)\\s*[:#-]?\\s*' + num + '|b' + num + ')(?![a-z0-9])';
    const seriesLabel = series.join('[^a-z0-9]+');
    const seasonLabel = '(?:' + seasonMarker + separator + ')?';
    const titleFirst = new RegExp('(?:^|[|–—])' + separator + seriesLabel + separator + seasonLabel + episodeLabel);
    const episodeFirst = new RegExp('^' + separator + seasonLabel + episodeLabel +
        separator + seriesLabel + '(?:' + separator + '$|\\s*[|–—-])');
    return titleFirst.test(normalized) || episodeFirst.test(normalized);
}

function logResultOrigin(origin) {
    if (typeof console !== 'undefined' && typeof console.log === 'function') {
        console.log('[DDizi] result origin=' + origin);
    }
}

async function resolveOfficialYouTubeFallback(searchTitles, season, episode, cumEpisode) {
    const title = searchTitles[0];
    try {
        const queries = [];
        if (season > 1) {
            queries.push(`${title} ${season}. Sezon ${episode}. Bölüm`);
            if (cumEpisode && cumEpisode !== episode) {
                queries.push(`${title} ${cumEpisode}. Bölüm`);
            }
        }
        queries.push(`${title} ${episode}. Bölüm`);

        const key = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
        for (const query of queries) {
            try {
                const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
                    headers: {
                        'User-Agent': HEADERS['User-Agent']
                    },
                    signal: timeoutSignal(3500)
                });
                if (!res.ok) continue;
                const html = await res.text();
                const vidMatches = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)].map(m => m[1]);
                const uniqueVids = [...new Set(vidMatches)].slice(0, 3);

                for (const ytId of uniqueVids) {
                    try {
                        const pRes = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${key}`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'
                            },
                            body: JSON.stringify({
                                context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
                                videoId: ytId
                            }),
                            signal: timeoutSignal(3000)
                        });
                        if (!pRes.ok) continue;
                        const data = await pRes.json();
                        const duration = parseInt((data.videoDetails && data.videoDetails.lengthSeconds) || '0');
                        const vTitle = (data.videoDetails && data.videoDetails.title) || '';

                        // Duration must be at least 15 minutes (900 seconds) for a full episode
                        if (duration >= 900 && searchTitles.some(name => matchesYouTubeEpisode(vTitle, name, season, episode, cumEpisode))) {
                            const streams = [];
                            if (data.streamingData && data.streamingData.hlsManifestUrl) {
                                streams.push({
                                    name: 'DDizi',
                                    title: `⌜ DDizi ⌟ | Resmi YouTube HLS (${vTitle.slice(0, 50)})`,
                                    url: data.streamingData.hlsManifestUrl,
                                    quality: '',
                                    provider: 'ddizi',
                                    format: 'hls',
                                    isHls: true,
                                    headers: {
                                        'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'
                                    }
                                });
                            }
                            if (data.streamingData && data.streamingData.formats) {
                                const formats = data.streamingData.formats.filter(f => f.url && (f.mimeType || '').includes('mp4'));
                                if (formats.length > 0) {
                                    streams.push({
                                        name: 'DDizi',
                                        title: `⌜ DDizi ⌟ | Resmi YouTube MP4${formats[0].qualityLabel ? ' (' + formats[0].qualityLabel + ')' : ''}`,
                                        url: formats[0].url,
                                        quality: formats[0].qualityLabel || '',
                                        provider: 'ddizi',
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
                                name: 'DDizi',
                                title: `⌜ DDizi ⌟ | YouTube (${vTitle.slice(0, 50)})`,
                                ytId: ytId,
                                provider: 'ddizi'
                            });
                            if (streams.length > 0) return streams;
                        }
                    } catch (e) {}
                }
            } catch (e) {}
        }
    } catch (e) {}
    return null;
}

function ultraClean(str) {
    if (!str) return '';
    return str.toString().toLowerCase()
        .replace(/[ıİ]/g, 'i').replace(/[üÜ]/g, 'u').replace(/[öÖ]/g, 'o')
        .replace(/[şŞ]/g, 's').replace(/[ğĞ]/g, 'g').replace(/[çÇ]/g, 'c')
        .replace(/[^a-z0-9]/g, '')
        .trim();
}

function lastPathSegment(href) {
    return href.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop();
}

function seriesSlugKey(href) {
    return ultraClean(lastPathSegment(href).replace(/-(?:\d+-)?son-bolum(?:-|$).*$/i, '').replace(/-izle(?:-|$).*$/i, ''));
}

function parseEpisodeLink(href) {
    const slug = asciiFold(lastPathSegment(href));
    const match = slug.match(/^(.+?)-sezon-(\d+)-bolumu?-(\d+)(?:-|$)/) ||
        slug.match(/^(.+?)(?:-(\d+)-sezon)?-(\d+)-bolumu?(?:-|$)/);
    if (!match) return null;
    return { series: ultraClean(match[1]), season: Number(match[2]) || null, episode: Number(match[3]) };
}

async function resolveTmdbInfo(id, mediaType) {
    try {
        const info = await resolveSeriesInfo(id, mediaType, getValidTmdbKey());
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

async function getCatalog(args) {
    try {
        const query = (args && args.search) || (args && args.extra && args.extra.search) || (args && args.query) || '';
        let url = `${BASE_URL}/`;
        let options = { headers: HEADERS };

        if (query) {
            const form = new URLSearchParams();
            form.append('arama', query);
            url = `${BASE_URL}/arama/`;
            options = {
                method: 'POST',
                headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/x-www-form-urlencoded' }),
                body: form.toString()
            };
        }

        const res = await fetch(url, options);
        if (!res.ok) return { metas: [] };
        let html = await res.text();

        let metas = [];
        const seen = new Set();

        let seriesMatches = [...html.matchAll(/<a href="([^"]*\/diziler\/([^"]*))"[^>]*>([\s\S]*?)<\/a>/gi)];
        if (seriesMatches.length === 0 && !query) {
            try {
                const archRes = await fetch(`${BASE_URL}/eski.diziler`, { headers: HEADERS });
                if (archRes.ok) {
                    const archHtml = await archRes.text();
                    seriesMatches = [...archHtml.matchAll(/<a href="([^"]*\/diziler\/([^"]*))"[^>]*>([\s\S]*?)<\/a>/gi)];
                }
            } catch (e) {}
        }
        for (const m of seriesMatches) {
            const slug = m[2].replace(/\/$/, '');
            const title = m[3].replace(/<[^>]+>/g, '').trim();
            if (!slug || seen.has(slug) || title.length < 2) continue;
            seen.add(slug);

            metas.push({
                id: `ddizi:show:${slug}`,
                type: 'tv',
                name: title,
                poster: 'https://raw.githubusercontent.com/falsisdev/anthology/main/assets/logo_1_transparent.png',
                background: 'https://raw.githubusercontent.com/falsisdev/anthology/main/assets/logo_1_transparent.png',
                genres: ['Yerli Dizi', 'DDizi'],
                description: `${title} - DDizi Yerli Dizi Arşivi`
            });
        }

        if (query) {
            const cleanQuery = ultraClean(query);
            const filtered = metas.filter(m => ultraClean(m.name).includes(cleanQuery) || ultraClean(m.id).includes(cleanQuery));
            if (filtered.length > 0) {
                metas = filtered;
            }
        }

        // Fetch posters for first 15 shows in parallel
        const topShows = metas.slice(0, 15);
        await Promise.all(topShows.map(async s => {
            try {
                const sSlug = s.id.replace('ddizi:show:', '');
                const sRes = await fetch(`${BASE_URL}/diziler/${sSlug}`, { headers: HEADERS });
                if (sRes.ok) {
                    const sHtml = await sRes.text();
                    const pMatch = sHtml.match(/class="[^"]*(?:dizi-resmi|img-back-cat)[^"]*"[\s\S]*?(?:data-src|src)="([^"]*)"/i);
                    if (pMatch) {
                        const pUrl = pMatch[1].startsWith('http') ? pMatch[1] : `${BASE_URL}${pMatch[1]}`;
                        s.poster = pUrl;
                        s.background = pUrl;
                    }
                }
            } catch (e) {}
        }));

        return { metas };
    } catch (e) {
        return { metas: [] };
    }
}

async function getMeta(args) {
    try {
        const rawId = (typeof args === 'string') ? args : (args && args.id ? args.id : '');
        if (!rawId) return { meta: null };

        if (rawId.startsWith('ddizi:ep:')) {
            const epSlug = rawId.replace('ddizi:ep:', '');
            const epUrl = `${BASE_URL}/izle/${epSlug}`;
            const res = await fetch(epUrl, { headers: HEADERS });
            if (!res.ok) return { meta: null };
            const html = await res.text();

            const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title>([^<]+)<\/title>/i);
            const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s*izle\s*$/i, '').trim() : 'DDizi Bölüm';

            const posterMatch = html.match(/class="[^"]*(?:dizi-resmi|img-back-cat)[^"]*"[\s\S]*?(?:data-src|src)="([^"]*)"/i);
            const poster = posterMatch ? (posterMatch[1].startsWith('http') ? posterMatch[1] : `${BASE_URL}${posterMatch[1]}`) : 'https://raw.githubusercontent.com/falsisdev/anthology/main/assets/logo_1_transparent.png';

            const epNumMatch = title.match(/(\d+)\s*\.?\s*bölüm/i);
            const epNum = epNumMatch ? parseInt(epNumMatch[1]) : 1;

            return {
                meta: {
                    id: rawId,
                    type: 'tv',
                    name: title,
                    poster,
                    background: poster,
                    description: `${title} - DDizi`,
                    genres: ['Yerli Dizi', 'DDizi'],
                    videos: [{
                        id: rawId,
                        title,
                        season: 1,
                        episode: epNum
                    }]
                }
            };
        }

        if (rawId.startsWith('ddizi:show:')) {
            const showSlug = rawId.replace('ddizi:show:', '');
            const showUrl = `${BASE_URL}/diziler/${showSlug}`;
            const res = await fetch(showUrl, { headers: HEADERS });
            if (!res.ok) return { meta: null };
            const html = await res.text();

            const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title>([^<]+)<\/title>/i);
            const rawTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s*son\s*bölüm\s*izle.*$/i, '').replace(/\s*\|.*$/i, '').trim() : 'DDizi';
            const title = rawTitle.replace(/\s*Full\s*.*$/i, '').trim() || rawTitle;

            const posterMatch = html.match(/class="[^"]*(?:dizi-resmi|img-back-cat)[^"]*"[\s\S]*?(?:data-src|src)="([^"]*)"/i);
            const poster = posterMatch ? (posterMatch[1].startsWith('http') ? posterMatch[1] : `${BASE_URL}${posterMatch[1]}`) : 'https://raw.githubusercontent.com/falsisdev/anthology/main/assets/logo_1_transparent.png';

            const pageLinks = [...html.matchAll(/href="([^"]*sayfa-\d+)"/g)];
            const pagesToFetch = [];
            for (const p of pageLinks) {
                const pUrl = p[1].startsWith('http') ? p[1] : `${BASE_URL}${p[1].startsWith('/') ? '' : '/'}${p[1]}`;
                if (!pagesToFetch.includes(pUrl) && pUrl !== showUrl) {
                    pagesToFetch.push(pUrl);
                }
            }

            let allHtmls = [html];
            for (const pUrl of pagesToFetch) {
                try {
                    const pRes = await fetch(pUrl, { headers: HEADERS });
                    if (pRes.ok) allHtmls.push(await pRes.text());
                } catch (e) {}
            }

            const epMatches = [];
            for (const phtml of allHtmls) {
                epMatches.push(...phtml.matchAll(/<a href="([^"]*\/izle\/([^"]*))"[^>]*>([\s\S]*?)<\/a>/gi));
            }

            const videos = [];
            const seen = new Set();

            const seriesKeys = [seriesSlugKey(showSlug), ultraClean(title)].filter(Boolean);

            for (const ep of epMatches) {
                const epSlug = ep[2];
                if (!epSlug || seen.has(epSlug)) continue;

                const link = parseEpisodeLink(ep[1]);
                if (!link || !seriesKeys.includes(link.series)) continue;

                seen.add(epSlug);
                const epTitle = ep[3].replace(/<[^>]+>/g, '').trim();
                const epNumMatch = epTitle.match(/(\d+)\s*\.?\s*bölüm/i);
                const epNum = epNumMatch ? parseInt(epNumMatch[1]) : link.episode;

                videos.push({
                    id: `ddizi:ep:${epSlug.replace(/\/$/, '')}`,
                    title: epTitle || `${epNum}. Bölüm`,
                    season: 1,
                    episode: epNum
                });
            }

            videos.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));

            return {
                meta: {
                    id: rawId,
                    type: 'tv',
                    name: title,
                    poster,
                    background: poster,
                    description: `${title} - DDizi Dizi Arşivi`,
                    genres: ['Yerli Dizi', 'DDizi'],
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
        const epRes = await fetch(epUrl, { headers: HEADERS });
        if (!epRes.ok) return [];
        const epHtml = await epRes.text();

        const iframes = [...epHtml.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)];
        const streams = [];
        const origins = new Set();

        for (const ifr of iframes) {
            let src = ifr[1];
            if (src.startsWith('//')) src = 'https:' + src;
            else if (src.startsWith('/')) src = BASE_URL + src;

            // Type 1: Direct player (Ciner CDN, Yandex, etc.)
            if (src.includes('/player/oynat/')) {
                const pRes = await fetch(src, { headers: { ...HEADERS, Referer: epUrl } });
                if (!pRes.ok) continue;
                const pHtml = await pRes.text();

                const videoMatches = [
                    ...[...pHtml.matchAll(/https?:\/\/[^\s"'<>\\]+\.(?:mp4|m3u8)[^\s"'<>\\]*/gi)].map(m => m[0]),
                    ...[...pHtml.matchAll(/file\s*:\s*["'](https?:\\\/\\\/[^"']+|https?:[^"']+)["']/gi)].map(m => m[1].replace(/\\\//g, '/'))
                ];
                const seenStreamUrls = new Set();
                for (const rawVUrl of videoMatches) {
                    const vUrl = rawVUrl.trim();
                    if (!vUrl || seenStreamUrls.has(vUrl)) continue;
                    seenStreamUrls.add(vUrl);
                    if (vUrl.includes('preview/') || vUrl.includes('image/') || vUrl.includes('.svg') || vUrl.includes('.jpg') || vUrl.includes('.png')) continue;

                    const metadata = getDeclaredSourceMetadata(pHtml, vUrl);
                    const quality = metadata.quality || getResolutionFromPath(vUrl);

                    let server = 'CDN';
                    let streamHeaders = { 'User-Agent': HEADERS['User-Agent'] };
                    if (vUrl.includes('googlevideo')) {
                        const durMatch = vUrl.match(/[?&]dur=([0-9.]+)/);
                        if (durMatch && parseFloat(durMatch[1]) < 300) continue;
                        server = 'Google Direct';
                    } else if (vUrl.includes('ciner.com.tr')) {
                        server = 'Ciner CDN';
                        streamHeaders['Referer'] = 'https://www.ciner.com.tr/';
                    } else if (vUrl.includes('yandex')) {
                        server = 'Yandex';
                        streamHeaders['Referer'] = 'https://yadi.sk/';
                    } else if (vUrl.includes('twimg')) {
                        server = 'Fast CDN';
                        streamHeaders['Referer'] = 'https://twitter.com/';
                        streamHeaders['Origin'] = 'https://twitter.com';
                    } else if (vUrl.includes('tabii.com')) {
                        server = 'Tabii CDN';
                        streamHeaders['Referer'] = 'https://www.tabii.com/';
                    } else if (vUrl.includes('akamaized')) {
                        server = 'Akamai';
                        streamHeaders['Referer'] = src;
                    } else {
                        streamHeaders['Referer'] = src;
                    }

                    // Keep master.m3u8 intact for ExoPlayer adaptive sync (prevents 3s chunk freezing)
                    var isMp4 = vUrl.toLowerCase().includes('.mp4');
                    var isHls = !isMp4;
                    origins.add('episode-direct');
                    streams.push({
                        name: 'DDizi',
                        title: `⌜ DDizi ⌟ | ${server} (${quality ? quality + ' ' : ''}${isMp4 ? 'MP4' : 'HLS'})`,
                        url: vUrl,
                        quality,
                        language: metadata.language,
                        provider: 'ddizi',
                        headers: streamHeaders,
                        format: isMp4 ? 'mp4' : 'hls',
                        isHls: isHls,
                        behaviorHints: {
                            notWebReady: true,
                            proxyHeaders: {
                                request: streamHeaders
                            }
                        }
                    });
                }
            }

            // Type 2: Dailymotion player
            if (src.includes('daily.php') || src.includes('dailymotion.com')) {
                const dmMatch = src.match(/(?:daily\.php\?id=|video\/)([a-zA-Z0-9]+)/);
                if (dmMatch) {
                    try {
                        const dmRes = await fetch(`https://www.dailymotion.com/player/metadata/video/${dmMatch[1]}`);
                        if (dmRes.ok) {
                            const dmData = await dmRes.json();
                            const autoQual = dmData.qualities && dmData.qualities.auto && dmData.qualities.auto[0];
                            if (autoQual && autoQual.url) {
                                const dmHeaders = {
                                    'User-Agent': HEADERS['User-Agent'],
                                    'Referer': 'https://www.dailymotion.com/'
                                };
                                origins.add('episode-dailymotion');
                                streams.push({
                                    name: 'DDizi',
                                    title: '⌜ DDizi ⌟ | Dailymotion (HLS)',
                                    url: autoQual.url,
                                    quality: '',
                                    provider: 'ddizi',
                                    headers: dmHeaders,
                                    format: 'hls',
                                    isHls: true,
                                    behaviorHints: {
                                        notWebReady: true,
                                        proxyHeaders: {
                                            request: dmHeaders
                                        }
                                    }
                                    });
                            }
                        }
                    } catch (e) {}
                }
            }

            // Type 3: Official YouTube player — extract direct MP4 stream via Innertube / Invidious, or provide native ytId
            if (src.includes('youtube.php') || src.includes('/player/telif/') || src.includes('youtube.com') || src.includes('youtu.be')) {
                const ytMatch = src.match(/(?:youtube\.php\?id=|v=|youtu\.be\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
                if (ytMatch) {
                    const ytId = ytMatch[1];
                    let foundDirectMp4 = false;

                    // 1. Direct Innertube Android MP4 (fast, official, IP-matched)
                    const ytStream = await resolveYouTubeMp4(ytId);
                    if (ytStream && ytStream.url) {
                        foundDirectMp4 = true;
                        const isHls = !!ytStream.isHls;
                        const fmt = ytStream.format || (isHls ? 'hls' : 'mp4');
                        const qualLabel = (isHls ? 'HLS' : 'MP4') + (ytStream.quality ? ' (' + ytStream.quality + ')' : '');
                        origins.add('episode-youtube-innertube');
                        streams.push({
                            name: 'DDizi',
                            title: `⌜ DDizi ⌟ | YouTube ${qualLabel}`,
                            url: ytStream.url,
                            quality: ytStream.quality,
                            provider: 'ddizi',
                            headers: ytStream.headers,
                            format: fmt,
                            isHls: isHls,
                            behaviorHints: {
                                notWebReady: true,
                                proxyHeaders: {
                                    request: ytStream.headers
                                }
                            }
                        });
                    }

                    // 2. Invidious fallback if Innertube did not resolve
                    if (!foundDirectMp4) {
                        const invInstances = [
                            'https://invidious.f5.si',
                            'https://inv.nadeko.net',
                            'https://invidious.nerdvpn.de'
                        ];
                        for (const inst of invInstances) {
                            try {
                                const invRes = await fetch(`${inst}/api/v1/videos/${ytId}?fields=formatStreams,title`, {
                                    headers: { 'User-Agent': HEADERS['User-Agent'] },
                                    signal: timeoutSignal(2500)
                                });
                                if (!invRes.ok) continue;
                                const invData = await invRes.json();
                                const formats = (invData.formatStreams || []).filter(f => f.url && f.container === 'mp4');
                                if (formats.length > 0) {
                                    formats.sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));
                                    for (const fmt of formats.slice(0, 1)) {
                                        const quality = fmt.qualityLabel || fmt.quality || '';
                                        const ytHeaders = { 'User-Agent': HEADERS['User-Agent'] };
                                        origins.add('episode-youtube-invidious');
                                        streams.push({
                                            name: 'DDizi',
                                            title: `⌜ DDizi ⌟ | YouTube MP4${quality ? ' (' + quality + ')' : ''}`,
                                            url: fmt.url,
                                            quality,
                                            provider: 'ddizi',
                                            headers: ytHeaders,
                                            format: 'mp4',
                                            isHls: false,
                                            behaviorHints: {
                                                notWebReady: true,
                                                proxyHeaders: {
                                                    request: ytHeaders
                                                }
                                            }
                                        });
                                    }
                                    break;
                                }
                            } catch (e) {}
                        }
                    }

                    // 3. Native Stremio / Nuvio YouTube player fallback
                    origins.add('episode-youtube-native');
                    streams.push({
                        name: 'DDizi',
                        title: '⌜ DDizi ⌟ | YouTube (Resmi Yayın)',
                        ytId: ytId,
                        provider: 'ddizi'
                    });
                }
            }
        }

        // Generic fallback: extract MP4/M3U8 from any iframe
        if (streams.length === 0) {
            for (const ifr of iframes) {
                let src = ifr[1];
                if (src.startsWith('//')) src = 'https:' + src;
                else if (src.startsWith('/')) src = BASE_URL + src;
                if (src.includes('youtube') || src.includes('youtu.be') || src.includes('daily')) continue;
                
                try {
                    const pRes = await fetch(src, { headers: { ...HEADERS, Referer: epUrl } });
                    if (!pRes.ok) continue;
                    const pHtml = await pRes.text();
                    
                    const videoMatches = [...pHtml.matchAll(/https?:\/\/[^\s"'<>\\]+\.(?:mp4|m3u8)[^\s"'<>\\]*/gi)];
                    for (const vm of videoMatches) {
                        const vUrl = vm[0].trim();
                        if (vUrl.includes('preview/') || vUrl.includes('.jpg') || vUrl.includes('.png')) continue;
                        const fallbackHeaders = { 'User-Agent': HEADERS['User-Agent'], 'Referer': src };
                        const isHls = vUrl.includes('.m3u8');
                        const metadata = getDeclaredSourceMetadata(pHtml, vUrl);
                        const quality = metadata.quality || getResolutionFromPath(vUrl);
                        origins.add('episode-generic-iframe');
                        streams.push({
                            name: 'DDizi',
                            title: `⌜ DDizi ⌟ | Alternatif Kaynak${quality ? ' (' + quality + ')' : ''}`,
                            url: vUrl,
                            quality,
                            language: metadata.language,
                            provider: 'ddizi',
                            headers: fallbackHeaders,
                            format: isHls ? 'hls' : 'mp4',
                            isHls: isHls,
                            behaviorHints: {
                                notWebReady: true,
                                proxyHeaders: {
                                    request: fallbackHeaders
                                }
                            }
                        });
                    }
                } catch (e) {}
            }
        }

        // Sort streams: Direct unbroken MP4s (Ciner, Yandex) first, then by resolution
        streams.sort((a, b) => {
            const aIsDirectMp4 = (a.url && a.url.includes('.mp4')) ? 1 : 0;
            const bIsDirectMp4 = (b.url && b.url.includes('.mp4')) ? 1 : 0;
            if (bIsDirectMp4 !== aIsDirectMp4) return bIsDirectMp4 - aIsDirectMp4;
            const aQ = parseInt(a.quality) || 0;
            const bQ = parseInt(b.quality) || 0;
            return bQ - aQ;
        });

        for (const origin of origins) logResultOrigin(origin);
        return streams;
    } catch (e) {
        return [];
    }
}

async function getStreams(tmdbIdOrArgs, mediaType, seasonNum, episodeNum) {
    try {
        if (typeof tmdbIdOrArgs === 'object' && tmdbIdOrArgs && tmdbIdOrArgs.id) {
            return getStreams(
                tmdbIdOrArgs.id,
                mediaType || tmdbIdOrArgs.type,
                seasonNum || tmdbIdOrArgs.season,
                episodeNum || tmdbIdOrArgs.episode
            );
        }

        if (typeof tmdbIdOrArgs === 'string' && tmdbIdOrArgs.startsWith('ddizi:show:')) {
            await cfgReady();
            const showMeta = await getMeta(tmdbIdOrArgs);
            if (showMeta && showMeta.meta && Array.isArray(showMeta.meta.videos) && showMeta.meta.videos.length > 0) {
                return await getStreams(showMeta.meta.videos[0].id);
            }
        }

        if (typeof tmdbIdOrArgs === 'string' && tmdbIdOrArgs.startsWith('ddizi:ep:')) {
            await cfgReady();
            const slug = tmdbIdOrArgs.replace('ddizi:ep:', '');
            const epUrl = `${BASE_URL}/izle/${slug}`;
            return await extractStreamsFromEpisodePage(epUrl);
        }

        let id = tmdbIdOrArgs;
        let season = parseInt(seasonNum) || 1;
        let episode = parseInt(episodeNum) || 1;

        // Normalize Nuvio/CineMata id shapes: prefixes, colon season:episode, raw titles
        const nrm = normalizeSeriesId(id);
        if (nrm.season > 0) season = nrm.season;
        if (nrm.episode > 0) episode = nrm.episode;
        if (nrm.kind === 'title') id = nrm.id;
        else if (nrm.id) id = nrm.id;
        else if (typeof id === 'string' && id.includes(':')) {
            const parts = id.split(':');
            id = parts[0];
            if (parts.length >= 3) {
                season = parseInt(parts[1]) || season;
                episode = parseInt(parts[2]) || episode;
            }
        }

        const [info] = await Promise.all([resolveTmdbInfo(id, mediaType || 'tv'), cfgReady()]);
        const searchTitles = seriesSearchTitles(info);
        if (nrm.kind === 'title' && searchTitles.length === 0) searchTitles.push(String(id || '').trim());
        if (searchTitles.length === 0) return [];

        let cumEpisode = episode;
        if (season > 1) {
            const seasons = Array.isArray(info.seasons) ? info.seasons : [];
            for (let s = 1; s < season; s++) {
                const previous = seasons.find(entry => entry && entry.season_number === s);
                if (!previous || !Number.isInteger(previous.episode_count) || previous.episode_count <= 0) {
                    cumEpisode = null;
                    break;
                }
                cumEpisode += previous.episode_count;
            }
        }

        const candidateNums = cumEpisode !== null && cumEpisode !== episode ? [cumEpisode, episode] : [episode];

        for (const title of searchTitles) {
            const form = new URLSearchParams();
            form.append('arama', title);

            const sRes = await fetch(`${BASE_URL}/arama/`, {
                method: 'POST',
                headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/x-www-form-urlencoded' }),
                body: form.toString()
            });
            if (!sRes.ok) continue;
            const sHtml = await sRes.text();

            const leftMatch = sHtml.match(/class=["']left_sidebar["'][^>]*>([\s\S]*?)class=["']right_sidebar["']/i);
            const contentToSearch = leftMatch ? leftMatch[1] : (sHtml.split(/class=["']right_sidebar["']/i)[0] || sHtml);

            const seriesMatches = [...contentToSearch.matchAll(/<a href="([^"]*\/diziler\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
            const cleanTarget = ultraClean(title);
            if (!cleanTarget) continue;

            const matchedShow = seriesMatches.find(sm => ultraClean(sm[2].replace(/<[^>]+>/g, '')) === cleanTarget) ||
                seriesMatches.find(sm => seriesSlugKey(sm[1]) === cleanTarget);
            if (!matchedShow) continue;

            let matchedShowHref = matchedShow[1];
            const seriesKeys = [cleanTarget, seriesSlugKey(matchedShowHref)].filter(Boolean);
            if (!matchedShowHref.startsWith('http')) matchedShowHref = `${BASE_URL}${matchedShowHref.startsWith('/') ? '' : '/'}${matchedShowHref}`;

            // Check pages (starting with main page, then sayfa-N if not found)
            const pagesToCheck = [matchedShowHref];
            const showRes = await fetch(matchedShowHref, { headers: HEADERS });
            if (!showRes.ok) continue;
            const showHtml = await showRes.text();

            const pageLinks = [...showHtml.matchAll(/href="([^"]*sayfa-(\d+)[^"]*)"/g)];
            const sortedPages = pageLinks.map(p => {
                let pUrl = p[1];
                if (!pUrl.startsWith('http')) pUrl = `${BASE_URL}${pUrl.startsWith('/') ? '' : '/'}${pUrl}`;
                return { url: pUrl, num: parseInt(p[2]) };
            }).sort((a, b) => b.num - a.num); // Check oldest pages first for early episodes
            for (const sp of sortedPages) {
                if (!pagesToCheck.includes(sp.url)) pagesToCheck.push(sp.url);
            }

            for (const pageUrl of pagesToCheck.slice(0, 30)) {
                const pRes = (pageUrl === matchedShowHref) ? { ok: true, text: () => Promise.resolve(showHtml) } : await fetch(pageUrl, { headers: HEADERS });
                if (!pRes.ok) continue;
                const pHtml = await pRes.text();

                const leftEpMatch = pHtml.match(/class=["']left_sidebar["'][^>]*>([\s\S]*?)class=["']right_sidebar["']/i);
                const pageContent = leftEpMatch ? leftEpMatch[1] : (pHtml.split(/class=["']right_sidebar["']/i)[0] || pHtml);

                const epMatches = [...pageContent.matchAll(/<a href="([^"]*\/izle\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
                if (epMatches.length === 0) continue;

                const links = [];
                for (const ep of epMatches) {
                    const identity = parseEpisodeLink(ep[1]);
                    if (!identity || !seriesKeys.includes(identity.series)) continue;

                    const label = asciiFold(ep[2].replace(/<[^>]+>/g, ' '));
                    const labeledSeason = label.match(/\b(\d+)\s*\.?\s*sezon\b/);
                    const labeledEpisode = label.match(/\b(\d+)\s*\.?\s*bolumu?\b/) ||
                        label.match(/\bbolumu?\s*[:#-]?\s*(\d+)\b/);
                    if (labeledSeason && Number(labeledSeason[1]) !== season) continue;
                    if (identity.season && identity.season !== season) continue;

                    const hasSeason = identity.season || labeledSeason;
                    if (labeledEpisode) {
                        const number = Number(labeledEpisode[1]);
                        // Different numbers need a verified cumulative/season-relative pair.
                        if (number !== identity.episode && (!hasSeason || !candidateNums.includes(number))) continue;
                    }

                    // Prefer the cumulative link. Local numbering needs explicit season evidence.
                    if (identity.episode === cumEpisode || (identity.episode === episode && hasSeason)) {
                        links.push({ href: ep[1], episode: identity.episode });
                    }
                }
                let targetEpUrl = null;
                for (const num of candidateNums) {
                    const match = links.find(link => link.episode === num);
                    if (match) {
                        targetEpUrl = match.href;
                        break;
                    }
                }

                if (targetEpUrl) {
                    if (!targetEpUrl.startsWith('http')) targetEpUrl = `${BASE_URL}${targetEpUrl.startsWith('/') ? '' : '/'}${targetEpUrl}`;
                    const streams = await extractStreamsFromEpisodePage(targetEpUrl);
                    if (streams.length > 0) return streams;
                }
            }
        }

        // Fallback: If no streams found from DDizi (e.g. video removed due to DMCA/telif like Son Yaz), search official YouTube full episode
        if (searchTitles.length > 0) {
            const ytStreams = await resolveOfficialYouTubeFallback(searchTitles, season, episode, cumEpisode);
            if (ytStreams && ytStreams.length > 0) {
                logResultOrigin('youtube-search');
                return ytStreams;
            }
        }

        return [];
    } catch (e) {
        return [];
    }
}

// ── Universal Quality Sorter ──────────────────────────────────────────
if (typeof getStreams === "function") {
    var _origGetStreams = getStreams;
    getStreams = async function() {
        var res = await _origGetStreams.apply(this, arguments);
        return sortStreamsByQuality(res);
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = wrapAll({ getMeta, getCatalog }, cfgReady);
    module.exports.getStreams = getStreams;
}
if (typeof globalThis !== 'undefined') {
    globalThis.getStreams = getStreams;
    globalThis.getMeta = getMeta;
    globalThis.getCatalog = getCatalog;
}
