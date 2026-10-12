'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HermesQueue } = require('../lib/queue');
const { HermesError } = require('../lib/errors');
const { prepareRequest } = require('../lib/request');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i=0; i<400; i++) { if (fn()) return; await wait(5); } throw new Error('Test condition timed out'); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function makeQueue(t, client, options = {}) {
    const q = new HermesQueue({ id: 'global', clientFor: () => client, pollIntervalMs: 2, requestTimeoutMs: 100, stopTimeoutMs: 40, retryDelayMs: 1, jobTimeoutMs: 1000, ...options });
    t.after(() => q.close()); return q;
}
function submit(q, input, clientId = 'client-1', mode = 'async', ownerId = 'node-1') {
    const ticket = q.enqueue({ ownerId, connectionId: 'server-1', spec: prepareRequest(input, { clientId }, { mode }), message: { payload: input } });
    ticket.finished.catch(() => {}); return ticket;
}
function simpleClient() {
    let counter = 0;
    return { start: async () => ({ run_id: `run_${++counter}` }), status: async () => ({ status: 'completed', output: 'Done.' }), stop: async () => ({ status: 'stopping' }) };
}

test('one FIFO is shared across owners and clients', async t => {
    const gate = deferred(); const started = [];
    const client = simpleClient();
    client.start = async body => { started.push(body.input); return { run_id: body.input }; };
    client.status = async id => { if (id === 'first') await gate.promise; return { status: 'completed', output: id }; };
    const q = makeQueue(t, client);
    const a = submit(q, 'first', 'A', 'async', 'node-1');
    const b = submit(q, 'second', 'B', 'async', 'node-2');
    await until(() => started.length === 1); assert.deepEqual(started, ['first']);
    gate.resolve(); assert.equal((await a.finished).output, 'first'); assert.equal((await b.finished).output, 'second');
    assert.deepEqual(started, ['first','second']);
});
test('each client has a stable independent session inside the shared queue', async t => {
    const sessions = [];
    const client = simpleClient(); const start = client.start;
    client.start = async body => { sessions.push(body.session_id); return start(body); };
    const q = makeQueue(t, client);
    await submit(q, 'one', 'A').finished; await submit(q, 'two', 'B').finished; await submit(q, 'three', 'A').finished;
    assert.equal(sessions[0], sessions[2]); assert.notEqual(sessions[0], sessions[1]);
    q.reset(); await submit(q, 'four', 'A').finished; assert.notEqual(sessions[3], sessions[0]);
});
test('sync and async share serialization; sync is not automatically retried', async t => {
    const client = simpleClient(); let calls = 0;
    client.chat = async body => { calls++; assert.equal(Object.hasOwn(body, 'model'), false); throw new HermesError('HTTP_403', 'Denied'); };
    const q = makeQueue(t, client);
    await assert.rejects(submit(q, 'one', 'A', 'sync').finished, { code: 'HTTP_403' });
    assert.equal(calls, 1); assert.equal((await submit(q, 'two').finished).output, 'Done.');
});
test('async retries use the same body and idempotency key', async t => {
    const client = simpleClient(); const calls = [];
    client.start = async (body, options) => { calls.push(JSON.stringify([body,options.headers])); if (calls.length === 1) throw new HermesError('HTTP_TIMEOUT', 'timeout', { retryable: true, remoteUnknown: true }); return { run_id: 'r' }; };
    const q = makeQueue(t, client);
    await submit(q, 'retry').finished;
    assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]);
});
test('queue overflow is explicit and not silently discarded', async t => {
    const q = makeQueue(t, simpleClient(), { maxPending: 1 }); q.control('pause');
    const a = submit(q, 'one');
    assert.throws(() => submit(q, 'two'), { code: 'QUEUE_FULL' });
    assert.equal(q.control('clear').cleared, 1);
    await assert.rejects(a.finished, { code: 'CANCELLED' });
});
test('pause holds queued work; resume restarts it', async t => {
    let calls = 0; const client = simpleClient(); client.start = async () => { calls++; return { run_id: 'r' }; };
    const q = makeQueue(t, client); q.control('pause'); const a = submit(q, 'one');
    await wait(10); assert.equal(calls, 0); q.control('resume'); await a.finished; assert.equal(calls, 1);
});
test('minimum start interval respects FIFO ordering', async t => {
    const starts = []; const client = simpleClient(); client.start = async () => { starts.push(Date.now()); return { run_id: 'r' }; };
    const q = makeQueue(t, client, { cooldownMs: 35 });
    const a = submit(q, 'one'); const b = submit(q, 'two'); await Promise.all([a.finished,b.finished]);
    assert.ok(starts[1]-starts[0] >= 30);
});
test('reset during admission stops late run, discards old result, and clears global queue', async t => {
    const gate = deferred(); let entered = false; const stops = [];
    const client = simpleClient();
    client.start = async () => { entered = true; return gate.promise; };
    client.stop = async id => { stops.push(id); return { status: 'stopping' }; };
    client.status = async () => ({ status: 'cancelled' });
    const q = makeQueue(t, client); const active = submit(q, 'one'); const waiting = submit(q, 'two', 'B');
    await until(() => entered); const result = q.control('reset');
    assert.equal(result.cleared, 1); assert.equal(result.cancellationRequested, true);
    gate.resolve({ run_id: 'late-run' });
    await assert.rejects(active.finished, { code: 'CANCELLED' }); await assert.rejects(waiting.finished, { code: 'CANCELLED' });
    assert.deepEqual(stops, ['late-run']);
});
test('force reset cannot let an old completion overwrite a new active slot', async t => {
    const gate = deferred(); let entered = false;
    const client = simpleClient();
    client.start = async body => { if (body.input === 'old') { entered = true; return gate.promise; } return { run_id: 'new' }; };
    client.status = async id => ({ status: id === 'old' ? 'cancelled' : 'completed', output: 'New answer.' });
    const q = makeQueue(t, client); const old = submit(q, 'old'); await until(() => entered);
    const reset = q.control('reset', { force: true }); assert.equal(reset.remoteMayContinue, true);
    const next = submit(q, 'new'); gate.resolve({ run_id: 'old' });
    await assert.rejects(old.finished, { code: 'CANCELLED' }); assert.equal((await next.finished).output, 'New answer.');
});
test('terminal failure is surfaced with the actual error and queue continues', async t => {
    const client = simpleClient(); let count = 0;
    client.status = async () => ++count === 1 ? { status: 'failed', error: 'Model access denied' } : { status: 'completed', output: 'Done.' };
    const q = makeQueue(t, client);
    await assert.rejects(submit(q, 'one').finished, /Model access denied/);
    assert.equal((await submit(q, 'two').finished).status, 'completed');
});
test('uncertain admission pauses the queue and requires deliberate recovery', async t => {
    const client = simpleClient(); client.start = async () => { throw new HermesError('NETWORK', 'lost', { retryable: true, remoteUnknown: true }); };
    const q = makeQueue(t, client, { startRetries: 0 }); const states = [];
    q.on('progress', (_, event) => states.push(event.status));
    await assert.rejects(submit(q, 'one').finished, { code: 'NETWORK' });
    const snapshot = q.snapshot();
    assert.equal(snapshot.paused, true); assert.ok(snapshot.uncertain);
    // The retained job is reported as uncertain even though its terminal event was failed.
    assert.equal(snapshot.uncertain.status, 'uncertain'); assert.equal(snapshot.uncertain.runId, null);
    assert.equal(snapshot.active, null);
    assert.deepEqual(states, ['queued', 'starting', 'uncertain', 'failed']);
    assert.throws(() => q.control('resume'), { code: 'QUEUE_UNCERTAIN' });
    q.control('reset', { force: true }); assert.equal(q.snapshot().uncertain, null);
});
test('deadline sends stop and only releases safely when termination is confirmed', async t => {
    let stopped = false; const client = simpleClient();
    client.status = async () => ({ status: stopped ? 'cancelled' : 'running' });
    client.stop = async () => { stopped = true; return { status: 'stopping' }; };
    const q = makeQueue(t, client, { jobTimeoutMs: 20 });
    await assert.rejects(submit(q, 'slow').finished, error => error.code === 'JOB_TIMEOUT' && !error.remoteUnknown);
    assert.equal(stopped, true); assert.equal(q.snapshot().uncertain, null);
});
test('waiting approval is observable without an automatic approval decision', async t => {
    const client = simpleClient(); const states = []; let polls = 0;
    client.status = async () => ++polls === 1 ? { status: 'waiting_for_approval' } : { status: 'completed', output: 'Approved externally.' };
    const q = makeQueue(t, client); q.on('progress', (_, event) => states.push(event.status));
    await submit(q, 'one').finished; assert.ok(states.includes('waiting_for_approval'));
});
test('owner undeploy removes only its queued jobs', async t => {
    const q = makeQueue(t, simpleClient()); q.control('pause');
    const a = submit(q, 'a', 'A', 'async', 'one'); const b = submit(q, 'b', 'B', 'async', 'two');
    q.cancelOwner('one'); await assert.rejects(a.finished, { code: 'CANCELLED' }); q.control('resume');
    assert.equal((await b.finished).status, 'completed');
});
test('unconfirmed stop blocks later jobs until recover confirms termination', async t => {
    let terminated = false; const client = simpleClient();
    client.status = async () => ({ status: terminated ? 'cancelled' : 'running' });
    const q = makeQueue(t, client, { jobTimeoutMs:10, stopTimeoutMs:12 }); const states = [];
    q.on('progress', (_, event) => states.push(event.status));
    await assert.rejects(submit(q, 'one').finished, error => error.code === 'JOB_TIMEOUT' && error.remoteUnknown);
    assert.equal(q.snapshot().paused, true);
    const retained = q.snapshot().uncertain;
    assert.equal(retained.status, 'uncertain'); assert.equal(retained.runId, 'run_1');
    assert.equal(q.snapshot().active, null);
    assert.throws(() => submit(q, 'two'), { code:'QUEUE_UNCERTAIN' });
    // Recovery that cannot confirm termination keeps the barrier and the uncertain status.
    await assert.rejects(q.control('recover'), { code: 'QUEUE_UNCERTAIN' });
    assert.equal(q.snapshot().uncertain.status, 'uncertain');
    terminated = true;
    const recovered = await q.control('recover');
    assert.equal(recovered.recovered, true); assert.equal(q.snapshot().uncertain, null);
    assert.equal(q.snapshot().paused, false);
    assert.ok(states.indexOf('uncertain') < states.indexOf('failed'), 'terminal failed event is still emitted');
});
test('only the retained uncertain job is reported as uncertain in a snapshot', async t => {
    const client = simpleClient(); client.status = async () => ({ status: 'running' });
    const q = makeQueue(t, client, { jobTimeoutMs: 40 });
    q.control('pause'); submit(q, 'first'); submit(q, 'second'); q.control('resume');
    await until(() => q.snapshot().queued.length === 1 && q.snapshot().active?.runId);
    const before = q.snapshot();
    assert.equal(before.uncertain, null);
    assert.notEqual(before.active.status, 'uncertain');
    assert.equal(before.queued[0].status, 'queued');
    await until(() => q.snapshot().uncertain);
    const after = q.snapshot();
    assert.equal(after.uncertain.status, 'uncertain');
    assert.equal(after.queued[0].status, 'queued', 'waiting work keeps its real phase');
    assert.equal(q.control('status').uncertain.status, 'uncertain', 'the control result uses the same projection');
    q.control('reset', { force: true });
    assert.equal(q.snapshot().uncertain, null);
});
test('cancelling synchronous HTTP does not falsely claim the server stopped', async t => {
    let started = false; const client = simpleClient();
    client.chat = (_, options) => new Promise((resolve, reject) => {
        started = true;
        options.signal.addEventListener('abort', () => reject(new HermesError('ABORTED', 'aborted', { remoteUnknown:true })), { once:true });
    });
    const q = makeQueue(t, client); const one = submit(q, 'one', 'A', 'sync');
    await until(() => started); q.control('reset');
    await assert.rejects(one.finished, error => error.code === 'CANCELLED' && error.remoteUnknown);
    assert.equal(q.snapshot().paused, true);
});
test('unknown API run states fail safely and request cancellation', async t => {
    let stop = false; const client = simpleClient();
    client.stop = async () => { stop = true; return {}; };
    client.status = async () => ({ status: stop ? 'cancelled' : 'a-new-incompatible-state' });
    const q = makeQueue(t, client);
    await assert.rejects(submit(q, 'one').finished, { code:'INVALID_RUN_STATUS' });
    assert.equal(stop, true);
});
test('an admission retry cannot exceed the configured run deadline indefinitely', async t => {
    let calls = 0; const client = simpleClient();
    client.start = async (_, options) => {
        calls++; assert.ok(options.timeoutMs <= 15);
        await wait(20); throw new HermesError('HTTP_TIMEOUT', 'timeout', { remoteUnknown:true, retryable:true });
    };
    const q = makeQueue(t, client, { jobTimeoutMs:15, startRetries:10 });
    await assert.rejects(submit(q, 'one').finished, { code:'JOB_TIMEOUT' });
    assert.equal(calls, 1);
});
