'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { HermesQueue } = require('../lib/queue');
const { HermesError } = require('../lib/errors');
const { prepareRequest } = require('../lib/request');

async function until(check) {
    const deadline = AbortSignal.timeout(3000);
    while (!check()) await delay(5, undefined, { signal: deadline });
}
function queue(t, client, options = {}) {
    const q = new HermesQueue({ clientFor: () => client, pollIntervalMs: 5, stopTimeoutMs: 1000, jobTimeoutMs: 5000, retryDelayMs: 5, ...options });
    t.after(() => q.close());
    return q;
}
function submit(q, input = 'test', ownerId = 'agent') {
    const ticket = q.enqueue({ ownerId, connectionId: 'connection', spec: prepareRequest(input, { clientId: ownerId }), message: { payload: input } });
    ticket.finished.catch(() => {});
    return ticket;
}

test('cancel interrupts a long poll sleep but keeps the global slot until termination', async t => {
    let stopped = false;
    let terminal = false;
    const starts = [];
    const q = queue(t, {
        start: async body => { starts.push(body.input); return { run_id: body.input }; },
        status: async id => ({ status: id === 'new' ? 'completed' : terminal ? 'cancelled' : 'running', output: 'Done.' }),
        stop: async () => { stopped = true; return { status: 'stopping' }; }
    }, { pollIntervalMs: 10000 });
    const old = submit(q, 'old');
    await until(() => q.active?.delayController);
    q.reset();
    const next = submit(q, 'new');
    await until(() => stopped);
    assert.deepEqual(starts, ['old']);
    assert.equal(q.snapshot().active.runId, 'old');
    terminal = true;
    await assert.rejects(old.finished, error => error.code === 'CANCELLED' && !error.remoteUnknown);
    assert.equal((await next.finished).output, 'Done.');
    assert.deepEqual(starts, ['old', 'new']);
});

test('cancel after definitive admission rejection does not retry new work', async t => {
    let calls = 0;
    const q = queue(t, {
        start: async () => { calls++; throw new HermesError('HTTP_429', 'busy', { retryable: true }); }
    }, { retryDelayMs: 10000 });
    const ticket = submit(q);
    await until(() => q.active?.delayController);
    q.reset();
    await assert.rejects(ticket.finished, error => error.code === 'CANCELLED' && !error.remoteUnknown);
    assert.equal(calls, 1);
    assert.equal(q.snapshot().uncertain, null);
});

test('cancel after ambiguous admission still resolves the idempotent run before stopping', async t => {
    const keys = [];
    const stopped = [];
    const q = queue(t, {
        start: async (_body, options) => {
            keys.push(options.headers['Idempotency-Key']);
            if (keys.length === 1) throw new HermesError('NETWORK', 'lost response', { retryable: true, remoteUnknown: true });
            return { run_id: 'existing-run' };
        },
        status: async () => ({ status: 'cancelled' }),
        stop: async id => { stopped.push(id); return {}; }
    }, { retryDelayMs: 10000 });
    const ticket = submit(q);
    await until(() => q.active?.delayController);
    q.reset();
    await assert.rejects(ticket.finished, { code: 'CANCELLED' });
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.deepEqual(stopped, ['existing-run']);
});

test('cancel of the active run by requestId holds the slot until remote termination is confirmed', { timeout: 30000 }, async t => {
    let terminal = false;
    let stopped = false;
    const starts = [];
    const q = queue(t, {
        start: async body => { starts.push(body.input); return { run_id: body.input }; },
        status: async id => ({ status: id === 'old' ? (terminal ? 'cancelled' : 'running') : 'completed', output: 'Done.' }),
        stop: async () => { stopped = true; return { status: 'stopping' }; }
    }, { pollIntervalMs: 10000 });
    const old = submit(q, 'old');
    await until(() => q.active?.delayController);
    const result = q.control('cancel', { requestId: old.requestId });
    assert.deepEqual(result, { action: 'cancel', cancellationRequested: true, requestId: old.requestId }, 'cancelling the active run is a request, not an immediate release');
    const next = submit(q, 'new');
    await until(() => stopped);
    assert.deepEqual(starts, ['old'], 'follow-up work is not admitted during the barrier');
    assert.equal(q.snapshot().active.runId, 'old', 'the slot stays reserved');
    assert.equal(q.snapshot().pending, 1);
    terminal = true;
    await assert.rejects(old.finished, error => error.code === 'CANCELLED' && !error.remoteUnknown);
    assert.equal((await next.finished).output, 'Done.');
    assert.deepEqual(starts, ['old', 'new']);
    assert.equal(q.snapshot().uncertain, null);
});

test('pause aborts a scheduled cooldown and resume admits exactly once', async t => {
    let calls = 0;
    const q = queue(t, {
        start: async () => { calls++; return { run_id: 'r' }; },
        status: async () => ({ status: 'completed', output: 'Done.' })
    }, { cooldownMs: 30 });
    q.lastStartedAt = Date.now();
    const ticket = submit(q);
    q.control('pause');
    await delay(50);
    assert.equal(calls, 0);
    q.control('resume');
    await ticket.finished;
    assert.equal(calls, 1);
    assert.equal(q.startDelay, null);
});

test('shutdown interrupts timer waits, settles pending jobs, and is idempotent', async t => {
    let stops = 0;
    const q = queue(t, {
        start: async () => ({ run_id: 'r' }),
        status: async () => ({ status: 'running' }),
        stop: async () => { stops++; return {}; }
    }, { pollIntervalMs: 10000 });
    const active = submit(q);
    const pending = submit(q, 'pending');
    await until(() => q.active?.delayController);
    const firstClose = q.close();
    assert.equal(firstClose, q.close());
    await firstClose;
    await assert.rejects(active.finished, { code: 'QUEUE_CLOSED' });
    await assert.rejects(pending.finished, { code: 'CANCELLED' });
    await until(() => q.executions.size === 0);
    assert.equal(stops, 1);
    assert.equal(q.startDelay, null);
    assert.equal(q.closed, true);
    assert.throws(() => submit(q), { code: 'QUEUE_CLOSED' });
});

test('late admission after shutdown is stopped and cannot produce a final answer', async t => {
    const gate = Promise.withResolvers();
    const stops = [];
    const q = queue(t, {
        start: async () => gate.promise,
        stop: async id => { stops.push(id); return {}; }
    });
    const ticket = submit(q);
    await until(() => q.active?.client);
    await q.close();
    gate.resolve({ run_id: 'late' });
    await assert.rejects(ticket.finished, { code: 'QUEUE_CLOSED' });
    await until(() => stops.length === 1);
    assert.deepEqual(stops, ['late']);
});

test('429 admission retries back off, so a later attempt waits longer than the one before', async t => {
    const starts = [];
    const retries = [];
    const q = queue(t, {
        start: async () => { starts.push(Date.now()); throw new HermesError('HTTP_429', 'at capacity', { statusCode: 429, retryable: true }); }
    }, { retryDelayMs: 40, startRetries: 2 });
    q.on('progress', (_job, event) => { if (event.status === 'retrying') retries.push(event); });
    await assert.rejects(submit(q).finished, { code: 'HTTP_429' });
    assert.equal(starts.length, 3, 'every scheduled admission attempt is made');
    assert.deepEqual(retries.map(event => [event.operation, event.attempt, event.delayMs]),
        [['start', 1, 40], ['start', 2, 80]], 'the lifecycle event reports the delay actually scheduled');
    // Elapsed time is only weak evidence here, and deliberately not asserted tightly: a timer
    // can fire a little before its requested expiry, so a bound sitting on the scheduled value
    // itself would fail on a loaded CI runner while the behaviour was correct. The exact
    // schedule is proven by delayMs above; this only proves the waits really elapsed and grew.
    const waits = [starts[1] - starts[0], starts[2] - starts[1]];
    assert.ok(waits[0] >= 30 && waits[1] >= 60, `scheduled waits were not honoured: ${waits}`);
    assert.ok(waits[1] > waits[0], `the second wait (${waits[1]}ms) must exceed the first (${waits[0]}ms)`);
    assert.ok(waits[1] < 160, `a backoff wait must stay inside its schedule: ${waits}`);
});

test('a retryable admission failure that is not 429 keeps the flat configured delay', async t => {
    const retries = [];
    const q = queue(t, {
        start: async () => { throw new HermesError('HTTP_503', 'unavailable', { statusCode: 503, retryable: true }); }
    }, { retryDelayMs: 20, startRetries: 2 });
    q.on('progress', (_job, event) => { if (event.status === 'retrying') retries.push(event); });
    await assert.rejects(submit(q).finished, { code: 'HTTP_503' });
    assert.deepEqual(retries.map(event => event.delayMs), [20, 20], 'backoff is deliberately limited to 429');
});

test('a reset during a backoff wait does not sleep past the cancellation', async t => {
    const q = queue(t, {
        start: async () => { throw new HermesError('HTTP_429', 'at capacity', { statusCode: 429, retryable: true }); }
    }, { retryDelayMs: 4000, startRetries: 2 });
    const ticket = submit(q);
    await until(() => q.active?.delayController);
    const cancelledAt = Date.now();
    q.reset();
    await assert.rejects(ticket.finished, error => error.code === 'CANCELLED' && !error.remoteUnknown);
    // Generous on purpose: the correct path settles within a few ms, so this bound only fails
    // if the wait outlived the cancellation. A tight bound would fail on a stalled runner
    // without the behaviour being wrong.
    assert.ok(Date.now() - cancelledAt < 2000, 'the scheduled backoff must not outlive the reset');
});
