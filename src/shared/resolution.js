function getResolutionFromPath(url) {
    const match = /^https?:\/\/[^/?#]+(\/[^?#]*)/i.exec(url);
    if (!match) return '';
    const indicators = /(?:^|[\/_.-])([1-9]\d{2,4}x)?(2160|1440|1080|720|540|480|360|240)(p)?(?=$|[\/_.-])/gi;
    let label = '';
    let indicator;
    while ((indicator = indicators.exec(match[1])) !== null) {
        const [, width, height, suffix] = indicator;
        if (!width && !suffix) continue;
        const candidate = height + 'p';
        if (label && label !== candidate) return '';
        label = candidate;
    }
    // Prefer explicit resolution markers over unqualified numeric hints.
    if (label) return label;

    // Only infer the common HD heights from a whole path segment or a
    // separated filename suffix. Never inspect query strings or fragments.
    const hints = /(?:\/(720|1080)(?=\/|$)|[-_](720|1080)(?=\.(?:mp4|mkv|webm|m4v|m3u8|mpd)$))/gi;
    let hint;
    while ((hint = hints.exec(match[1])) !== null) {
        const candidate = (hint[1] || hint[2]) + 'p';
        if (label && label !== candidate) return '';
        label = candidate;
    }
    return label;
}

// Read only declared metadata attached to an already-known media URL.
// No evaluation of remote script, no new requests, no inference of audio
// from the show's original language.
function getDeclaredSourceMetadata(text, url) {
    const result = { quality: '', language: '' };
    if (typeof text !== 'string' || typeof url !== 'string' || !url) return result;
    const objects = /\{[^{}]{0,4096}\}/g;
    const qualities = new Set();
    const languages = new Set();
    let object;
    while ((object = objects.exec(text)) !== null) {
        const fields = Object.create(null);
        const pairs = /(?:^|[,{])\s*["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?\s*:\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\d+)(?=\s*[,}]))/g;
        let pair;
        while ((pair = pairs.exec(object[0])) !== null) {
            fields[pair[1].toLowerCase()] = String(pair[2] ?? pair[3] ?? pair[4] ?? '').replace(/\\\//g, '/').trim();
        }
        if (fields.file !== url && fields.src !== url) continue;
        for (const key of ['label', 'quality', 'height']) {
            const value = fields[key] || '';
            const match = /^(2160|1440|1080|720|540|480|360|240)p?$/i.exec(value);
            if (match) qualities.add(match[1] + 'p');
        }
        const audio = (fields.audiolanguage || fields.audio_language || '').toLowerCase();
        const codes = { tr: 'TR', tur: 'TR', en: 'EN', eng: 'EN', de: 'DE', deu: 'DE', fr: 'FR', fra: 'FR', es: 'ES', spa: 'ES' };
        if (Object.prototype.hasOwnProperty.call(codes, audio)) languages.add(codes[audio]);
    }
    if (qualities.size === 1) result.quality = Array.from(qualities)[0];
    if (languages.size === 1) result.language = 'Ses: ' + Array.from(languages)[0];
    return result;
}

module.exports = { getResolutionFromPath, getDeclaredSourceMetadata };
