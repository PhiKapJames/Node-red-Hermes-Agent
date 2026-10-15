'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { startRuntime } = require('../support/runtime.cjs');
const capabilitiesFixture = require('../support/fixtures/capabilities.json');
const healthFixture = require('../support/fixtures/health-detailed.json');
const approvalRunFixture = require('../support/fixtures/run-waiting-approval.json');
const approvalFixtures = require('../support/fixtures/approval.json');

async function setup(t, target, options = {}) {
    const calls = [];
    let runPolls = 0;
    let releasedAfter = -1;
    // The committed fixture advertises every choice; a test can narrow what the server offered for
    // this decision to prove the node's own allowlist is intersected with the server's.
    const waiting = options.advertises
        ? { ...approvalRunFixture, approval: { ...approvalRunFixture.approval, choices: options.advertises } }
        : approvalRunFixture;
    // A run keeps reporting the decision until this many polls have passed, so a test can act on it.
    const holdPolls = options.hold ?? 1;
    const api = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
        calls.push({ url: req.url, method: req.method, headers: req.headers, body });
        res.setHeader('Content-Type', 'application/json');
        if (req.url.endsWith('/approval')) {
            // With no explicit opt-in, any approval POST is a finding: the reply is the server's real
            // answer to a decision that is not pending, so no test can read a 2xx this package did not
            // get. A test that exercises the approval action names the fixture to answer with.
            if (options.approveReleases) releasedAfter = Math.min(runPolls + options.approveReleases, holdPolls);
            const reply = options.approvalReply ? approvalFixtures[options.approvalReply] : approvalFixtures.notActive;
            res.writeHead(reply.status);
            res.end(JSON.stringify(reply.body));
        }
        else if (options.errorCode !== undefined) {
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
        else if (options.pendingApproval && req.method === 'GET' && /\/runs\/[^/]+$/.test(req.url)) {
            // The run reports the decision exactly as the server does, for as long as the test needs to
            // act on it, then finishes on its own: nothing here depends on an approval arriving. With
            // `approveReleases` a posted approval releases it a couple of polls later, which is not
            // what the server does (answering returns the run to `running`) but is exactly what a lost
            // acknowledgement looks like from here - the same decision keeps being advertised, and must
            // not be posted twice.
            const poll = runPolls++;
            const finished = releasedAfter >= 0 ? poll >= Math.min(releasedAfter, holdPolls) : poll >= holdPolls;
            res.end(JSON.stringify(finished ? { status: 'completed', output: 'Full answer.' } : waiting));
        }
        else res.end(JSON.stringify({ status: 'completed', output: 'Full answer.', reasoning_content: 'PRIVATE_REASONING' }));
    });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const port = api.address().port;
    // A test that needs a second Connection config pointing at this very server builds its extra nodes
    // from the port, so no fixture ever names a host or a fixed port.
    const extra = typeof options.extra === 'function' ? options.extra(port) : options.extra || [];
    t.after(async () => { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); });
    const flows = [
        { id: 'tab', type: 'tab', label: 'Isolated Node-RED 5 runtime' },
        { id: 'connection', type: 'hermes-connection', baseUrl: `http://127.0.0.1:${api.address().port}`, profile: 'work' },
        { id: 'queue', type: 'hermes-queue', pollInterval: 0.25, ...options.queue },
        { id: 'input', type: 'fixture-input', z: 'tab', wires: [[options.entry || 'target']] },
        { id: 'target', z: 'tab', connection: 'connection', queue: 'queue', ...target },
        ...extra,
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
    const runtime = await startRuntime(t, flows, { connection: { apiKey: 'fixture-only-key' }, ...options.credentials });
    return { runtime, calls, flows };
}

/**
 * The lifecycle event that reported this run's pending decision, so a test can address exactly the
 * decision a flow would see. Any other terminal state first is a fixture failure, not a pass.
 */
async function pendingDecision(runtime) {
    for (;;) {
        const hermes = (await runtime.next('events')).hermes;
        if (hermes.status === 'waiting_for_approval') return hermes;
        if (!['queued', 'starting', 'accepted', 'running'].includes(hermes.status)) {
            throw new Error(`the run stopped reporting a decision before it was observed: ${hermes.status}`);
        }
    }
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

test('real Node-RED 5: a pending decision is observable and is never answered by this package', { timeout: 30000 }, async t => {
    const { runtime, calls } = await setup(t, { type: 'hermes-agent', mode: 'async', wires: [['out'], ['events'], ['errors']] }, { pendingApproval: true });
    // The message asks for a preview it must not be able to ask for: `msg.hermes` cannot enable
    // anything that a Queue configuration has not enabled.
    runtime.send({ _msgid: 'awaiting-approval', payload: 'Hello', hermes: { clientId: 'client-A', includeApprovalPreview: true } });
    const answer = await runtime.next('out');
    assert.equal(answer.payload, 'Full answer.');
    assert.equal(answer.hermes.status, 'completed');
    const lifecycle = runtime.messages('events').map(message => message.hermes);
    const pendingMessages = runtime.messages('events').filter(message => message.hermes?.status === 'waiting_for_approval');
    assert.equal(pendingMessages.length, 1, JSON.stringify(lifecycle.map(hermes => hermes.status)));
    assert.equal(pendingMessages[0].payload, null, 'a lifecycle message carries no answer');
    assert.equal(pendingMessages[0]._msgid, 'awaiting-approval', 'the decision is correlated with the request that caused it');
    const pending = pendingMessages[0].hermes;
    assert.equal(pending.approvalRequestId, approvalRunFixture.approval.request_id);
    assert.deepEqual(pending.approvalChoices, ['once', 'session', 'always', 'deny']);
    assert.equal(pending.clientId, 'client-A');
    assert.equal(pending.requestId, lifecycle.find(hermes => hermes.status === 'completed')?.requestId, 'one job, one decision');
    assert.equal(Object.hasOwn(pending, 'approvalCommand'), false, 'the preview stays off unless the Queue says so');
    assert.doesNotMatch(JSON.stringify(runtime.messages('events')), /echo|flagged action requires approval|mock-destructive-pattern|msg_mock_0001|fixture-only-key/);
    assert.deepEqual(calls.filter(call => call.url.endsWith('/approval')), [], 'this package never answers a decision');
    await delay(40);
    assert.equal(runtime.messages('out').length, 1);
    assert.equal(runtime.messages('errors').length, 0);
    assert.equal(runtime.messages('caught').length, 0);
});

test('real Node-RED 5: the Queue preview setting alone puts bounded approval text on the lifecycle port', { timeout: 30000 }, async t => {
    const { runtime, calls } = await setup(t, { type: 'hermes-agent', mode: 'async', wires: [['out'], ['events'], ['errors']] }, {
        pendingApproval: true, queue: { includeApprovalPreview: true }
    });
    runtime.send({ _msgid: 'preview-on', payload: 'Hello' });
    assert.equal((await runtime.next('out')).payload, 'Full answer.');
    const pending = runtime.messages('events').map(message => message.hermes).filter(hermes => hermes.status === 'waiting_for_approval');
    assert.equal(pending.length, 1);
    // The server already redacts the command; this package re-redacts and caps, and reads only
    // these two fields out of the approval object.
    assert.equal(pending[0].approvalCommand, 'echo [redacted-by-hermes]');
    assert.equal(pending[0].approvalDescription, 'flagged action requires approval');
    assert.deepEqual(pending[0].approvalChoices, ['once', 'session', 'always', 'deny']);
    assert.doesNotMatch(JSON.stringify(runtime.messages('events')), /mock-destructive-pattern|msg_mock_0001|smart_denied|allow_session|allow_permanent|fixture-only-key/);
    assert.deepEqual(calls.filter(call => call.url.endsWith('/approval')), []);
    const queue = await runtime.inspectQueue();
    assert.deepEqual({ paused: queue.paused, pending: queue.pending, active: queue.active, uncertain: queue.uncertain },
        { paused: false, pending: 0, active: null, uncertain: null }, 'observing a decision never disturbs the queue');
});

// --- answering one exact decision, from a Control node -----------------------------------------

const DECISION = approvalRunFixture.approval.request_id;
const OTHER_DECISION = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
/** One Control node with its own input and result probe, so a test can tell results apart. */
const approvalFlow = (id, config) => [
    { id: `${id}-in`, type: 'fixture-input', z: 'tab', wires: [[id]] },
    { id, type: 'hermes-control', z: 'tab', queue: 'queue', action: 'approve', wires: [[`${id}Out`], ['errors']], ...config },
    { id: `${id}Out`, type: 'fixture-probe', z: 'tab' }
];
const approve = (id, values) => ({ _msgid: `click-${id}`, hermesControl: values });
const idle = queue => ({ paused: queue.paused, pending: queue.pending, active: queue.active, uncertain: queue.uncertain });
const IDLE = { paused: false, pending: 0, active: null, uncertain: null };

test('real Node-RED 5: an approved decision is posted once and never frees the queue slot', { timeout: 30000 }, async t => {
    // `approveReleases` keeps the decision advertised for two more polls after the POST, which is not
    // what the server does but exactly what a lost acknowledgement looks like from here: the run must
    // still be posted to once only, and only the run reaching a terminal state may take the slot back.
    const { runtime, calls } = await setup(t, { type: 'hermes-agent', mode: 'async', wires: [['out'], ['events'], ['errors']] }, {
        pendingApproval: true, hold: 40, approveReleases: 2, approvalReply: 'success', extra: approvalFlow('control', { allowApprove: true, approvalChoices: 'once,deny' })
    });
    runtime.send({ _msgid: 'needs-approval', payload: 'Hello' });
    const pending = await pendingDecision(runtime);
    assert.deepEqual({ approvalRequestId: pending.approvalRequestId, approvalChoices: pending.approvalChoices },
        { approvalRequestId: DECISION, approvalChoices: ['once', 'session', 'always', 'deny'] });
    // Follow-up work is queued behind the run, not admitted because someone answered a decision.
    runtime.send({ _msgid: 'next-up', payload: 'Second' });
    runtime.send(approve('once', { requestId: pending.requestId, approvalRequestId: pending.approvalRequestId, choice: 'once' }), 'control-in');
    const answered = await runtime.next('controlOut');
    assert.deepEqual(Object.keys(answered.payload).sort(), ['action', 'approvalRequestId', 'choice', 'ok', 'requestId', 'runId']);
    assert.deepEqual(
        { action: answered.payload.action, ok: answered.payload.ok, choice: answered.payload.choice, requestId: answered.payload.requestId, approvalRequestId: answered.payload.approvalRequestId },
        { action: 'approve', ok: true, choice: 'once', requestId: pending.requestId, approvalRequestId: DECISION }
    );
    assert.deepEqual(answered.hermesControl, { action: 'approve', ok: true });
    assert.equal(answered._msgid, 'click-once');
    // A 2xx approval is not a completion: the run still holds the slot and the next job still waits.
    const held = await runtime.inspectQueue();
    assert.deepEqual({ active: held.active?.runId, pending: held.pending, paused: held.paused, uncertain: held.uncertain },
        { active: answered.payload.runId, pending: 1, paused: false, uncertain: null }, 'answering is not finishing');
    assert.deepEqual(calls.filter(call => call.method === 'POST' && call.url.endsWith('/runs')).map(call => call.body.input), ['Hello']);
    assert.equal((await runtime.next('out')).payload, 'Full answer.', 'the run goes on to its own terminal state');
    assert.equal((await runtime.next('out')).payload, 'Full answer.');
    const posts = calls.filter(call => call.url.endsWith('/approval'));
    assert.deepEqual(posts.map(call => [call.method, call.url, call.body]), [
        ['POST', `/p/work/v1/runs/${answered.payload.runId}/approval`, { choice: 'once', request_id: DECISION }]
    ], 'exactly one POST, with exactly the two fields, on the admitted profile');
    assert.equal(posts[0].headers.authorization, 'Bearer fixture-only-key');
    await delay(40);
    assert.equal(runtime.messages('errors').length, 0, JSON.stringify(runtime.messages('errors')));
    assert.equal(runtime.messages('out').length, 2, 'one answer per job');
});

test('real Node-RED 5: a stale, unaddressed or unpermitted approval is refused with no request at all', { timeout: 30000 }, async t => {
    // The server advertises only `once` and `deny` for this decision, whatever the node allows.
    const { runtime, calls } = await setup(t, { type: 'hermes-agent', mode: 'async', wires: [['out'], ['events'], ['errors']] }, {
        pendingApproval: true, hold: 14, advertises: ['once', 'deny'],
        extra: [
            ...approvalFlow('control', { allowApprove: true, approvalChoices: 'once, deny, session' }),
            { id: 'strict-in', type: 'fixture-input', z: 'tab', wires: [['strict']] },
            // No `allowApprove` at all: the shape a flow has when the operator never ticked anything.
            { id: 'strict', type: 'hermes-control', z: 'tab', queue: 'queue', action: 'approve', approvalChoices: 'once', wires: [[], ['errors']] },
            { id: 'dynamic-in', type: 'fixture-input', z: 'tab', wires: [['dynamic']] },
            { id: 'dynamic', type: 'hermes-control', z: 'tab', queue: 'queue', action: 'message', allowApprove: true, approvalChoices: 'once', wires: [[], ['errors']] }
        ]
    });
    runtime.send({ _msgid: 'awaiting', payload: 'Hello' });
    const pending = await pendingDecision(runtime);
    const addressed = { requestId: pending.requestId, approvalRequestId: DECISION, choice: 'once' };
    const cases = [
        // A late click naming a decision the run already replaced is the failure this rule exists for.
        ['control', { ...addressed, approvalRequestId: OTHER_DECISION }, 'INVALID_INPUT'],
        ['control', { approvalRequestId: DECISION, choice: 'once' }, 'INVALID_INPUT'],
        ['control', { requestId: pending.requestId, choice: 'once' }, 'INVALID_INPUT'],
        ['control', { ...addressed, requestId: 'not-a-job' }, 'REQUEST_NOT_FOUND'],
        ['control', { ...addressed, choice: 'always' }, 'OVERRIDE_DISABLED'],
        ['control', { ...addressed, choice: 'session' }, 'OVERRIDE_DISABLED'],
        ['control', { ...addressed, choice: 'approve' }, 'INVALID_INPUT'],
        ['strict', addressed, 'OVERRIDE_DISABLED'],
        // A message can never select the approval action; only the node configuration can.
        ['dynamic', { action: 'approve', ...addressed }, 'INVALID_ACTION']
    ];
    const codes = [];
    for (const [id, hermesControl, expected] of cases) {
        runtime.send(approve(id, hermesControl), `${id}-in`);
        const message = await runtime.next('errors');
        codes.push([id, message.hermesControl.error.code, message.payload]);
        assert.equal(message.hermesControl.error.code, expected, id);
        assert.equal(message.payload, null, id);
    }
    assert.deepEqual(codes.map(([id, code]) => `${id}:${code}`), cases.map(([id, , expected]) => `${id}:${expected}`));
    assert.deepEqual(calls.filter(call => call.url.endsWith('/approval')), [], 'every refusal was local');
    // And a refused approval leaves the run itself completely undisturbed.
    assert.equal((await runtime.next('out')).payload, 'Full answer.');
    const queue = await runtime.inspectQueue();
    assert.deepEqual({ paused: queue.paused, pending: queue.pending, active: queue.active, uncertain: queue.uncertain },
        { paused: false, pending: 0, active: null, uncertain: null });
    assert.doesNotMatch(JSON.stringify(runtime.messages('errors')), /fixture-only-key/);
    // A dynamic action is still refused, and its refusal never advertises either fixed-only action.
    const refused = runtime.messages('errors').find(entry => entry.hermesControl.error.code === 'INVALID_ACTION');
    assert(refused, 'a dynamic action is refused');
    assert.doesNotMatch(refused.hermesControl.error.message, /approve|probe/);
});

test('real Node-RED 5: a shared queue routes an approval to the Connection that ran the job', { timeout: 30000 }, async t => {
    // One fixture server, two Connections with different profiles and keys. The job runs on `second`;
    // every Control node here names the *other* Connection, so the URL prefix and the bearer on the
    // wire show whose client was used. A probe must use its node's Connection; an approval must not.
    const { runtime, calls } = await setup(t, { type: 'hermes-agent', mode: 'async', connection: 'second', wires: [['out'], ['events'], ['errors']] }, {
        pendingApproval: true, hold: 40, approveReleases: 2, approvalReply: 'success',
        credentials: { second: { apiKey: 'fixture-second-key' } },
        extra: port => [
            { id: 'second', type: 'hermes-connection', baseUrl: `http://127.0.0.1:${port}`, profile: 'home' },
            ...approvalFlow('control', { allowApprove: true, approvalChoices: 'once', connection: 'connection' }),
            { id: 'probe-in', type: 'fixture-input', z: 'tab', wires: [['probe']] },
            { id: 'probe', type: 'hermes-control', z: 'tab', queue: 'queue', connection: 'connection', action: 'probe', target: 'capabilities', wires: [['probeOut'], ['errors']] },
            { id: 'probeOut', type: 'fixture-probe', z: 'tab' }
        ]
    });
    runtime.send({ _msgid: 'on-second', payload: 'Hello' });
    const pending = await pendingDecision(runtime);
    assert.match(calls[0].url, /^\/p\/home\/v1\/runs$/, 'the run itself was admitted on the job Connection');
    runtime.send(approve('route', { requestId: pending.requestId, approvalRequestId: pending.approvalRequestId, choice: 'once' }), 'control-in');
    assert.equal((await runtime.next('controlOut')).payload.ok, true, 'the approval was accepted');
    const posts = calls.filter(call => call.url.endsWith('/approval'));
    assert.equal(posts.length, 1, JSON.stringify(calls.map(call => call.url)));
    assert.match(posts[0].url, /^\/p\/home\/v1\/runs\/run-\d+\/approval$/, 'the approval went to the server that is running the job');
    assert.equal(posts[0].headers.authorization, 'Bearer fixture-second-key', 'with that job\'s credential');
    assert.equal(calls.filter(call => call.url.startsWith('/p/work/v1/runs')).length, 0, 'the node\'s own Connection never saw the job');
    // The probe, by contrast, is the node's own action on the node's own Connection.
    runtime.send({ _msgid: 'probe-other' }, 'probe-in');
    const probed = await runtime.next('probeOut');
    assert.equal(probed.payload.model, 'hermes-4-mock');
    const probeCall = calls.find(call => call.url.endsWith('/capabilities'));
    assert.equal(probeCall.url, '/p/work/v1/capabilities');
    assert.equal(probeCall.headers.authorization, 'Bearer fixture-only-key');
    assert.equal((await runtime.next('out')).payload, 'Full answer.', 'the run then finished normally');
    assert.equal(calls.filter(call => call.url.endsWith('/approval')).length, 1, 'the approval was never replayed');
});

for (const [name, code] of [['notPending', 'approval_not_pending'], ['notActive', 'approval_not_active']]) {
    test(`real Node-RED 5: a rejected approval surfaces ${code} once and disturbs nothing`, { timeout: 30000 }, async t => {
        // The accepted staleness race: the decision may be answered between the queue's last poll and
        // this POST, and the server's 409 is then the correct outcome - surfaced, not retried, and with
        // no effect on the run or the queue.
        const { runtime, calls } = await setup(t, { type: 'hermes-agent', mode: 'async', wires: [['out'], ['events'], ['errors']] }, {
            pendingApproval: true, hold: 6, approvalReply: name, extra: approvalFlow('control', { allowApprove: true, approvalChoices: 'once' })
        });
        runtime.send({ _msgid: 'awaiting', payload: 'Hello' });
        const pending = await pendingDecision(runtime);
        runtime.send(approve('late', { requestId: pending.requestId, approvalRequestId: pending.approvalRequestId, choice: 'once' }), 'control-in');
        const failure = await runtime.next('errors');
        assert.equal(failure.payload, null);
        assert.equal(failure.hermesControl.ok, false);
        assert.equal(failure._msgid, 'click-late');
        assert.deepEqual(
            { code: failure.hermesControl.error.code, statusCode: failure.hermesControl.error.statusCode, errorCode: failure.hermesControl.error.errorCode, retryable: failure.hermesControl.error.retryable, remoteUnknown: failure.hermesControl.error.remoteUnknown },
            { code: 'HTTP_409', statusCode: 409, errorCode: code, retryable: false, remoteUnknown: false }
        );
        assert.equal(failure.hermesControl.error.message, approvalFixtures[name].body.error.message);
        assert.equal((await runtime.next('out')).payload, 'Full answer.', 'the rejected approval left the run alone');
        assert.equal(calls.filter(call => call.url.endsWith('/approval')).length, 1, 'never retried or replayed');
        assert.deepEqual(idle(await runtime.inspectQueue()), IDLE);
    });
}

test('real Node-RED 5: force is the reset action override and nothing else', { timeout: 30000 }, async t => {
    // One rule for the whole node, so the palette help can state it plainly: `force` is only ever the
    // reset action's override. Every other action ignores it rather than rejecting it.
    const { runtime, calls } = await setup(t, { type: 'hermes-agent', mode: 'async', wires: [['out'], ['events'], ['errors']] }, {
        pendingApproval: true, hold: 40, approveReleases: 2, approvalReply: 'success',
        extra: [
            ...approvalFlow('control', { allowApprove: true, approvalChoices: 'once' }),
            { id: 'reset-in', type: 'fixture-input', z: 'tab', wires: [['reset']] },
            { id: 'reset', type: 'hermes-control', z: 'tab', queue: 'queue', action: 'reset', wires: [['resetOut'], ['errors']] },
            { id: 'resetOut', type: 'fixture-probe', z: 'tab' },
            { id: 'probe-in', type: 'fixture-input', z: 'tab', wires: [['probe']] },
            { id: 'probe', type: 'hermes-control', z: 'tab', queue: 'queue', connection: 'connection', action: 'probe', target: 'capabilities', wires: [['probeOut'], ['errors']] },
            { id: 'probeOut', type: 'fixture-probe', z: 'tab' }
        ]
    });
    // reset: force stays refused unless the node allows it, exactly as before.
    runtime.send({ _msgid: 'reset-force', hermesControl: { force: true } }, 'reset-in');
    assert.equal((await runtime.next('errors')).hermesControl.error.code, 'OVERRIDE_DISABLED');
    // probe: force is not the probe's business, so a probe with it set still runs.
    runtime.send({ _msgid: 'probe-force', hermesControl: { force: true } }, 'probe-in');
    const probed = await runtime.next('probeOut');
    assert.equal(probed.payload.target, 'capabilities');
    assert.equal(probed.hermesControl.ok, true);
    // approve: same rule, proven on a live decision.
    runtime.send({ _msgid: 'awaiting', payload: 'Hello' });
    const pending = await pendingDecision(runtime);
    runtime.send(approve('force', { requestId: pending.requestId, approvalRequestId: pending.approvalRequestId, choice: 'once', force: true }), 'control-in');
    const answered = await runtime.next('controlOut');
    assert.deepEqual({ ok: answered.payload.ok, choice: answered.payload.choice }, { ok: true, choice: 'once' });
    assert.equal(calls.filter(call => call.url.endsWith('/approval')).length, 1);
    assert.equal((await runtime.next('out')).payload, 'Full answer.');
});

test('real Node-RED 5: no legacy or hand-edited configuration enables an approval', { timeout: 30000 }, async t => {
    // The shapes an upgrade actually produces: a flow JSON that predates the feature, an older export
    // that carries the neighbouring fields but not these, a node ticked on but never given a permitted
    // choice, and values that look true but are not `true`. Each answers nothing, and nothing is sent.
    const legacy = [
        ['predates-the-feature', {}],
        ['older-export', { allowForce: false, target: 'capabilities', connection: 'connection' }],
        ['ticked-without-choices', { allowApprove: true }],
        ['coerced-permission', { allowApprove: 'true', approvalChoices: 'once' }],
        ['choices-without-permission', { approvalChoices: 'once' }],
        ['blank-choices', { allowApprove: true, approvalChoices: '' }],
        ['garbage-choices', { allowApprove: true, approvalChoices: 'yes, please' }]
    ];
    const { runtime, calls } = await setup(t, { type: 'hermes-agent', mode: 'async', wires: [['out'], ['events'], ['errors']] }, {
        extra: legacy.flatMap(([id, config]) => approvalFlow(id, config))
    });
    for (const [id] of legacy) {
        runtime.send(approve(id, { requestId: 'no-such-job', approvalRequestId: DECISION, choice: 'once' }), `${id}-in`);
        const failure = await runtime.next('errors');
        assert.equal(failure._msgid, `click-${id}`, id);
        assert.equal(failure.hermesControl.error.code, 'OVERRIDE_DISABLED', id);
        assert.equal(failure.payload, null, id);
        assert.doesNotMatch(failure.hermesControl.error.message, new RegExp(DECISION), id);
    }
    assert.deepEqual(calls, [], 'a disabled approval never resolves a client, so nothing can reach the network');
});
