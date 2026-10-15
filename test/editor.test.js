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
test('the control editor gates approvals behind two explicit settings, all defaulted off', () => {
    const html = fs.readFileSync(path.join(__dirname, '../nodes/hermes.html'), 'utf8');
    const code = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];
    const definitions = {};
    vm.runInNewContext(code, { RED: { nodes:{ registerType:(name, def) => { definitions[name] = def; } }, validators:{ number:() => value => Number.isFinite(Number(value)) } } });
    const control = definitions['hermes-control'];
    // Existing nodes keep working unchanged, and a node saved before these fields existed, or a flow
    // JSON that never had them, resolves to these defaults: nothing allowed, nothing permitted.
    assert.equal(control.defaults.allowApprove.value, false);
    assert.equal(control.defaults.approvalChoices.value, '', 'no choice is permitted until the operator names one');
    assert.equal(control.defaults.action.value, 'status');
    assert.equal(definitions['hermes-queue'].defaults.includeApprovalPreview.value, false);
    // The editor can actually set each one, and the action is offered.
    assert.match(html, /<option value="approve">[^<]+<\/option>/);
    for (const id of ['node-input-allowApprove', 'node-input-approvalChoices', 'node-config-input-includeApprovalPreview']) {
        assert.match(html, new RegExp('id="' + id + '"'), id);
    }
    const help = html.match(/data-help-name="hermes-control">([\s\S]*?)<\/script>/)[1];
    // The palette help is the only description of the round trip, so it has to say what it is.
    assert.match(help, /approve/);
    assert.match(help, /<code>requestId<\/code>[\s\S]*<code>approvalRequestId<\/code>/);
    assert.match(help, /only the decision that is pending right now/);
    assert.match(help, /separate message/);
    assert.match(help, /persists server-side[\s\S]*not revocable/);
    // Every documented approval rule fails closed, so the help says so too.
    assert.match(help, /never uses the Connection[^<]*this node/);
    assert.match(help, /approval_not_pending/);
    assert.match(help, /is never retried/);
    // Force is the reset action's override and nothing else; the help must be literally true.
    assert.match(help, /<code>force<\/code> is the <code>reset<\/code> action's override/);
    // Task 2 finding: an absent upstream feature flag is reported as unsupported, and the help says so.
    assert.match(help, /flag the server does not report is reported as unsupported/);
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
test('the control editor adds probe with a trusted Connection and closed defaults', () => {
    const html = fs.readFileSync(path.join(__dirname, '../nodes/hermes.html'), 'utf8');
    const code = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];
    const definitions = {};
    vm.runInNewContext(code, { RED: { nodes:{ registerType:(name, def) => { definitions[name] = def; } }, validators:{ number:() => value => Number.isFinite(Number(value)) } } });
    const control = definitions['hermes-control'];
    // Existing nodes must keep working unchanged: probe is opt-in and never a default.
    assert.equal(control.defaults.action.value, 'status');
    assert.equal(control.defaults.allowForce.value, false);
    assert.equal(control.defaults.connection.type, 'hermes-connection');
    assert.equal(control.defaults.connection.required, false);
    assert.equal(control.defaults.target.value, 'capabilities');
    assert.match(html, /<option value="probe">[^<]+<\/option>/);
    const help = html.match(/data-help-name="hermes-control">([\s\S]*?)<\/script>/)[1];
    assert.match(help, /Probe/);
    assert.match(help, /never pauses the queue/);
    assert.match(help, /unsupported/);
    assert.match(help, /never accepts a URL, path or credential from msg/);
    // A probe node without a Connection must fail closed at runtime, not fall back to the
    // queue's Connection; that is covered by the real Node-RED 5 suite
    // ('real Node-RED 5: probe refuses to guess a server, a target or a queue').
});
