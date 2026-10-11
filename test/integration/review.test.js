'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const helper = require('node-red-node-test-helper');
const nodes = require('../../nodes/hermes');
const catchNode = require('@node-red/nodes/core/common/25-catch.js');
helper.init(require.resolve('node-red'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t, target, queueConfig = {}) {
    const api = http.createServer((_req, res) => {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Rejected integration-review-secret' } }));
    });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => helper.startServer(resolve));
    t.after(async () => {
        await helper.unload();
        await new Promise(resolve => helper.stopServer(resolve));
        api.closeAllConnections();
        await new Promise(resolve => api.close(resolve));
    });
    const flow = [
        { id: 'tab', type: 'tab', label: 'Review tests' },
        { id: 'connection', type: 'hermes-connection', baseUrl: `http://127.0.0.1:${api.address().port}`, profile: 'work' },
        { id: 'queue', type: 'hermes-queue', pollInterval: 0.25, ...queueConfig },
        { id: 'target', z: 'tab', connection: 'connection', queue: 'queue', ...target },
        { id: 'caught-node', type: 'catch', z: 'tab', scope: ['target'], uncaught: false, wires: [['caught']] },
        { id: 'out', type: 'helper', z: 'tab' },
        { id: 'events', type: 'helper', z: 'tab' },
        { id: 'errors', type: 'helper', z: 'tab' },
        { id: 'caught', type: 'helper', z: 'tab' }
    ];
    await helper.load([nodes, catchNode], flow, { connection: { apiKey: 'integration-review-secret' } });
    return helper.getNode('target');
}

test('real Node-RED Prepare preserves existing bot attribution when mapping a name', { timeout: 15000 }, async t => {
    const target = await setup(t, { type: 'hermes-prepare', inputProperty: 'payload.text', authorNameProperty: 'payload.name', wires: [['out']] });
    const output = once(helper.getNode('out'), 'input');
    target.receive({ payload: { text: 'Hello', name: 'Renamed bot' }, hermes: { author: { id: 'bot-1', is_bot: true } } });
    const [message] = await output;
    assert.deepEqual(message.hermes.author, { id: 'bot-1', name: 'Renamed bot', is_bot: true });
});

test('real Node-RED Prepare maps boolean bot flags and sends one traced error for invalid flags', { timeout: 15000 }, async t => {
    const target = await setup(t, { type: 'hermes-prepare', inputProperty: 'payload.text', authorNameProperty: 'payload.name', authorIsBotProperty: 'payload.bot', wires: [['out']] });
    for (const flag of [true, false]) {
        const output = once(helper.getNode('out'), 'input');
        target.receive({ payload: { text: 'Hello', name: 'Author', bot: flag } });
        assert.equal((await output)[0].hermes.author.is_bot, flag);
    }
    let count = 0;
    helper.getNode('caught').on('input', () => { count++; });
    const caught = once(helper.getNode('caught'), 'input');
    target.receive({ _msgid: 'prepare-failure', payload: { text: 'Hello', name: 'Author', bot: 'false' } });
    const [message] = await caught;
    await wait(50);
    assert.equal(count, 1);
    assert.equal(message._msgid, 'prepare-failure');
    assert.equal(message.hermes.error.code, 'INVALID_INPUT');
    assert.equal(message.payload, null);
});

test('real Node-RED Agent reports one error output and one sanitized Catch notification', { timeout: 15000 }, async t => {
    const target = await setup(t, { type: 'hermes-agent', mode: 'async', wires: [['out'], ['events'], ['errors']] });
    let catches = 0;
    let errors = 0;
    helper.getNode('caught').on('input', () => { catches++; });
    helper.getNode('errors').on('input', () => { errors++; });
    const failure = once(helper.getNode('errors'), 'input');
    const caught = once(helper.getNode('caught'), 'input');
    target.receive({ _msgid: 'agent-failure', payload: 'Test denial', routing: { destination: 'client' } });
    const [[out], [trace]] = await Promise.all([failure, caught]);
    await wait(50);
    assert.equal(errors, 1);
    assert.equal(catches, 1);
    for (const message of [out, trace]) {
        assert.equal(message._msgid, 'agent-failure');
        assert.equal(message.hermes.error.code, 'HTTP_403');
        assert.equal(message.payload, null);
        assert.equal(message.routing.destination, 'client');
        assert.doesNotMatch(JSON.stringify(message), /integration-review-secret/);
    }
});

test('real Node-RED Control uses traced done(error) without duplicate Catch messages', { timeout: 15000 }, async t => {
    const target = await setup(t, { type: 'hermes-control', action: 'message', wires: [['out'], ['errors']] });
    let count = 0;
    helper.getNode('caught').on('input', () => { count++; });
    const failure = once(helper.getNode('errors'), 'input');
    const caught = once(helper.getNode('caught'), 'input');
    target.receive({ _msgid: 'control-failure', hermesControl: { action: 'not-supported' } });
    const [[out], [trace]] = await Promise.all([failure, caught]);
    await wait(50);
    assert.equal(count, 1);
    assert.equal(out.hermesControl.error.code, 'INVALID_ACTION');
    assert.equal(trace.hermesControl.error.code, 'INVALID_ACTION');
    assert.equal(trace._msgid, 'control-failure');
});

for (const [name, config, expected] of [
    ['legacy import', { requestTimeout: 47 }, 47000],
    ['new setting wins', { requestTimeout: 47, asyncRequestTimeout: 83 }, 83000]
]) {
    test(`real Node-RED Queue timeout: ${name}`, { timeout: 15000 }, async t => {
        await setup(t, { type: 'hermes-control', action: 'status', wires: [['out'], ['errors']] }, config);
        assert.equal(helper.getNode('queue').scheduler.requestTimeoutMs, expected);
    });
}
