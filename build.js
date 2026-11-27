#!/usr/bin/env node

/**
 * Build script for Anthology Nuvio Providers
 * 
 * Bundles source providers and configured media API providers using esbuild.
 * 
 * Usage:
 *   node build.js              # Build all providers
 *   node build.js sinewix      # Build only sinewix
 *   node build.js --minify     # Build all with minification
 *   node build.js --watch      # Watch mode
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const pkg = require('./package.json');
const { mediaApiProviders } = require('./config.js');

const srcDir = path.join(__dirname, 'src');
const outDir = path.join(__dirname, 'providers');

// Modules provided by the Nuvio app runtime - do not bundle
const EXTERNAL_MODULES = [
    'cheerio-without-node-native',
    'react-native-cheerio',
    'cheerio',
    'crypto-js',
    'axios',
    'path',
    'fs'
];

// Special mapping for outputs that have subpaths
const OUTPUT_MAP = {
    'm3u_list': path.join(outDir, 'M3U', 'ListM3u.js')
};
const MEDIA_API_ENTRY = path.join(srcDir, 'shared', 'media_api_entry.js');
const MEDIA_API_FIELDS = new Set(['id', 'name', 'apiOrigin', 'streamsPath', 'streamOrigins', 'trustManualRedirects']);

function validateProviderId(id) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,251}$/.test(id) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(id)) {
        throw new TypeError(`Invalid provider ID: ${JSON.stringify(id)}`);
    }
}

function validateMediaApiOutput(outFile) {
    const root = fs.lstatSync(outDir, { throwIfNoEntry: false });
    if (!root) return;
    if (!root.isDirectory()) throw new TypeError('Unsafe media API output path: providers/');

    const target = fs.lstatSync(outFile, { throwIfNoEntry: false });
    if (target && (!target.isFile() || target.nlink > 1)) {
        throw new TypeError(`Unsafe media API output path: ${path.relative(__dirname, outFile)}`);
    }
}

function registerMediaApiProviders(sourceProviders) {
    if (!Array.isArray(mediaApiProviders)) throw new TypeError('mediaApiProviders must be an array');

    const registered = new Map();
    if (mediaApiProviders.length === 0) return registered;

    const { createMediaApiProvider } = require('./src/shared/media_api_provider.js');
    const reserved = new Set(['shared', ...Object.keys(OUTPUT_MAP), ...sourceProviders.map(id => id.toLowerCase())]);
    for (const [index, definition] of mediaApiProviders.entries()) {
        if (!definition || typeof definition !== 'object' || Array.isArray(definition) ||
            Object.keys(definition).some(key => !MEDIA_API_FIELDS.has(key))) {
            throw new TypeError(`Invalid mediaApiProviders[${index}] definition or unsupported field`);
        }
        const { id, ...config } = definition;
        validateProviderId(id);
        if (reserved.has(id) || registered.has(id)) throw new TypeError(`Duplicate or reserved provider ID: ${id}`);
        try {
            createMediaApiProvider(config);
        } catch (err) {
            throw new TypeError(`Invalid media API configuration for ${id}: ${err.message}`);
        }

        // A validated ID always produces one filename directly under providers/.
        const outFile = path.join(outDir, `${id}.js`);
        validateMediaApiOutput(outFile);
        registered.set(id, { config, outFile });
    }
    return registered;
}

async function buildProvider(providerName, options, mediaApi) {
    const entryPoint = mediaApi ? MEDIA_API_ENTRY : path.join(srcDir, providerName, 'index.js');
    const outFile = mediaApi ? mediaApi.outFile :
        (Object.hasOwn(OUTPUT_MAP, providerName) ? OUTPUT_MAP[providerName] : path.join(outDir, `${providerName}.js`));
    const entryLabel = path.relative(__dirname, entryPoint).split(path.sep).join('/');

    if (!fs.existsSync(entryPoint)) {
        console.warn(`⚠️  Skipping ${providerName}: no ${entryLabel} found`);
        return false;
    }

    try {
        if (mediaApi) validateMediaApiOutput(outFile);
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        await esbuild.build({
            entryPoints: [entryPoint],
            ...(mediaApi && { define: { MEDIA_API_PROVIDER_CONFIG: JSON.stringify(mediaApi.config) } }),
            bundle: true,
            outfile: outFile,
            format: 'cjs',
            platform: 'neutral',
            target: 'es2016',
            minify: options.minify || false,
            sourcemap: false,
            external: EXTERNAL_MODULES,
            banner: {
                js: `/**
 * Anthology Provider: ${providerName}
 * Built from ${entryLabel}
 * Build: v${pkg.version} (anthology build system)
 */`
            },
            footer: {
                js: `\nif (typeof globalThis !== 'undefined' && typeof module !== 'undefined' && module.exports) {\n    if (module.exports.getStreams) globalThis.getStreams = module.exports.getStreams;\n    if (module.exports.getCatalog) globalThis.getCatalog = module.exports.getCatalog;\n    if (module.exports.getMeta) globalThis.getMeta = module.exports.getMeta;\n    if (module.exports.getSubtitles) globalThis.getSubtitles = module.exports.getSubtitles;\n}\n`
            },
            logLevel: 'warning'
        });

        const stats = fs.statSync(outFile);
        const sizeKB = (stats.size / 1024).toFixed(1);
        const minifyIndicator = options.minify ? ' (minified)' : '';
        console.log(`✅ ${providerName} -> ${path.relative(__dirname, outFile)} (${sizeKB} KB)${minifyIndicator}`);
        return true;
    } catch (err) {
        console.error(`❌ Failed to build ${providerName}:`, err.message);
        return false;
    }
}

async function main() {
    const args = process.argv.slice(2);
    const shouldMinify = args.includes('--minify');
    const isWatch = args.includes('--watch');

    const selected = args.filter(arg => !arg.startsWith('-'));
    for (const id of selected) validateProviderId(id);
    if (new Set(selected).size !== selected.length) throw new TypeError('Duplicate provider ID in build arguments');

    const sourceProviders = fs.readdirSync(srcDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== 'shared')
        .map(d => d.name);
    const mediaApis = registerMediaApiProviders(sourceProviders);
    const providers = selected.length ? selected : [...sourceProviders, ...mediaApis.keys()];
    const build = id => buildProvider(id, { minify: shouldMinify }, mediaApis.get(id));

    if (providers.length === 0) {
        console.log('No providers found in src/ directory.');
        return;
    }

    const minifyLabel = shouldMinify ? ' (minified)' : '';
    console.log(`\n📦 Building ${providers.length} provider(s)${minifyLabel}...\n`);

    let success = 0;
    let failed = 0;

    for (const provider of providers) {
        const result = await build(provider);
        if (result) success++;
        else failed++;
    }

    console.log(`\n✨ Done! ${success} built, ${failed} failed\n`);

    if (!isWatch && failed > 0) process.exitCode = 1;

    if (isWatch) {
        console.log('👀 Watching src/ for changes... (Press Ctrl+C to stop)');
        fs.watch(srcDir, { recursive: true }, (eventType, filename) => {
            if (filename && filename.endsWith('.js')) {
                console.log(`🔄 Change detected in ${filename}, rebuilding...`);
                const parts = filename.split(path.sep);
                if (parts[0] === 'shared') {
                    // Rebuild all
                    for (const p of providers) build(p);
                } else if (parts[0]) {
                    build(parts[0]);
                }
            }
        });
    }
}

main().catch(err => {
    console.error('Build error:', err);
    process.exit(1);
});
