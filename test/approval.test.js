'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { HermesClient } = require('../lib/client');
const { HermesQueue } = require('../lib/queue');
const { prepareRequest } = require('../lib/request');
const { APPROVAL_CHOICES, allowedChoices, pendingApproval, approvalSubmission } = require('../lib/approval');
const { publicError } = require('../lib/errors');
const approvalFixtures = require('./support/fixtures/approval.json');
const waitingFixture = require('./support/fixtures/run-waiting-approval.json');

// The committed fixture's decision id: a 32-character hex string, exactly what
// `tools/approval_gateway_wait.py` produces for one decision (docs/hermes-api-contract.md).
const ID = waitingFixture.approval.request_id;
const OTHER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ALL = ['once', 'session', 'always', 'deny'];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
    for (let i = 0; i < 400; i++) { if (fn()) return; await wait(5); }
    throw new Error('Test condition timed out');
}

/**
 * A run status response as the server sends it while one decision is pending. The approval object
 * is only present with `status: 'waiting_for_approval'`, and answering it returns the run to
 * `running`, so a later decision reuses that status string with a new `request_id`.
 */
const waiting = (requestId = ID, choices = ALL, extra = {}) => ({
    status: 'waiting_for_approval',
    approval: { request_id: requestId, command: 'mock command', description: 'mock reason', choices, ...extra }
});
const NO_OBJECT = { status: 'waiting_for_approval' };
const RUNNING = { status: 'running' };
const DONE = { status: 'completed', output: 'Done.' };

/** One async job walking a scripted status sequence, with every lifecycle event recorded. */
function scripted(t, replies, options = {}) {
    const { key, ...queueOptions } = options;
    const state = { polls: 0 };
    const approvals = [];
    const client = {
        // The queue is allowed to know the key only as a redaction secret for the opt-in preview.
        getKey: () => key || '',
        start: async () => ({ run_id: 'run-1' }),
        status: async () => {
            const reply = replies[Math.min(state.polls++, replies.length - 1)];
            return typeof reply === 'function' ? reply() : reply;
        },
        stop: async () => ({ status: 'stopping' }),
        // The queue answering a decision would be the bug this suite exists to catch.
        approve: async decision => { approvals.push(decision); throw new Error('the queue answered an approval'); }
    };
    const q = new HermesQueue({
        clientFor: () => client, pollIntervalMs: 5, jobTimeoutMs: 4000, stopTimeoutMs: 40,
        retryDelayMs: 5, requestTimeoutMs: 100, ...queueOptions
    });
    t.after(() => q.close());
    const events = [];
    q.on('progress', (_job, event) => events.push(event));
    const ticket = q.enqueue({
        ownerId: 'node-1', connectionId: 'server-1',
        spec: prepareRequest('prompt', { clientId: 'client-1' }, { mode: 'async' }),
        message: { payload: 'SECRET_PROMPT' }
    });
    ticket.finished.catch(() => {});
    return { q, client, events, approvals, ticket, state };
}

/** The lifecycle events that reported a pending decision, for one status script. */
async function pendingEvents(t, replies, options = {}) {
    const { events, ticket } = scripted(t, replies, options);
    await ticket.finished;
    return events.filter(event => event.status === 'waiting_for_approval');
}

// --- the queue observes every distinct decision, and answers none of them --------------------

test('two decisions on one run are both observable even when no running poll is seen', async t => {
    // The intervening `running` is deliberately absent: the server returns the run to `running`
    // when a decision is answered, so a poll can catch only the two waiting states. Comparing the
    // status string alone reports one event here, which is the defect identity detection fixes.
    const { events, approvals, ticket } = scripted(t, [waiting(ID), waiting(OTHER), DONE]);
    await ticket.finished;
    const pending = events.filter(event => event.status === 'waiting_for_approval');
    assert.equal(events.some(event => event.status === 'running'), false, 'the fixture never reported running');
    assert.equal(pending.length, 2, 'each distinct decision is observable');
    assert.deepEqual(pending.map(event => event.approvalRequestId), [ID, OTHER]);
    assert.deepEqual(pending.map(event => event.approvalChoices), [ALL, ALL]);
    assert.deepEqual(pending.map(event => [event.requestId, event.runId]), [[ticket.requestId, 'run-1'], [ticket.requestId, 'run-1']]);
    assert.deepEqual(approvals, [], 'the queue never answers a decision');
});

test('a decision that is still pending is reported once, not on every poll', async t => {
    const { events, approvals, state, ticket } = scripted(t, [waiting(ID), waiting(ID), waiting(ID), DONE]);
    await ticket.finished;
    assert.equal(events.filter(event => event.status === 'waiting_for_approval').length, 1, 'one identity, one event');
    assert.equal(state.polls, 4, 'the run really was polled repeatedly');
    assert.deepEqual(approvals, []);
});

test('a new decision after an answered one is reported again, in either id order', async t => {
    const forward = await pendingEvents(t, [waiting(ID), RUNNING, waiting(OTHER), DONE]);
    assert.deepEqual(forward.map(event => event.approvalRequestId), [ID, OTHER]);
    const reversed = await pendingEvents(t, [waiting(OTHER), RUNNING, waiting(ID), DONE]);
    assert.deepEqual(reversed.map(event => event.approvalRequestId), [OTHER, ID]);
});

test('an approval-bearing run is polled without this package ever answering it', async t => {
    const { ticket, approvals } = scripted(t, [waiting(ID), RUNNING, DONE]);
    assert.equal((await ticket.finished).output, 'Done.');
    assert.deepEqual(approvals, []);
});

test('waiting for a decision still holds the slot until the run is terminal', async t => {
    let terminal = false;
    const starts = [];
    const pending = { status: 'waiting_for_approval', approval: { request_id: ID, choices: ['once', 'deny'] } };
    const client = {
        start: async body => { starts.push(body.input); return { run_id: body.input }; },
        status: async id => id !== 'old' ? { status: 'completed', output: 'Done.' }
            : terminal ? { status: 'cancelled' } : pending,
        stop: async () => ({ status: 'stopping' }),
        approve: async () => { throw new Error('the queue answered an approval'); }
    };
    const q = new HermesQueue({ clientFor: () => client, pollIntervalMs: 5, stopTimeoutMs: 2000, jobTimeoutMs: 5000 });
    t.after(() => q.close());
    const submit = input => {
        const ticket = q.enqueue({ ownerId: 'node-1', connectionId: 'server-1', spec: prepareRequest(input, { clientId: 'client-1' }), message: { payload: input } });
        ticket.finished.catch(() => {});
        return ticket;
    };
    const old = submit('old');
    await until(() => q.active?.approval?.requestId === ID);
    q.reset();
    const next = submit('new');
    await until(() => q.active?.cancelRequested === 'cancel');
    assert.deepEqual(starts, ['old'], 'follow-up work is not admitted during the barrier');
    assert.equal(q.snapshot().active.runId, 'old', 'the slot stays reserved');
    assert.equal(q.snapshot().pending, 1);
    terminal = true;
    await assert.rejects(old.finished, error => error.code === 'CANCELLED' && !error.remoteUnknown);
    assert.equal((await next.finished).output, 'Done.');
    assert.deepEqual(starts, ['old', 'new']);
    assert.equal(q.snapshot().uncertain, null);
});

// --- nothing is invented, and nothing upstream is copied -------------------------------------

test('a waiting run with no approval object is reported once and given no invented identity', async t => {
    const pending = await pendingEvents(t, [NO_OBJECT, NO_OBJECT, DONE]);
    assert.equal(pending.length, 1, 'a decision with no identity cannot be distinguished, so it is reported once');
    assert.equal(Object.hasOwn(pending[0], 'approvalRequestId'), false, 'no id is fabricated');
    assert.equal(Object.hasOwn(pending[0], 'approvalChoices'), false, 'nothing was advertised, so nothing is claimed');
    assert.doesNotMatch(JSON.stringify(pending[0]), /approval(RequestId|Choices|Command|Description)/);
});

test('an unusable request_id is dropped rather than truncated or fabricated', async t => {
    const cases = [
        ['longer than the server accepts', { request_id: 'x'.repeat(257), choices: ['once'] }],
        ['not the documented character class', { request_id: 'has space', choices: ['once'] }],
        ['not a string', { request_id: 42, choices: ['once'] }],
        ['empty', { request_id: '', choices: ['once'] }],
        ['absent', { choices: ['once'] }]
    ];
    for (const [why, approval] of cases) {
        const pending = await pendingEvents(t, [{ status: 'waiting_for_approval', approval }, DONE]);
        assert.equal(pending.length, 1, why);
        assert.equal(Object.hasOwn(pending[0], 'approvalRequestId'), false, why);
        assert.deepEqual(pending[0].approvalChoices, ['once'], why);
        assert.doesNotMatch(JSON.stringify(pending[0]), /xxxxxx/, why);
    }
    for (const approval of [undefined, null, 'approval-not-an-object', 7, []]) {
        const pending = await pendingEvents(t, [{ status: 'waiting_for_approval', approval }, DONE]);
        assert.equal(pending.length, 1, String(approval));
        assert.doesNotMatch(JSON.stringify(pending[0]), /approval(RequestId|Choices)/, String(approval));
    }
});

test('a decision with no usable request_id is surfaced but never made addressable', async t => {
    // An approval object whose id the queue could not report still produces one informational
    // event, and it must not leave anything a lookup can resolve: two absent values comparing
    // equal must never be what authorises an approval.
    const unaddressable = { status: 'waiting_for_approval', approval: { request_id: 'x'.repeat(257), choices: ['once'] } };
    const { q, events, ticket } = scripted(t, [unaddressable], { jobTimeoutMs: 400, stopTimeoutMs: 20 });
    // Waiting on the reported decision is what proves the poll really ran: the job lookup no longer
    // exposes a phase at all, and a claim that was never taken would also read as null.
    await until(() => events.some(event => event.status === 'waiting_for_approval'));
    assert.equal(events.filter(event => event.status === 'waiting_for_approval').length, 1, 'surfaced once, informationally');
    assert.equal(q.activeJob(ticket.requestId).approval, null, 'nothing here can be answered');
    await assert.rejects(ticket.finished, { code: 'JOB_TIMEOUT' });
});

test('approvalChoices is only ever the literals the server advertised for that decision', async t => {
    const cases = [
        [['once', 'bogus', 42, 'once', null, 'deny', 'always'], ['once', 'deny', 'always']],
        [['once', 'deny'], ['once', 'deny']],
        [['deny'], ['deny']],
        [['always', 'session', 'once'], ['always', 'session', 'once']],
        [['once', 'once', 'once'], ['once']],
        [['ONCE', 'Once', 'approve', 'allow'], []],
        [[], []],
        ['once', []],
        [undefined, []],
        [[{ choice: 'once' }], []]
    ];
    for (const [choices, expected] of cases) {
        const upstream = waiting(ID, ALL);
        upstream.approval.choices = choices;
        const pending = await pendingEvents(t, [upstream, DONE]);
        const label = JSON.stringify(choices);
        assert.equal(pending.length, 1, label);
        assert.deepEqual(pending[0].approvalChoices, expected, label);
        assert.notEqual(pending[0].approvalChoices, upstream.approval.choices, `${label}: filtered, never the upstream array`);
    }
});

test('an approval object never reaches a flow whole: only the projected fields exist', async t => {
    const upstream = waiting(ID, ['once', 'deny'], {
        pattern_key: 'mock-destructive-pattern', message_id: 'msg_mock_0001', event: 'approval.request',
        smart_denied: false, allow_session: true, allow_permanent: true, timestamp: 1730000001.5, extra_nested: { secret: 'value' }
    });
    const pending = await pendingEvents(t, [upstream, DONE]);
    assert.deepEqual(Object.keys(pending[0]).sort(), ['approvalChoices', 'approvalRequestId', 'clientId', 'mode', 'requestId', 'runId', 'sessionId', 'status']);
    assert.doesNotMatch(JSON.stringify(pending[0]), /mock-destructive-pattern|msg_mock_0001|smart_denied|allow_session|allow_permanent|extra_nested|SECRET_PROMPT|timestamp/);
});

// --- the preview is opt-in, bounded and redacted --------------------------------------------

const dirty = () => waiting(ID, ['once', 'deny'], {
    command: 'deploy Bearer synthetic-value-never-real sk-abcdefghijklmnop1234\r\nFORGED LOG LINE',
    description: 'd'.repeat(5000),
    pattern_key: 'mock-destructive-pattern'
});
const PREVIEW_KEYS = ['approvalChoices', 'approvalCommand', 'approvalDescription', 'approvalRequestId', 'clientId', 'mode', 'requestId', 'runId', 'sessionId', 'status'];

test('no preview fields exist unless the queue opts in', async t => {
    const pending = await pendingEvents(t, [dirty(), DONE]);
    assert.equal(Object.hasOwn(pending[0], 'approvalCommand'), false);
    assert.equal(Object.hasOwn(pending[0], 'approvalDescription'), false);
    assert.doesNotMatch(JSON.stringify(pending[0]), /deploy|synthetic-value|sk-abcdef|FORGED|mock-destructive-pattern/);
});

test('the preview is redacted, single-line and length-capped', async t => {
    const pending = await pendingEvents(t, [dirty(), DONE], { includeApprovalPreview: true });
    assert.equal(pending[0].approvalCommand, 'deploy Bearer [REDACTED] [REDACTED] FORGED LOG LINE');
    assert.equal(pending[0].approvalDescription, 'd'.repeat(300));
    assert.doesNotMatch(JSON.stringify(pending[0]), /synthetic-value|sk-abcdef|mock-destructive-pattern/);
    assert.doesNotMatch(`${JSON.stringify(pending[0])}${Object.values(pending[0]).join()}`, /[\r\n]/);
    assert.deepEqual(Object.keys(pending[0]).sort(), PREVIEW_KEYS, 'two explicit field reads, never a spread');
});

test('the preview opt-in is a queue setting that no other input can enable', async t => {
    const off = new HermesQueue();
    const on = new HermesQueue({ includeApprovalPreview: true });
    assert.equal(off.includeApprovalPreview, false, 'off unless a queue configuration says so');
    assert.equal(on.includeApprovalPreview, true);
    off.close();
    on.close();
    for (const value of ['true', 1, {}, 'yes']) {
        const pending = await pendingEvents(t, [dirty(), DONE], { includeApprovalPreview: value });
        assert.equal(Object.hasOwn(pending[0], 'approvalCommand'), false, `${String(value)} must not enable the preview`);
    }
    const pending = await pendingEvents(t, [dirty(), DONE], { includeApprovalPreview: true });
    assert.equal(Object.hasOwn(pending[0], 'approvalCommand'), true);
});

// --- the projection is exactly what its docstring says ----------------------------------------

test('a projection stores no request id it cannot use', () => {
    const unusable = pendingApproval({ request_id: 'x'.repeat(257), choices: ['once'] }, {});
    assert.equal(Object.hasOwn(unusable, 'requestId'), false, 'an absent field is omitted, not stored as undefined');
    assert.deepEqual(unusable.choices, ['once']);
    assert.equal(pendingApproval({ request_id: ID, choices: ['once'] }, {}).requestId, ID);
    for (const value of [undefined, null, 'approval', 7, []]) assert.equal(pendingApproval(value, {}), null);
});

test('the preview is redacted with the connection key among the secrets', async t => {
    const command = 'deploy fixture-only-key and Bearer synthetic-value-never-real';
    const raw = { request_id: ID, choices: ['once'], command };
    assert.equal(
        pendingApproval(raw, { includeApprovalPreview: true, secrets: ['fixture-only-key'] }).command,
        'deploy [REDACTED] and Bearer [REDACTED]'
    );
    // With no key to match by name only the generic patterns apply, and they still apply.
    assert.equal(pendingApproval(raw, { includeApprovalPreview: true }).command, 'deploy fixture-only-key and Bearer [REDACTED]');
    // And the queue threads the key of the client that is actually running the job, so a server
    // that echoes its own received key inside a command cannot surface it.
    const pending = await pendingEvents(t, [waiting(ID, ['once'], { command }), DONE], { includeApprovalPreview: true, key: 'fixture-only-key' });
    assert.equal(pending[0].approvalCommand, 'deploy [REDACTED] and Bearer [REDACTED]');
    assert.doesNotMatch(JSON.stringify(pending[0]), /fixture-only-key/);
});

// --- the approval vocabulary has one home, and the node does not restate it -------------------

test('the four decision literals are stated once, in lib/approval.js', () => {
    assert.deepEqual(APPROVAL_CHOICES, ['once', 'session', 'always', 'deny']);
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'nodes', 'hermes.js'), 'utf8'), /'once'|'session'|'always'|'deny'/);
});

test('the node-configured allowlist keeps only exact literals', () => {
    assert.deepEqual([...allowedChoices('once,deny')], ['once', 'deny']);
    assert.deepEqual(allowedChoices(['always', 'bogus', 'ONCE', ' once ', '']), ['always', 'once']);
    assert.deepEqual(allowedChoices('once,once'), ['once']);
    assert.deepEqual(allowedChoices(undefined), [], 'a node that configured nothing may send nothing');
    assert.deepEqual(allowedChoices('approve'), [], 'a server alias is never normalised into a grant');
    assert.deepEqual(allowedChoices({ choice: 'once' }), []);
});

// --- the exact-decision rule a Control node enforces before anything is dispatched -------------

const pendingView = (approvalRequestId = ID, choices = ALL) => ({
    id: 'job-1', runId: 'run-1', connectionId: 'connection-1',
    approval: approvalRequestId ? { requestId: approvalRequestId, choices } : null
});
const allowed = { allowApprove: true, choices: 'once,deny' };
const addressed = { requestId: 'job-1', approvalRequestId: ID, choice: 'once' };

test('an approval submission names one decision and carries only what a POST needs', () => {
    assert.deepEqual(approvalSubmission({ ...allowed, job: pendingView(), control: addressed }), {
        choice: 'once', requestId: 'job-1', approvalRequestId: ID, runId: 'run-1', connectionId: 'connection-1'
    });
    // An array in flow JSON is as good as the editor's comma-separated text.
    assert.deepEqual(approvalSubmission({
        allowApprove: true, choices: ['once', 'deny'], job: pendingView(ID, ['deny', 'once']),
        control: { ...addressed, choice: 'deny' }
    }).choice, 'deny');
});

test('an approval that is not exactly the currently pending decision is refused locally', () => {
    const cases = [
        ['a node with no approval permission at all', {}, pendingView(), addressed, 'OVERRIDE_DISABLED'],
        ['a legacy flow whose field is absent', { choices: 'once' }, pendingView(), addressed, 'OVERRIDE_DISABLED'],
        ['a permission string is not a permission', { allowApprove: 'true', choices: 'once' }, pendingView(), addressed, 'OVERRIDE_DISABLED'],
        ['a node that allows no choice', { allowApprove: true }, pendingView(), addressed, 'OVERRIDE_DISABLED'],
        ['a node whose allowlist is all garbage', { allowApprove: true, choices: 'yolo' }, pendingView(), addressed, 'OVERRIDE_DISABLED'],
        ['a choice the node does not allow', allowed, pendingView(), { ...addressed, choice: 'always' }, 'OVERRIDE_DISABLED'],
        ['a choice the server did not advertise for this decision', allowed, pendingView(ID, ['once']), { ...addressed, choice: 'deny' }, 'OVERRIDE_DISABLED'],
        ['a decision advertising no choices', allowed, pendingView(ID, []), addressed, 'OVERRIDE_DISABLED'],
        ['no queue job id', allowed, pendingView(), { approvalRequestId: ID, choice: 'once' }, 'INVALID_INPUT'],
        ['no decision id', allowed, pendingView(), { requestId: 'job-1', choice: 'once' }, 'INVALID_INPUT'],
        ['a decision id that is not a string', allowed, pendingView(), { ...addressed, approvalRequestId: 42 }, 'INVALID_INPUT'],
        ['a padded decision id is not the same id', allowed, pendingView(), { ...addressed, approvalRequestId: ` ${ID} ` }, 'INVALID_INPUT'],
        // The failure this rule exists for: a late click arrives after a newer decision replaced it.
        ['a stale decision id', allowed, pendingView(OTHER), addressed, 'INVALID_INPUT'],
        ['a job with nothing pending', allowed, pendingView(null), addressed, 'INVALID_INPUT'],
        ['a job id that resolves to no active job', allowed, null, addressed, 'REQUEST_NOT_FOUND'],
        ['no choice at all', allowed, pendingView(), { requestId: 'job-1', approvalRequestId: ID }, 'INVALID_INPUT'],
        ['a choice that is not one of the four literals', allowed, pendingView(), { ...addressed, choice: 'approve' }, 'INVALID_INPUT'],
        ['a choice with stray whitespace', allowed, pendingView(), { ...addressed, choice: ' once' }, 'INVALID_INPUT'],
        ['a message that is not an object', allowed, pendingView(), undefined, 'INVALID_INPUT']
    ];
    for (const [why, config, job, control, code] of cases) {
        assert.throws(() => approvalSubmission({ ...config, job, control }), error => {
            assert.equal(error.code, code, why);
            assert.equal(error.retryable, false, why);
            assert.doesNotMatch(error.message, new RegExp(ID), `${why}: an id is never echoed back`);
            return true;
        }, why);
    }
});


// --- the narrow job lookup an approval action needs ------------------------------------------

test('only the current active job is addressable, and only while it is active', async t => {
    const { q, ticket } = scripted(t, [waiting(ID), RUNNING, DONE]);
    const later = q.enqueue({
        ownerId: 'node-2', connectionId: 'server-1',
        spec: prepareRequest('later', { clientId: 'client-2' }, { mode: 'async' }), message: {}
    });
    later.finished.catch(() => {});
    await until(() => q.activeJob(ticket.requestId));
    const job = q.activeJob(ticket.requestId);
    assert.equal(job.id, ticket.requestId);
    assert.equal(job.runId, 'run-1');
    assert.equal(job.approval.requestId, ID, 'the one decision a flow may answer right now');
    assert.deepEqual(job.approval.choices, ALL);
    assert.equal(q.activeJob(later.requestId), null, 'a waiting job is not the active job');
    assert.equal(q.activeJob('not-a-job'), null);
    assert.equal(q.activeJob(), null, 'a missing id never resolves to the active job');
    assert.equal(q.activeJob(null), null);
    await ticket.finished;
    assert.equal(q.activeJob(ticket.requestId), null, 'a finished job is addressable by nothing');
});

test('the job lookup hands out a closed projection, so a prompt is unreachable from it', async t => {
    const { q, ticket } = scripted(t, [waiting(ID), RUNNING, DONE]);
    await until(() => q.activeJob(ticket.requestId));
    const view = q.activeJob(ticket.requestId);
    assert.deepEqual(Object.keys(view).sort(), ['approval', 'connectionId', 'id', 'runId']);
    assert.equal(view.connectionId, 'server-1', 'an approval action routes on this, never on anything in msg');
    // The whole point of the projection: nothing here may be forwarded, logged or answered with.
    assert.equal(Object.hasOwn(view, 'spec'), false, 'the request shape is unreachable');
    assert.equal(Object.hasOwn(view, 'message'), false, 'the prompt is unreachable');
    assert.equal(Object.hasOwn(view, 'body'), false, 'the request body is unreachable');
    assert.equal(Object.hasOwn(view, 'controller'), false, 'a second node cannot abort a job it does not own');
    assert.doesNotMatch(JSON.stringify(view), /SECRET_PROMPT|client-1|idempotency/i);
    assert.throws(() => { view.approval = null; }, TypeError, 'the projection cannot be edited into a claim');
    assert.throws(() => view.approval.choices.push('once'), TypeError, 'advertised choices cannot be widened');
});

test('a terminal poll releases the claim on a decision the run can no longer answer', async t => {
    // Until the terminal status is read, the job's claim is what makes a decision answerable. It
    // used to survive `completed`/`failed`, and only the queue dropping the job a moment later made
    // that harmless  -  a defence-in-depth argument, not an invariant. Now the claim goes with it.
    const terminals = [
        ['completed', DONE],
        ['failed', { status: 'failed' }],
        ['an unrecognized status', { status: 'sideways' }]
    ];
    for (const [why, terminal] of terminals) {
        const { q, events, ticket } = scripted(t, [waiting(ID), terminal]);
        let internal;
        q.on('progress', job => { internal = job; });
        await until(() => events.some(event => event.status === 'waiting_for_approval'));
        assert.equal(internal.approval?.requestId, ID, why);
        await ticket.finished.catch(() => {});
        assert.equal(internal.approval, null, `${why}: the claim is gone with the terminal status`);
    }
});

test('a settled job is addressable by nothing, even as its terminal event is delivered', async t => {
    // `settle()` marks the job settled and emits before the queue clears its active slot, so this
    // is the one moment a finished run is still the queue's active job. It must be unanswerable.
    const { q, ticket } = scripted(t, [waiting(ID), DONE]);
    const addressable = [];
    q.on('progress', (_job, event) => {
        if (event.status === 'completed') addressable.push(q.activeJob(event.requestId) === null);
    });
    await ticket.finished;
    assert.deepEqual(addressable, [true]);
});

test('an answered decision stops being addressable as soon as the run is running again', async t => {
    const { q, ticket } = scripted(t, [waiting(ID), RUNNING, DONE]);
    const seen = [];
    // The scheduler updates the job before it emits, so a listener sees exactly the state a flow
    // may act on: the decision is gone the moment the run is running again.
    q.on('progress', (_job, event) => {
        if (event.status === 'waiting_for_approval' || event.status === 'running') {
            const job = q.activeJob(event.requestId);
            seen.push([event.status, job ? (job.approval ? job.approval.requestId : null) : 'inactive']);
        }
    });
    await ticket.finished;
    assert.deepEqual(seen, [['waiting_for_approval', ID], ['running', null]]);
});

test('the retained uncertain job is never addressable for an approval', async t => {
    const { q, ticket } = scripted(t, [waiting(ID)], { jobTimeoutMs: 20, stopTimeoutMs: 20 });
    await assert.rejects(ticket.finished, error => error.code === 'JOB_TIMEOUT' && error.remoteUnknown);
    assert.equal(q.snapshot().uncertain.status, 'uncertain');
    assert.equal(q.activeJob(ticket.requestId), null, 'an uncertain run cannot be given a decision');
});

test('a synchronous job has no approval and no run to answer for', async t => {
    const gate = Promise.withResolvers();
    const client = {
        chat: async () => { await gate.promise; return { choices: [{ message: { content: 'Done.' } }] }; },
        approve: async () => { throw new Error('the queue answered an approval'); }
    };
    const q = new HermesQueue({ clientFor: () => client, pollIntervalMs: 5, jobTimeoutMs: 4000, requestTimeoutMs: 100 });
    t.after(() => q.close());
    const ticket = q.enqueue({
        ownerId: 'node-3', connectionId: 'server-1',
        spec: prepareRequest('sync', { clientId: 'client-3' }, { mode: 'sync' }), message: {}
    });
    ticket.finished.catch(() => {});
    await until(() => q.activeJob(ticket.requestId));
    assert.equal(q.activeJob(ticket.requestId).approval, null, 'an explicit null, not a missing field');
    assert.equal(q.activeJob(ticket.requestId).runId, null, 'a sync job has no run to answer for');
    gate.resolve();
    assert.equal((await ticket.finished).output, 'Done.');
    assert.equal(q.activeJob(ticket.requestId), null);
});

// --- the client's exact-decision call --------------------------------------------------------

async function fixture(t, handler, profile = 'work') {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            calls.push({
                method: req.method, url: req.url, authorization: req.headers.authorization,
                body: body.length ? JSON.parse(body) : undefined
            });
            handler(req, res);
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new HermesClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, profile, getKey: () => 'test-only-secret', requestTimeoutMs: 1000 });
    t.after(async () => { client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    return { client, calls };
}

const ok = (_req, res) => res.end(JSON.stringify(approvalFixtures.success.body));

test('approve posts only the choice and the exact request id, under the profile scope', async t => {
    const { client, calls } = await fixture(t, ok);
    const data = await client.approve('run/one', { choice: 'once', requestId: ID });
    assert.deepEqual(calls, [{
        method: 'POST',
        url: '/p/work/v1/runs/run%2Fone/approval',
        authorization: 'Bearer test-only-secret',
        body: { choice: 'once', request_id: ID }
    }]);
    assert.deepEqual(data, approvalFixtures.success.body);
});

test('approve sends exactly two fields however much the caller adds', async t => {
    const { client, calls } = await fixture(t, ok);
    for (const choice of ALL) {
        await client.approve('run-1', { choice, requestId: ID, all: true, resolve_all: true, scope: 'room', note: 'free text' });
    }
    assert.deepEqual(calls.map(call => call.body), ALL.map(choice => ({ choice, request_id: ID })));
});

test('an invalid decision never reaches the network', async t => {
    const { client, calls } = await fixture(t, (_req, res) => { res.writeHead(500); res.end('{}'); });
    const invalid = [
        ['a server alias is not an advertised choice', { choice: 'approve', requestId: ID }],
        ['no case folding', { choice: 'ONCE', requestId: ID }],
        ['no trimming', { choice: ' once', requestId: ID }],
        ['never a set of choices', { choice: 'once,deny', requestId: ID }],
        ['not a string', { choice: true, requestId: ID }],
        ['no choice', { requestId: ID }],
        ['no request id', { choice: 'once' }],
        ['empty request id', { choice: 'once', requestId: '' }],
        ['request id longer than the server accepts', { choice: 'once', requestId: 'x'.repeat(257) }],
        ['request id is not a string', { choice: 'once', requestId: 42 }],
        ['padded request id', { choice: 'once', requestId: ` ${ID} ` }],
        ['request id carrying a newline', { choice: 'once', requestId: `${ID}\n` }]
    ];
    for (const [why, decision] of invalid) {
        await assert.rejects(client.approve('run-1', decision), error => {
            assert.equal(error.code, 'INVALID_INPUT', why);
            assert.equal(error.retryable, false, why);
            assert.equal(error.remoteUnknown, false, why);
            assert.doesNotMatch(error.message, new RegExp(ID), why);
            return true;
        }, why);
    }
    for (const runId of [undefined, '', 'has space', 'x'.repeat(201), 'run\ninjection', 7]) {
        await assert.rejects(client.approve(runId, { choice: 'once', requestId: ID }), error => {
            assert.equal(error.code, 'INVALID_INPUT');
            assert.doesNotMatch(error.message, new RegExp(ID));
            return true;
        }, String(runId));
    }
    await assert.rejects(client.approve('run-1', undefined), { code: 'INVALID_INPUT' });
    await assert.rejects(client.approve('run-1', 'once'), { code: 'INVALID_INPUT' });
    assert.deepEqual(calls, [], 'nothing was dispatched');
});

for (const name of ['notPending', 'notActive', 'invalidChoice', 'invalidRequest']) {
    test(`approve surfaces the upstream reason code ${approvalFixtures[name].body.error.code}`, async t => {
        const failure = approvalFixtures[name];
        const { client, calls } = await fixture(t, (_req, res) => {
            res.writeHead(failure.status);
            res.end(JSON.stringify(failure.body));
        });
        await assert.rejects(client.approve('run-1', { choice: 'once', requestId: ID }), error => {
            assert.equal(error.code, `HTTP_${failure.status}`);
            assert.equal(error.statusCode, failure.status);
            assert.equal(error.errorCode, failure.body.error.code);
            assert.equal(error.remoteUnknown, false, 'a 4xx answer means the decision was not applied');
            assert.equal(error.retryable, false);
            assert.equal(publicError(error).errorCode, failure.body.error.code);
            return true;
        });
        assert.equal(calls.length, 1);
    });
}

test('an unusable upstream reason code is still dropped on the approval route', async t => {
    const { client } = await fixture(t, (_req, res) => {
        res.writeHead(approvalFixtures.unparseableChoice.status);
        res.end(JSON.stringify(approvalFixtures.unparseableChoice.body));
    });
    await assert.rejects(client.approve('run-1', { choice: 'once', requestId: ID }), error => {
        assert.equal(error.code, 'HTTP_400');
        assert.equal(error.errorCode, undefined);
        assert.equal(Object.hasOwn(publicError(error), 'errorCode'), false);
        assert.doesNotMatch(JSON.stringify(publicError(error)), /Bearer synthetic-value/);
        return true;
    });
});

test('an unknown approval outcome is reported as unknown and is never replayed', async t => {
    const { client, calls } = await fixture(t, (_req, res) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: { message: 'Approval core raised.', type: 'server_error', param: null, code: 'approval_failed' } }));
    });
    await assert.rejects(client.approve('run-1', { choice: 'once', requestId: ID }), error => {
        // Justification for clearing `retryable` here: an approval POST has no idempotency key, so
        // once dispatched its outcome is unknown and a repeat is indistinguishable from answering
        // twice. The server answers a replayed request_id with 409 approval_not_pending, which is
        // the accurate signal; `retryable: true` would only invite the blind replay.
        assert.equal(error.code, 'HTTP_500');
        assert.equal(error.remoteUnknown, true);
        assert.equal(error.retryable, false);
        assert.equal(error.errorCode, 'approval_failed');
        return true;
    });
    assert.equal(calls.length, 1, 'the POST was attempted exactly once');
});

test('a caller cannot move a request between the profile and root URL scopes', async t => {
    const { client, calls } = await fixture(t, (_req, res) => res.end('{}'));
    await client.capabilities({ fromRoot: true });
    await client.request('GET', '/health/detailed', undefined, { fromRoot: true });
    await client.approve('run-1', { choice: 'once', requestId: ID }, { fromRoot: true });
    await client.start({}, { fromRoot: true });
    await client.healthDetailed({ fromRoot: false });
    // Which method the caller used chooses the scope, never `options`: every public method stays
    // in its own scope whatever a caller passes through, and only `healthDetailed` is root-scoped.
    assert.deepEqual(calls.map(call => call.url), [
        '/p/work/v1/capabilities',
        '/p/work/v1/health/detailed',
        '/p/work/v1/runs/run-1/approval',
        '/p/work/v1/runs',
        '/p/work/health/detailed'
    ]);
});

test('the approval route keeps the credential and header allowlist', async t => {
    const { client, calls } = await fixture(t, ok);
    await client.approve('run-1', { choice: 'deny', requestId: ID }, { headers: { Authorization: 'Bearer attacker', 'X-Hermes-Session-Id': 'conversation' } });
    assert.equal(calls[0].authorization, 'Bearer test-only-secret');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/p/work/v1/runs/run-1/approval');
});

test('the queue reads a pending decision from a real run status response', async t => {
    let polls = 0;
    const routes = [];
    const server = http.createServer((req, res) => {
        routes.push(`${req.method} ${req.url}`);
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'POST' && req.url.endsWith('/runs')) {
            res.writeHead(202);
            res.end(JSON.stringify({ run_id: 'run_mock_0001', status: 'started' }));
        } else if (req.url.endsWith('/approval')) {
            res.writeHead(approvalFixtures.notActive.status);
            res.end(JSON.stringify(approvalFixtures.notActive.body));
        } else {
            res.end(JSON.stringify(++polls === 1 ? waitingFixture : { status: 'completed', output: 'Done.' }));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new HermesClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, profile: 'mock', getKey: () => 'test-only-secret', requestTimeoutMs: 1000 });
    const q = new HermesQueue({ clientFor: () => client, pollIntervalMs: 5, jobTimeoutMs: 4000, stopTimeoutMs: 200 });
    t.after(async () => {
        await q.close();
        client.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    const events = [];
    q.on('progress', (_job, event) => events.push(event));
    const ticket = q.enqueue({ ownerId: 'node-1', connectionId: 'server-1', spec: prepareRequest('prompt', { clientId: 'client-1' }, { mode: 'async' }), message: {} });
    assert.equal((await ticket.finished).output, 'Done.');
    const pending = events.filter(event => event.status === 'waiting_for_approval');
    assert.equal(pending.length, 1);
    assert.deepEqual(pending.map(event => event.approvalRequestId), [ID]);
    assert.deepEqual(pending[0].approvalChoices, ALL);
    assert.equal(pending[0].runId, 'run_mock_0001');
    assert.equal(Object.hasOwn(pending[0], 'approvalCommand'), false);
    assert.deepEqual(routes.filter(route => route.endsWith('/approval')), [], 'nothing answered the decision');
});

// --- the structural guarantees this build depends on ----------------------------------------

test('the approval vocabulary has one home, and lib/client.js is transport only', () => {
    const directory = path.join(__dirname, '..', 'lib');
    const files = fs.readdirSync(directory).filter(file => file.endsWith('.js')).sort();
    assert.deepEqual(files, ['approval.js', 'client.js', 'diagnostics.js', 'errors.js', 'queue.js', 'request.js', 'retry.js']);
    // `notDispatched` is the transport's own connect-phase classification, not part of the approval
    // vocabulary: it is exported only so its errno/syscall rules can be pinned without a live socket.
    assert.deepEqual(Object.keys(require('../lib/client')).sort(), ['HermesClient', 'endpoint', 'notDispatched']);
    assert.deepEqual(Object.keys(require('../lib/diagnostics')).sort(), ['approvalSupported', 'projectCapabilities', 'projectReadiness']);
    // check:syntax lists every source explicitly, so a new lib file must be added in its own commit.
    const script = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).scripts['check:syntax'];
    for (const file of files) assert.ok(script.includes(`lib/${file}`), `check:syntax omits lib/${file}`);
});

test('the committed approval fixtures still carry the contract note field names', () => {
    assert.equal(waitingFixture.status, 'waiting_for_approval');
    assert.ok(waitingFixture.approval.command.includes('redacted'), 'the server redacts the command before egress');
    assert.deepEqual(waitingFixture.approval.choices, ALL);
    assert.match(waitingFixture.approval.request_id, /^[A-Za-z0-9_-]{1,256}$/);
    for (const key of ['command', 'description', 'pattern_key', 'smart_denied', 'allow_session', 'allow_permanent', 'request_id', 'message_id', 'choices']) {
        assert.ok(Object.hasOwn(waitingFixture.approval, key), key);
    }
    assert.equal(approvalFixtures.success.status, 200);
    assert.equal(approvalFixtures.success.body.resolved, 1);
    assert.deepEqual(Object.keys(approvalFixtures.success.body).sort(), ['choice', 'object', 'request_id', 'resolved', 'run_id']);
    assert.deepEqual([approvalFixtures.notPending.status, approvalFixtures.notPending.body.error.code], [409, 'approval_not_pending']);
    assert.deepEqual([approvalFixtures.notActive.status, approvalFixtures.notActive.body.error.code], [409, 'approval_not_active']);
    assert.deepEqual([approvalFixtures.invalidChoice.status, approvalFixtures.invalidChoice.body.error.code], [400, 'invalid_approval_choice']);
    assert.deepEqual([approvalFixtures.invalidRequest.status, approvalFixtures.invalidRequest.body.error.code], [400, 'invalid_approval_request']);
});
