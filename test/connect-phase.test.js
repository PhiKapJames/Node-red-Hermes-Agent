'use strict';
// Issue #12: a Hermes restart (or a dropped Tailscale link) fails in the connect phase,
// before any bytes are on the wire. Those failures must not pause the shared queue: the
// queue has to stay *usable*, so this drives the real client against real sockets.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { HermesClient } = require('../lib/client');
const { HermesQueue } = require('../lib/queue');
const { prepareRequest } = require('../lib/request');

const secret = () => 'test-only-secret';

function queueFor(t, clientFor, options = {}) {
    const produced = new Set();
    const queue = new HermesQueue({
        clientFor: (...args) => {
            const client = clientFor(...args);
            produced.add(client);
            return client;
        },
        pollIntervalMs: 5,
        stopTimeoutMs: 1000,
        jobTimeoutMs: 5000,
        retryDelayMs: 5,
        requestTimeoutMs: 1500,
        ...options
    });
    // The queue owns scheduling, not sockets: without this the keep-alive connections of a
    // successful job hold the test process open for the idle timeout.
    t.after(async () => {
        await queue.close();
        for (const client of produced) if (typeof client.close === 'function') client.close();
    });
    return queue;
}

function submit(queue, input) {
    const ticket = queue.enqueue({
        ownerId: 'agent',
        connectionId: 'connection',
        spec: prepareRequest(input, { clientId: 'agent' }),
        message: { payload: input }
    });
    ticket.finished.catch(() => {});
    return ticket;
}

const refused = () => new HermesClient({ baseUrl: 'http://127.0.0.1:9', getKey: secret });
const isNetwork = error => error.code === 'NETWORK' && error.retryable && error.remoteUnknown === false;

async function liveServer(t) {
    const server = http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
            if (req.method === 'POST' && req.url.endsWith('/runs')) return void res.end(JSON.stringify({ run_id: 'run_live' }));
            if (req.method === 'POST') return void res.end(JSON.stringify({ status: 'cancelled' }));
            res.end(JSON.stringify({ status: 'completed', output: 'back online' }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    return `http://127.0.0.1:${server.address().port}`;
}

// lib/client.js drops `retryable` from an approval failure, because a replay might answer a
// decision twice. That reasoning only holds once the request was dispatched: with no bytes on the
// wire there is nothing on the server to double-answer, and a caller that cannot retry a provably
// undelivered decision has no way to honour a human still waiting for it. The other half — that a
// dispatched approval failure is never retryable — is pinned in test/approval.test.js.
test('an approval that provably never connected stays retryable', async t => {
    const client = refused();
    t.after(() => client.close());
    await assert.rejects(() => client.approve('run-1', { choice: 'once', requestId: 'approval-1' }), (error) => {
        assert.deepEqual([error.code, error.remoteUnknown, error.retryable], ['NETWORK', false, true]);
        return true;
    });
});

test('a refused connect fails without pausing the queue and the next job runs', async t => {
    const url = await liveServer(t);
    let target = 'dead';
    const queue = queueFor(t, () => new HermesClient({
        baseUrl: target === 'dead' ? 'http://127.0.0.1:9' : url,
        getKey: secret
    }));

    await assert.rejects(submit(queue, 'first').finished, isNetwork);
    assert.deepEqual([queue.snapshot().uncertain, queue.snapshot().paused], [null, false]);

    target = 'live';
    assert.equal((await submit(queue, 'second').finished).output, 'back online');
});

test('a queue that paused on an ambiguous failure recovers and runs the next job', async t => {
    const url = await liveServer(t);
    const realClient = new HermesClient({ baseUrl: url, getKey: secret });
    t.after(() => realClient.close());
    const queue = queueFor(t, () => refused(), { startRetries: 1 });

    await submit(queue, 'first').finished.catch(() => {});
    queue.clientFor = () => realClient;
    assert.equal((await submit(queue, 'second').finished).output, 'back online');
    assert.deepEqual([queue.snapshot().uncertain, queue.snapshot().paused], [null, false]);
});

test('admission retries reuse one Idempotency-Key across refused connects', async t => {
    const client = refused();
    const queue = queueFor(t, () => client, { startRetries: 2 });
    const keys = [];
    const attempts = [];
    queue.on('progress', (_job, event) => { if (event.status === 'retrying') attempts.push([event.operation, event.attempt]); });
    const recorder = { start: (body, options) => { keys.push(options.headers['Idempotency-Key']); return client.start(body, options); } };
    queue.clientFor = () => recorder;
    await assert.rejects(submit(queue, 'x').finished, isNetwork);
    assert.equal(keys.length, 3);
    assert.match(keys[0], /^nr-/, 'a dropped Idempotency-Key must not read as a stable one');
    assert.deepEqual(keys, Array(3).fill(keys[0]));
    assert.deepEqual(attempts, [['start', 1], ['start', 2]]);
    assert.deepEqual([queue.snapshot().uncertain, queue.snapshot().paused], [null, false]);
});

test('an earlier ambiguous admission still forces uncertainty after a refused retry', async t => {
    const failing = http.createServer((_req, res) => { res.statusCode = 503; res.end('{}'); });
    await new Promise(resolve => failing.listen(0, '127.0.0.1', resolve));
    t.after(() => { failing.closeAllConnections(); return new Promise(resolve => failing.close(resolve)); });
    const sick = new HermesClient({ baseUrl: `http://127.0.0.1:${failing.address().port}`, getKey: secret });
    const dead = refused();
    t.after(() => { sick.close(); dead.close(); });
    const unknown = [];
    let attempts = 0;
    const pick = () => (attempts++ ? dead : sick);
    const queue = queueFor(t, () => ({
        chat: (b, o) => pick().chat(b, o),
        start: async (b, o) => { try { return await pick().start(b, o); } catch (error) { unknown.push(error.remoteUnknown); throw error; } },
        status: (b, o) => pick().status(b, o),
        stop: (b, o) => pick().stop(b, o)
    }), { startRetries: 1 });
    await assert.rejects(submit(queue, 'x').finished, error => error.remoteUnknown === true);
    assert.deepEqual(unknown, [true, false], 'the 503 was ambiguous, the refused retry was provably not dispatched');
    assert.deepEqual([queue.snapshot().paused, Boolean(queue.snapshot().uncertain)], [true, true]);
});

test('a connection reset after the request is sent still pauses the queue', async t => {
    const server = http.createServer(req => { req.socket.destroy(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const client = new HermesClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, getKey: secret });
    t.after(() => client.close());
    const queue = queueFor(t, () => client, { startRetries: 1 });
    await assert.rejects(submit(queue, 'x').finished, error => error.code === 'NETWORK' && error.remoteUnknown === true);
    assert.equal(queue.snapshot().paused, true);
    assert.notEqual(queue.snapshot().uncertain, null);
    assert.throws(() => submit(queue, 'next'), error => error.code === 'QUEUE_UNCERTAIN');
});
