const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('provider build exits nonzero when any provider fails', (t) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'anthology-build-'));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

    const root = path.resolve(__dirname, '..');
    for (const file of ['build.js', 'config.js', 'package.json']) {
        fs.copyFileSync(path.join(root, file), path.join(fixture, file));
    }
    fs.writeFileSync(path.join(fixture, 'config.json'), '{}');
    const modules = path.dirname(path.dirname(require.resolve('esbuild/package.json')));

    fs.mkdirSync(path.join(fixture, 'src', 'valid'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'src', 'valid', 'index.js'), 'module.exports = {};');
    fs.mkdirSync(path.join(fixture, 'src', 'broken'));
    fs.writeFileSync(path.join(fixture, 'src', 'broken', 'index.js'), 'const invalid = ;');

    function checkBuild(providers, expectedStatus, summary) {
        const result = spawnSync(process.execPath, ['build.js', ...providers], {
            cwd: fixture,
            encoding: 'utf8',
            env: { ...process.env, NODE_PATH: modules },
            timeout: 10_000
        });

        assert.ifError(result.error);
        assert.match(result.stdout, summary);
        assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    }

    checkBuild(['valid'], 0, /1 built, 0 failed/);
    checkBuild(['missing'], 1, /0 built, 1 failed/);
    checkBuild(['broken', 'valid'], 1, /1 built, 1 failed/);
});
