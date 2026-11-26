const { createMediaApiProvider } = require('../../src/shared/media_api_provider.js');

const configs = [
    {
        name: 'Sample A',
        apiOrigin: 'https://api.alpha.invalid',
        streamsPath: '/v1/streams',
        streamOrigins: ['https://media.alpha.invalid']
    },
    {
        name: 'Sample B',
        apiOrigin: 'https://api.beta.invalid:8443',
        streamsPath: '/catalog/playback',
        streamOrigins: ['https://media.beta.invalid:9443']
    }
];

module.exports = configs.map((config) => ({ config, provider: createMediaApiProvider(config) }));
