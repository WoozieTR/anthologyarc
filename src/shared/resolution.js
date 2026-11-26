function getResolutionFromPath(url) {
    const match = /^https?:\/\/[^/?#]+(\/[^?#]*)/i.exec(url);
    if (!match) return '';
    const resolution = /(?:^|[\/_.-])(?:[1-9]\d{2,4}x)?(2160|1440|1080|720|540|480|360|240)p?(?=$|[\/_.-])/i.exec(match[1]);
    return resolution ? resolution[1] + 'p' : '';
}

module.exports = { getResolutionFromPath };
