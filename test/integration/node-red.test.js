'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { startRuntime } = require('../support/runtime.cjs');

async function setup(t, target, options = {}) {
    const calls = [];
    const api = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
        calls.push({ url: req.url, method: req.method, headers: req.headers, body });
        res.setHeader('Content-Type', 'application/json');
        if (options.denied) { res.writeHead(403); res.end(JSON.stringify({ error: { message: 'Rejected fixture-only-key' } })); }
        else if (req.url.endsWith('/chat/completions')) res.end(JSON.stringify({ choices: [{ message: { content: 'Full answer.', reasoning_content: 'PRIVATE_REASONING' }, finish_reason: 'stop' }] }));
        else if (req.method === 'POST' && req.url.endsWith('/runs')) { res.statusCode = 202; res.end(JSON.stringify({ run_id: `run-${calls.length}`, status: 'started' })); }
        else res.end(JSON.stringify({ status: 'completed', output: 'Full answer.', reasoning_content: 'PRIVATE_REASONING' }));
    });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    t.after(async () => { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); });
    const flows = [
        { id: 'tab', type: 'tab', label: 'Isolated Node-RED 5 runtime' },
        { id: 'connection', type: 'hermes-connection', baseUrl: `http://127.0.0.1:${api.address().port}`, profile: 'work' },
        { id: 'queue', type: 'hermes-queue', pollInterval: 0.25, ...options.queue },
        { id: 'input', type: 'fixture-input', z: 'tab', wires: [[options.entry || 'target']] },
        { id: 'target', z: 'tab', connection: 'connection', queue: 'queue', ...target },
        ...(options.extra || []),
        { id: 'catch', type: 'catch', z: 'tab', scope: ['target'], uncaught: false, wires: [['caught']] },
        { id: 'complete', type: 'complete', z: 'tab', scope: ['target'], uncaught: false, wires: [['done']] },
        ...['out', 'events', 'errors', 'caught', 'done', 'controlOut'].map(id => ({ id, type: 'fixture-probe', z: 'tab' }))
    ];
    const runtime = await startRuntime(t, flows, { connection: { apiKey: 'fixture-only-key' } });
    return { runtime, calls, flows };
}

for (const mode of ['sync', 'async']) {
    test(`real Node-RED 5: Prepare -> ${mode} Agent, credentials, session and Complete`, { timeout: 30000 }, async t => {
        const { runtime, calls, flows } = await setup(t, { type: 'hermes-agent', mode, wires: [['out'], ['events'], ['errors']] }, {
            entry: 'prepare', extra: [{ id: 'prepare', type: 'hermes-prepare', z: 'tab', inputProperty: 'payload.text', clientProperty: 'payload.id', authorNameProperty: 'payload.name', wires: [['target']] }]
        });
        runtime.send({ _msgid: 'test-message', payload: { text: 'Hello', id: 'client-A', name: 'Alex' }, route: { recipient: 'client-A' } });
        const result = await runtime.next('out');
        await runtime.next('done');
        assert.equal(result.payload, 'Full answer.');
        assert.equal(result.hermes.status, 'completed');
        assert.equal(result.hermes.clientId, 'client-A');
        assert.equal(result._msgid, 'test-message');
        assert.equal(result.route.recipient, 'client-A');
        assert.equal(calls[0].headers.authorization, 'Bearer fixture-only-key');
        assert.match(calls[0].url, /^\/p\/work\/v1\//);
        assert.equal(Object.hasOwn(calls[0].body, 'model'), false);
        assert.doesNotMatch(JSON.stringify(result), /fixture-only-key|PRIVATE_REASONING|reasoning_content/);
        assert.doesNotMatch(JSON.stringify(flows), /fixture-only-key/);
        await delay(40);
        assert.equal(runtime.messages('out').length, 1);
        assert.equal(runtime.messages('done').length, 1);
        assert.equal(runtime.messages('errors').length, 0);
    });
}

test('real Node-RED 5: preserve existing bot identity and map optional boolean', { timeout: 30000 }, async t => {
    const { runtime } = await setup(t, { type: 'hermes-prepare', inputProperty: 'payload.text', authorNameProperty: 'payload.name', wires: [['out']] });
    runtime.send({ payload: { text: 'Hello', name: 'Renamed bot' }, hermes: { author: { id: 'bot-1', is_bot: true } } });
    assert.deepEqual((await runtime.next('out')).hermes.author, { id: 'bot-1', name: 'Renamed bot', is_bot: true });
});

test('real Node-RED 5: invalid mapped author produces one traced Catch', { timeout: 30000 }, async t => {
    const { runtime } = await setup(t, { type: 'hermes-prepare', inputProperty: 'payload.text', authorNameProperty: 'payload.name', authorIsBotProperty: 'payload.bot', wires: [['out']] });
    for (const flag of [true, false]) {
        runtime.send({ payload: { text: 'Hello', name: 'Author', bot: flag } });
        assert.equal((await runtime.next('out')).hermes.author.is_bot, flag);
    }
    runtime.send({ _msgid: 'invalid-author', payload: { text: 'Hello', name: 'Author', bot: 'false' } });
    const error = await runtime.next('caught');
    assert.equal(error.hermes.error.code, 'INVALID_INPUT');
    assert.equal(error._msgid, 'invalid-author');
    assert.equal(error.payload, null);
    await delay(40);
    assert.equal(runtime.messages('caught').length, 1);
});

test('real Node-RED 5: Agent error has one error output and one sanitized Catch', { timeout: 30000 }, async t => {
    const { runtime } = await setup(t, { type: 'hermes-agent', mode: 'async', wires: [['out'], ['events'], ['errors']] }, { denied: true });
    runtime.send({ _msgid: 'denied', payload: 'Hello', routing: { recipient: 'A' } });
    for (const error of [await runtime.next('errors'), await runtime.next('caught')]) {
        assert.equal(error._msgid, 'denied');
        assert.equal(error.payload, null);
        assert.equal(error.hermes.error.code, 'HTTP_403');
        assert.equal(error.routing.recipient, 'A');
        assert.doesNotMatch(JSON.stringify(error), /fixture-only-key/);
    }
    await delay(40);
    assert.equal(runtime.messages('errors').length, 1);
    assert.equal(runtime.messages('caught').length, 1);
    assert.equal(runtime.messages('out').length, 0);
});

test('real Node-RED 5: Control reset and invalid-action error use native callbacks', { timeout: 30000 }, async t => {
    const { runtime } = await setup(t, { type: 'hermes-control', action: 'message', wires: [['out'], ['errors']] });
    runtime.send({ hermesControl: { action: 'reset' } });
    const reset = await runtime.next('out');
    assert.equal(reset.payload.action, 'reset');
    assert.equal(reset.hermesControl.ok, true);
    runtime.send({ _msgid: 'invalid-control', hermesControl: { action: 'not-supported' } });
    const error = await runtime.next('errors');
    const trace = await runtime.next('caught');
    assert.equal(error.hermesControl.error.code, 'INVALID_ACTION');
    assert.equal(trace.hermesControl.error.code, 'INVALID_ACTION');
    assert.equal(trace._msgid, 'invalid-control');
    await delay(40);
    assert.equal(runtime.messages('caught').length, 1);
});

for (const [name, config, expected] of [['default', {}, 30000], ['explicit', { asyncRequestTimeout: 83 }, 83000]]) {
    test(`real Node-RED 5: Queue HTTP timeout ${name}`, { timeout: 30000 }, async t => {
        const { runtime } = await setup(t, { type: 'hermes-control', action: 'status', wires: [['out'], ['errors']] }, { queue: config });
        assert.equal((await runtime.inspectQueue()).requestTimeoutMs, expected);
    });
}

test('real Node-RED 5: per-client sessions, global reset and orderly shutdown', { timeout: 30000 }, async t => {
    const { runtime, calls } = await setup(t, { type: 'hermes-agent', mode: 'async', wires: [['out'], ['events'], ['errors']] }, {
        extra: [
            { id: 'control-in', type: 'fixture-input', z: 'tab', wires: [['control']] },
            { id: 'control', type: 'hermes-control', z: 'tab', queue: 'queue', action: 'reset', wires: [['controlOut'], ['errors']] }
        ]
    });
    for (const client of ['A', 'B', 'A']) {
        runtime.send({ payload: 'Test', hermes: { clientId: client } });
        await runtime.next('out');
    }
    const sessions = calls.filter(c => c.method === 'POST' && c.url.endsWith('/runs')).map(c => c.body.session_id);
    assert.equal(sessions[0], sessions[2]);
    assert.notEqual(sessions[0], sessions[1]);
    runtime.send({}, 'control-in');
    await runtime.next('controlOut');
    runtime.send({ payload: 'After reset', hermes: { clientId: 'A' } });
    const result = await runtime.next('out');
    assert.notEqual(result.hermes.sessionId, sessions[0]);
    await runtime.close();
});
