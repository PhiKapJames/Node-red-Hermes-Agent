'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { startRuntime } = require('../support/runtime.cjs');
const capabilitiesFixture = require('../support/fixtures/capabilities.json');
const healthFixture = require('../support/fixtures/health-detailed.json');

async function setup(t, target, options = {}) {
    const calls = [];
    const api = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
        calls.push({ url: req.url, method: req.method, headers: req.headers, body });
        res.setHeader('Content-Type', 'application/json');
        if (options.errorCode !== undefined) {
            // The verified upstream envelope is {error:{message,type,param,code}}.
            res.writeHead(400);
            res.end(JSON.stringify({ error: { message: 'Fixture rejected the run.', type: 'invalid_request_error', param: null, code: options.errorCode } }));
        }
        else if (req.url.endsWith('/capabilities') || req.url.endsWith('/health/detailed')) {
            if (options.probeStatus) {
                res.writeHead(options.probeStatus);
                res.end(JSON.stringify({ error: { message: 'Fixture probe unavailable.', type: 'server_error', param: null, code: 'probe_unavailable' } }));
            } else {
                res.end(JSON.stringify(req.url.endsWith('/capabilities') ? capabilitiesFixture : healthFixture));
            }
        }
        else if (options.denied) { res.writeHead(403); res.end(JSON.stringify({ error: { message: 'Rejected fixture-only-key' } })); }
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
    // Node-RED classifies z-scoped nodes without x/y as config nodes.
    // Match actual editor-exported flows: every wired node has coordinates.
    flows.forEach((node, index) => {
        if (node.z && Number.isFinite(node.x) === false && Number.isFinite(node.y) === false) {
            node.x = 160 + (index % 4) * 190;
            node.y = 80 + Math.floor(index / 4) * 70;
        }
    });
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

test('real Node-RED 5: probe summarizes capabilities and readiness at their own scopes', { timeout: 30000 }, async t => {
    const { runtime, calls, flows } = await setup(t,
        { type: 'hermes-control', action: 'probe', target: 'capabilities', connection: 'connection', wires: [['out'], ['errors']] }, {
            extra: [
                { id: 'readiness-in', type: 'fixture-input', z: 'tab', wires: [['readiness']] },
                { id: 'readiness', type: 'hermes-control', z: 'tab', queue: 'queue', connection: 'connection', action: 'probe', target: 'readiness', wires: [['out'], ['errors']] }
            ]
        });
    runtime.send({ _msgid: 'probe-capabilities' }, 'input');
    const capabilities = await runtime.next('out');
    runtime.send({ _msgid: 'probe-readiness' }, 'readiness-in');
    const readiness = await runtime.next('out');
    assert.deepEqual(capabilities.payload, {
        target: 'capabilities',
        model: 'hermes-4-mock',
        auth_type: 'bearer',
        auth_required: true,
        runtime_mode: 'server_agent',
        features: { run_status: true, run_stop: true, run_approval_response: true },
        run_approval_path: '/v1/runs/{run_id}/approval'
    });
    assert.deepEqual(capabilities.hermes.probe, { target: 'capabilities', ok: true, stale: false, approvalSupported: true });
    assert.deepEqual(readiness.payload, {
        target: 'readiness', status: 'ready', readiness_status: 'ready', version: '0.21.6',
        gateway_state: 'running', gateway_busy: true, active_agents: 1
    });
    assert.deepEqual(readiness.hermes.probe, { target: 'readiness', ok: true, stale: false });
    assert.equal(capabilities.hermesControl.action, 'probe');
    assert.deepEqual(calls.map(call => `${call.method} ${call.url}`), ['GET /p/work/v1/capabilities', 'GET /p/work/health/detailed']);
    assert.equal(calls[0].headers.authorization, 'Bearer fixture-only-key');
    // Nothing nested or credential-shaped may ride along, and the probe never used the queue.
    assert.doesNotMatch(JSON.stringify([capabilities, readiness]), /never-surfaced|browser_extension|Bearer synthetic|api_key|fixture-only-key|PRIVATE_REASONING/);
    assert.doesNotMatch(JSON.stringify(flows), /fixture-only-key/);
    const queue = await runtime.inspectQueue();
    assert.deepEqual({ paused: queue.paused, pending: queue.pending, active: queue.active, uncertain: queue.uncertain, queued: queue.queued },
        { paused: false, pending: 0, active: null, uncertain: null, queued: [] });
    await delay(40);
    assert.equal(runtime.messages('errors').length, 0);
    assert.equal(runtime.messages('caught').length, 0);
});

test('real Node-RED 5: a failed probe is informational and never disturbs the queue', { timeout: 30000 }, async t => {
    const { runtime, calls } = await setup(t,
        { type: 'hermes-control', action: 'probe', target: 'capabilities', connection: 'connection', wires: [['out'], ['errors']] }, { probeStatus: 503 });
    runtime.send({ _msgid: 'probe-fails' }, 'input');
    const error = await runtime.next('errors');
    const trace = await runtime.next('caught');
    assert.equal(error.payload, null);
    assert.equal(error.hermesControl.ok, false);
    assert.equal(error.hermesControl.error.code, 'HTTP_503');
    assert.equal(error.hermesControl.error.statusCode, 503);
    assert.equal(error.hermesControl.error.errorCode, 'probe_unavailable');
    // Fail closed: an unread capabilities document never leaves approval support looking available.
    assert.deepEqual(error.hermes.probe, { target: 'capabilities', ok: false, stale: true, approvalSupported: false });
    assert.equal(trace._msgid, 'probe-fails');
    assert.equal(trace.hermesControl.error.code, 'HTTP_503');
    const queue = await runtime.inspectQueue();
    assert.deepEqual({ paused: queue.paused, pending: queue.pending, active: queue.active, uncertain: queue.uncertain },
        { paused: false, pending: 0, active: null, uncertain: null });
    assert.deepEqual(calls.map(call => call.url), ['/p/work/v1/capabilities']);
    assert.doesNotMatch(JSON.stringify(error), /fixture-only-key/);
    await delay(40);
    assert.equal(runtime.messages('out').length, 0);
    assert.equal(runtime.messages('errors').length, 1);
});

test('real Node-RED 5: probe refuses to guess a server, a target or a queue', { timeout: 30000 }, async t => {
    // `connection: ''` is deliberate: a probe must not fall back to some other Connection just
    // because a Queue is configured on the node.
    // The extra nodes are wired to port 2 only (`[[], [...]]`), so an accidental success would be
    // invisible rather than passing a test by reading a result.
    const { runtime, calls } = await setup(t, { type: 'hermes-control', action: 'probe', target: 'capabilities', connection: '', wires: [['out'], ['errors']] }, {
        extra: [
            { id: 'other-connection', type: 'hermes-connection', baseUrl: 'http://127.0.0.1:1' },
            { id: 'bad-target', type: 'hermes-control', z: 'tab', queue: 'queue', connection: 'connection', action: 'probe', target: 'everything', wires: [[], ['errors']] },
            { id: 'prototype-target', type: 'hermes-control', z: 'tab', queue: 'queue', connection: 'connection', action: 'probe', target: 'toString', wires: [[], ['errors']] },
            { id: 'queue-as-connection', type: 'hermes-control', z: 'tab', queue: 'queue', connection: 'queue', action: 'probe', target: 'capabilities', wires: [[], ['errors']] },
            { id: 'other-node', type: 'hermes-control', z: 'tab', queue: 'queue', connection: 'other-connection', action: 'probe', target: 'capabilities', wires: [[], ['errors']] },
            { id: 'message-mode', type: 'hermes-control', z: 'tab', queue: 'queue', connection: 'connection', action: 'message', wires: [[], ['errors']] },
            ...['bad-target', 'prototype-target', 'queue-as-connection', 'other-node', 'message-mode'].map(id => ({ id: `${id}-in`, type: 'fixture-input', z: 'tab', wires: [[id]] }))
        ]
    });
    const codes = [];
    for (const id of ['input', 'bad-target-in', 'prototype-target-in', 'queue-as-connection-in', 'other-node-in']) {
        runtime.send({}, id);
        codes.push((await runtime.next('errors')).hermesControl.error.code);
    }
    // 'toString' is the important case: an inherited property name must not resolve to a route.
    // The last node's own Connection has no credential, so MISSING_CREDENTIAL (raised inside that
    // client, before dispatch) proves the probe used the node-configured Connection rather than
    // falling back to the queue's or to another node's working client.
    assert.deepEqual(codes, ['CONFIG', 'CONFIG', 'CONFIG', 'CONFIG', 'MISSING_CREDENTIAL']);
    // A message can never select the probe action, only the node configuration can.
    runtime.send({ hermesControl: { action: 'probe' } }, 'message-mode-in');
    assert.equal((await runtime.next('errors')).hermesControl.error.code, 'INVALID_ACTION');
    // None of them reached the network: the trusted server saw nothing, and the node whose own
    // Connection points elsewhere could not use the queue's Connection instead.
    assert.deepEqual(calls, []);
    await delay(40);
    assert.equal(runtime.messages('out').length, 0);
});

for (const [code, expected] of [['approval_not_pending', 'approval_not_pending'], ['NOT A VALID CODE', undefined]]) {
    test(`real Node-RED 5: upstream error code ${expected ?? 'is dropped'} reaches the Agent error output`, { timeout: 30000 }, async t => {
        const { runtime } = await setup(t, { type: 'hermes-agent', mode: 'async', wires: [['out'], ['events'], ['errors']] }, { errorCode: code });
        runtime.send({ _msgid: 'coded-failure', payload: 'Hello' });
        const error = await runtime.next('errors');
        assert.equal(error.payload, null);
        assert.equal(error.hermes.error.code, 'HTTP_400');
        assert.equal(error.hermes.error.statusCode, 400);
        assert.equal(error.hermes.error.errorCode, expected);
        assert.equal(Object.hasOwn(error.hermes.error, 'errorCode'), expected !== undefined);
        assert.equal(error.hermes.error.message, 'Fixture rejected the run.');
        assert.doesNotMatch(JSON.stringify(error), /NOT A VALID CODE/);
        assert.equal((await runtime.next('caught')).hermes.error.errorCode, expected);
    });
}
