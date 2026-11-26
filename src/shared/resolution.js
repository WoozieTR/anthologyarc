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
    return label;
}

module.exports = { getResolutionFromPath };
