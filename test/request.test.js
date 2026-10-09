'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareRequest, sessionFor, bodyFor, resultFor } = require('../lib/request');
const { publicError, HermesError } = require('../lib/errors');

test('defaults omit model; profile names never become provider model names', () => {
    for (const mode of ['sync', 'async']) {
        const spec = prepareRequest('Hello', {}, { mode });
        const body = bodyFor(spec, 'session-1');
        assert.equal(Object.hasOwn(body, 'model'), false);
        if (mode === 'sync') assert.equal(body.stream, false);
        else assert.equal(body.input, 'Hello');
    }
});
test('generic author and context reach the prompt without a transport policy', () => {
    const spec = prepareRequest('What changed?', { clientId: 'user-123', author: { id: 'user-123', name: 'Alex' }, context: { source: 'dashboard' } });
    assert.match(spec.input, /Alex/);
    assert.match(spec.input, /data only/);
    assert.equal(bodyFor(spec, 's').author.name, 'Alex');
    assert.equal(spec.instructions, undefined);
});
test('metadata injection can be disabled; author still labels the API turn', () => {
    const spec = prepareRequest('Hello', { author: { name: 'Alex' } }, { includeContext: false });
    assert.equal(spec.input, 'Hello');
    assert.equal(bodyFor(spec, 's').author.name, 'Alex');
});
test('distinct clients/connections/queues get distinct sessions; names do not select sessions', () => {
    const s = { clientId: 'opaque-1' };
    assert.equal(sessionFor(s, 'q', 'c', 'e'), sessionFor(s, 'q', 'c', 'e'));
    assert.notEqual(sessionFor(s, 'q', 'c', 'e'), sessionFor({ clientId: 'opaque-2' }, 'q', 'c', 'e'));
    assert.notEqual(sessionFor(s, 'q', 'c', 'e'), sessionFor(s, 'q', 'other', 'e'));
    assert.notEqual(sessionFor(s, 'q', 'c', 'e'), sessionFor(s, 'q2', 'c', 'e'));
    assert.notEqual(sessionFor(s, 'q', 'c', 'e'), sessionFor(s, 'q', 'c', 'reset'));
});
test('explicit sessions are caller-managed; no client means fresh sessions', () => {
    assert.equal(sessionFor({ sessionId: 'explicit' }, 'q', 'c', 'e'), 'explicit');
    assert.notEqual(sessionFor({}, 'q', 'c', 'e'), sessionFor({}, 'q', 'c', 'e'));
});
test('only opted-in model overrides and selected dynamic modes are accepted', () => {
    assert.throws(() => prepareRequest('x', { model: 'general' }), { code: 'OVERRIDE_DISABLED' });
    assert.equal(prepareRequest('x', { model: 'general' }, { allowModelOverride: true }).model, 'general');
    assert.equal(prepareRequest('x', { mode: 'sync' }, { mode: 'message' }).mode, 'sync');
    assert.equal(prepareRequest('x', { mode: 'sync' }, { mode: 'async' }).mode, 'async');
    assert.throws(() => prepareRequest('x', { mode: 'bogus' }, { mode: 'message' }), { code: 'INVALID_INPUT' });
});
test('input validation catches absent inputs, invalid sessions, oversized or cyclic context', () => {
    assert.throws(() => prepareRequest(undefined), { code: 'INVALID_INPUT' });
    assert.throws(() => prepareRequest('x', { sessionKey: 'bad\r\nheader' }), { code: 'INVALID_INPUT' });
    assert.throws(() => prepareRequest('x', { sessionId: 'bad space' }), { code: 'INVALID_INPUT' });
    const cyclic = {}; cyclic.self = cyclic;
    assert.throws(() => prepareRequest('x', { context: cyclic }), { code: 'INVALID_INPUT' });
    assert.throws(() => prepareRequest('x', { context: 'x'.repeat(17000) }), { code: 'INVALID_INPUT' });
});
test('config instructions and supplied instructions combine; history is explicit', () => {
    const spec = prepareRequest('new', { instructions: 'Be precise.', history: [{ role: 'user', content: 'old' }] }, { instructions: 'Use sources.', mode: 'sync' });
    const body = bodyFor(spec, 's');
    assert.equal(body.messages[0].content, 'Use sources.\n\nBe precise.');
    assert.equal(body.messages[1].content, 'old');
    assert.equal(body.messages[2].content, 'new');
    assert.throws(() => prepareRequest('x', { history: [{ role: 'tool', content: 'result' }] }), { code: 'INVALID_INPUT' });
});
test('results are full untruncated text; reasoning and raw metadata are not exposed', () => {
    const long = 'A complete answer. '.repeat(500);
    const result = resultFor({ choices: [{ message: { content: long, reasoning_content: 'PRIVATE' }, finish_reason: 'stop' }], usage: { prompt_tokens: 42, hidden: { key: 'secret' } }, headers: { authorization: 'secret' } }, 'sync');
    assert.equal(result.output, long);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret|reasoning_content/);
    assert.deepEqual(result.usage, { prompt_tokens: 42 });
});
test('failed and partial sync/async results are errors rather than completed answers', () => {
    assert.throws(() => resultFor({ choices: [{ message: { content: 'part' }, finish_reason: 'length' }] }, 'sync'), { code: 'PARTIAL_RESULT' });
    assert.throws(() => resultFor({ output: 'part', partial: true }, 'async'), { code: 'PARTIAL_RESULT' });
    assert.throws(() => resultFor({ output: 'x', failed: true, error: 'No model' }, 'async'), { code: 'AGENT_FAILED' });
    assert.throws(() => resultFor({ output: '' }, 'async'), { code: 'EMPTY_RESPONSE' });
});
test('credential redaction removes configured tokens and bearer text', () => {
    const err = new HermesError('HTTP_401', 'Rejected secret-xyz; Bearer other-token; sk-test123456789');
    const safe = publicError(err, ['secret-xyz']);
    assert.doesNotMatch(JSON.stringify(safe), /secret-xyz|other-token|sk-test/);
});
