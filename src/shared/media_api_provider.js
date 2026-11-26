const { timeoutSignal } = require('./http.js');
const { sortStreamsByQuality } = require('./quality.js');

function parseHttpsUrl(value) {
    if (typeof value !== 'string' ||
        !/^https:\/\/[^/@?]+(?:[/?]|$)/i.test(value) ||
        /[\x00-\x20\x7f\\#]/.test(value)) {
        throw new TypeError('Expected an absolute HTTPS URL without credentials or a fragment');
    }

    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) {
        throw new TypeError('Expected an absolute HTTPS URL without credentials');
    }
    return url;
}

function parseOrigin(value) {
    const url = parseHttpsUrl(value);
    if (value !== url.origin && value !== url.origin + '/') {
        throw new TypeError('Expected a canonical HTTPS origin');
    }
    return url.origin;
}

function parseId(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        return String(value);
    }
    if (typeof value !== 'string') return null;
    if (/^tt(?!0+$)\d{7,}$/.test(value)) return value;
    if (/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) return value;
    return null;
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createMediaApiProvider({ name, apiOrigin, streamsPath, streamOrigins }) {
    if (typeof name !== 'string' || !name.trim() ||
        !Array.isArray(streamOrigins) || streamOrigins.length === 0) {
        throw new TypeError('Expected a provider name and at least one stream origin');
    }

    const origin = parseOrigin(apiOrigin);
    if (typeof streamsPath !== 'string' || !streamsPath.startsWith('/') || streamsPath.startsWith('//')) {
        throw new TypeError('Expected an absolute endpoint path');
    }
    const endpoint = parseHttpsUrl(origin + streamsPath);
    if (endpoint.origin !== origin || endpoint.pathname !== streamsPath) {
        throw new TypeError('Expected a canonical endpoint path without a query');
    }
    const approvedOrigins = new Set(Array.from(streamOrigins, parseOrigin));

    async function getStreams(rawId, mediaType, season, episode) {
        const id = parseId(rawId);
        const type = mediaType === 'tv' ? 'series' : mediaType;
        if (!id || (type !== 'movie' && type !== 'series')) return [];
        if (type === 'series') {
            if (!Number.isSafeInteger(season) || season < 0 ||
                !Number.isSafeInteger(episode) || episode < 1) return [];
        } else if (season != null || episode != null) {
            return [];
        }

        try {
            const url = new URL(endpoint.href);
            url.searchParams.set('id', id);
            url.searchParams.set('type', type);
            if (type === 'series') {
                url.searchParams.set('season', String(season));
                url.searchParams.set('episode', String(episode));
            }

            const response = await fetch(url.href, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                credentials: 'omit',
                redirect: 'error',
                signal: timeoutSignal(10000)
            });
            if (!response || response.ok !== true || !Number.isInteger(response.status) ||
                response.status < 200 || response.status >= 300 ||
                response.redirected !== false || response.url !== url.href) return [];

            const contentType = response.headers.get('content-type');
            if (!contentType || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) return [];

            const body = await response.json();
            if (!isRecord(body) || body.id !== id || body.type !== type || !Array.isArray(body.streams)) {
                return [];
            }
            if (type === 'series' ? body.season !== season || body.episode !== episode
                : body.season != null || body.episode != null) return [];

            const streams = [];
            for (const stream of body.streams) {
                if (!isRecord(stream) || (stream.format !== 'hls' && stream.format !== 'mp4') ||
                    (stream.quality !== undefined && (typeof stream.quality !== 'string' || !stream.quality.trim())) ||
                    !approvedOrigins.has(parseHttpsUrl(stream.url).origin)) return [];

                const result = {
                    name,
                    title: stream.quality ? name + ' • ' + stream.quality : name,
                    url: stream.url,
                    format: stream.format,
                    isHls: stream.format === 'hls'
                };
                if (stream.quality !== undefined) result.quality = stream.quality;
                streams.push(result);
            }
            return sortStreamsByQuality(streams);
        } catch {
            return [];
        }
    }

    return { getStreams };
}

module.exports = { createMediaApiProvider };
