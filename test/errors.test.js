'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HermesError, publicError, redact } = require('../lib/errors');

// The upstream machine-readable reason (`{error:{code}}`) is the only upstream field that is
// allowed to survive as a *code*: it must never be free-form text, a credential or a log-line
// forgery. These tests pin the single validation rule that both lib/errors.js entry points use.

test('HermesError keeps a validated upstream errorCode and drops everything else', () => {
    assert.equal(new HermesError('HTTP_409', 'Nothing is pending.', { errorCode: 'approval_not_pending' }).errorCode, 'approval_not_pending');
    assert.equal(new HermesError('HTTP_409', 'Nothing is pending.', { errorCode: 'run_approval.not-pending_1' }).errorCode, 'run_approval.not-pending_1');
    for (const bad of [undefined, null, '', 'approval_not_pending ', 'APPROVAL_NOT_PENDING', 'approval not pending', 'a'.repeat(65), 'Bearer nope', '<script>', 42, true, {}, [], ['x']]) {
        assert.equal(new HermesError('HTTP_400', 'Rejected.', { errorCode: bad }).errorCode, undefined, `must drop ${JSON.stringify(bad) ?? String(bad)}`);
        assert.equal(Object.hasOwn(new HermesError('HTTP_400', 'Rejected.', { errorCode: bad }), 'errorCode'), false);
    }
});

test('publicError projects the upstream code only when it is safe, and never invents one', () => {
    assert.deepEqual(
        publicError(new HermesError('HTTP_409', 'Nothing is pending.', { statusCode: 409, errorCode: 'approval_not_pending' })),
        { code: 'HTTP_409', message: 'Nothing is pending.', statusCode: 409, retryable: false, remoteUnknown: false, errorCode: 'approval_not_pending' }
    );
    assert.equal(Object.hasOwn(publicError(new HermesError('HTTP_409', 'Nothing is pending.')), 'errorCode'), false);
    // A plain object that bypassed the constructor is validated again on the way out, and a
    // non-string can never reach the point where it could throw or be coerced.
    assert.equal(Object.hasOwn(publicError({ code: 'HTTP_400', message: 'x', errorCode: 'Bearer abcdef' }), 'errorCode'), false);
    const hostile = { code: 'HTTP_400', message: 'x', errorCode: { toString() { throw new Error('coerced'); } } };
    assert.doesNotThrow(() => publicError(hostile));
    assert.equal(Object.hasOwn(publicError(hostile), 'errorCode'), false);
});

test('an error round-trips through publicError without losing the upstream code', () => {
    // nodes/hermes.js rebuilds a HermesError from the sanitized public shape for Catch traces,
    // so the code has to survive that hop to stay actionable downstream of the Agent node.
    const safe = publicError(new HermesError('HTTP_409', 'Nothing is pending.', { statusCode: 409, retryable: false, errorCode: 'approval_not_pending' }));
    const rebuilt = new HermesError(safe.code, safe.message, safe);
    assert.equal(rebuilt.errorCode, 'approval_not_pending');
    assert.equal(publicError(rebuilt).errorCode, 'approval_not_pending');
});

test('redaction stays the single choke point for upstream text', () => {
    // The code is validated, never redacted or truncated: an operator must be able to match it
    // exactly. Free-form text still collapses and caps as before.
    assert.equal(redact('upstream says:\nERROR\r\ntoken fixture-only-secret sk-abcdefghijklmnop'), 'upstream says: ERROR token fixture-only-secret [REDACTED]');
    assert.equal(redact('x'.repeat(700)).length, 600);
});
