const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

// Inspect only the pure identity matcher. No external HTTP or media access.
const context = {
    module: { exports: {} },
    require: () => ({ wrapAll: x => x }),
    fetch: () => { throw new Error('Network access forbidden in identity audit'); }
};
runInNewContext(readFileSync(require.resolve('../src/trdiziizle/index.js'), 'utf8'), context);
const matches = context.verifyYouTubeTitleMatch;

test('accepts an explicitly matching synthetic season and episode', () => {
    assert.equal(matches('Example Series 2. Sezon 3. Bolum', 'Example Series', 2, 3), true);
});
test('rejects a different explicit episode number', () => {
    assert.equal(matches('Example Series 2. Sezon 30. Bolum', 'Example Series', 2, 3), false);
});
test('rejects an explicitly conflicting season for a season-one request', () => {
    assert.equal(matches('Example Series 2. Sezon 3. Bolum', 'Example Series', 1, 3), false);
});
test('rejects ambiguous season identity for a later-season request', () => {
    assert.equal(matches('Example Series 3. Bolum', 'Example Series', 2, 3), false);
});
