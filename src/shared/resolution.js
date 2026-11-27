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

module.exports = { getResolutionFromPath };
