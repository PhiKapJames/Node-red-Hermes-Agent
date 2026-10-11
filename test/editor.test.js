'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('all five editor definitions have templates/help and shared credentials are password-only', () => {
    const html = fs.readFileSync(path.join(__dirname, '../nodes/hermes.html'), 'utf8');
    const code = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];
    const definitions = {};
    vm.runInNewContext(code, { RED: { nodes:{ registerType:(name, def) => { definitions[name] = def; } }, validators:{ number:() => value => Number.isFinite(Number(value)) } } });
    assert.equal(Object.keys(definitions).length, 5);
    for (const name of Object.keys(definitions)) {
        assert.ok(html.includes(`data-template-name="${name}"`)); assert.ok(html.includes(`data-help-name="${name}"`));
    }
    const connection = definitions['hermes-connection'];
    assert.equal(connection.category, 'config');
    assert.equal(connection.credentials.apiKey.type, 'password');
    assert.equal(Object.hasOwn(connection.defaults, 'apiKey'), false);
    assert.equal(definitions['hermes-agent'].defaults.connection.type, 'hermes-connection');
    assert.equal(definitions['hermes-agent'].defaults.queue.type, 'hermes-queue');
    assert.equal(definitions['hermes-agent'].outputs, 3);
});
test('runtime registers five nodes; credentials are not regular flow properties', () => {
    const definitions = {};
    require('../nodes/hermes')({ nodes:{ registerType:(name, constructor, options) => { definitions[name] = { constructor, options }; } } });
    assert.equal(Object.keys(definitions).length, 5);
    assert.deepEqual(definitions['hermes-connection'].options, { credentials:{ apiKey:{ type:'password' } } });
});
test('package core contains no application-specific radio defaults', () => {
    const files = ['nodes/hermes.js','nodes/hermes.html','lib/request.js','lib/queue.js'];
    for (const file of files) {
        const content = fs.readFileSync(path.join(__dirname,'..',file),'utf8');
        assert.doesNotMatch(content, /TellMe|channel_idx|pubkey_prefix|mc_global|West Meshter|MAX_BYTES\s*=\s*110/);
    }
});
