'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { admissionRetryDelay } = require('../lib/retry');

const CEILING_MS = 60000;
const run = (baseMs, count, options = {}) => Array.from(
    { length: count }, (_unused, retryIndex) => admissionRetryDelay({ baseMs, retryIndex, ...options })
);
const sum = delays => delays.reduce((total, ms) => total + ms, 0);

test('429 admission retries back off exponentially from the configured base delay', () => {
    assert.deepEqual(run(2000, 5, { statusCode: 429 }), [2000, 4000, 8000, 16000, 32000]);
    assert.deepEqual(run(1000, 3, { statusCode: 429 }), [1000, 2000, 4000]);
});

test('the 429 schedule is capped at 60 seconds, so ten retries wait 362 seconds', () => {
    const schedule = run(2000, 10, { statusCode: 429 });
    assert.deepEqual(schedule, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000, 60000]);
    assert.equal(sum(schedule), 362000);
    // Absurd retry indices must stay on the ceiling instead of overflowing the schedule.
    assert.equal(admissionRetryDelay({ baseMs: 2000, retryIndex: 2000, statusCode: 429, remainingMs: 3600000 }), CEILING_MS);
});

test('an explicit retry delay above the 60 second ceiling is never shortened by backoff', () => {
    assert.equal(admissionRetryDelay({ baseMs: 90000, retryIndex: 0, statusCode: 429, remainingMs: 3600000 }), 90000);
    assert.equal(admissionRetryDelay({ baseMs: 90000, retryIndex: 1, statusCode: 429, remainingMs: 3600000 }), 90000);
    assert.deepEqual(run(120000, 3, { statusCode: 429 }), [120000, 120000, 120000]);
});

test('a retryable status that is not 429 keeps the flat base delay at any retry index', () => {
    for (const statusCode of [500, 502, 503, 504, 408, 0]) {
        assert.deepEqual(run(2000, 4, { statusCode }), [2000, 2000, 2000, 2000], `HTTP ${statusCode}`);
    }
    // A retry without an HTTP status (transport failure) is treated the same way.
    assert.deepEqual(run(2000, 2, { statusCode: undefined }), [2000, 2000]);
    assert.deepEqual(run(2000, 2, {}), [2000, 2000]);
});

test('the delay is clamped to the remaining job deadline and never goes negative', () => {
    assert.equal(admissionRetryDelay({ baseMs: 2000, retryIndex: 0, statusCode: 429, remainingMs: 1500 }), 1500);
    assert.equal(admissionRetryDelay({ baseMs: 2000, retryIndex: 3, statusCode: 429, remainingMs: 5000 }), 5000);
    assert.equal(admissionRetryDelay({ baseMs: 2000, retryIndex: 3, statusCode: 503, remainingMs: 750 }), 750);
    assert.equal(admissionRetryDelay({ baseMs: 2000, retryIndex: 0, statusCode: 429, remainingMs: 0 }), 0);
    assert.equal(admissionRetryDelay({ baseMs: 2000, retryIndex: 9, statusCode: 429, remainingMs: -250 }), 0);
    // A fractional deadline is still an upper bound, so the whole result floors to it.
    assert.equal(admissionRetryDelay({ baseMs: 2000, retryIndex: 0, statusCode: 429, remainingMs: 999.9 }), 999);
});

test('non-numeric or absent inputs never invent a wait, and an absent deadline clamps nothing', () => {
    for (const baseMs of [undefined, null, NaN, '2000', Infinity, -1]) {
        assert.equal(admissionRetryDelay({ baseMs, retryIndex: 3, statusCode: 429, remainingMs: 600000 }), 0, `baseMs ${String(baseMs)}`);
        assert.equal(admissionRetryDelay({ baseMs, retryIndex: 3, statusCode: 503, remainingMs: 600000 }), 0, `baseMs ${String(baseMs)}`);
    }
    // An unusable retry index cannot mean "wait longer than the operator configured".
    for (const retryIndex of [undefined, null, NaN, 'x', -5, Infinity]) {
        assert.equal(admissionRetryDelay({ baseMs: 2000, retryIndex, statusCode: 429, remainingMs: 600000 }), 2000, `retryIndex ${String(retryIndex)}`);
    }
    assert.equal(admissionRetryDelay({ baseMs: 2000, retryIndex: 2, statusCode: 429 }), 8000);
    assert.equal(admissionRetryDelay({ baseMs: 2000, retryIndex: 2, statusCode: 429, remainingMs: 'later' }), 8000);
});

test('the scheduled delay is always a whole number of milliseconds', () => {
    const cases = [
        { baseMs: 1500.7, retryIndex: 0, statusCode: 429, remainingMs: 600000 },
        { baseMs: 1500.5, retryIndex: 1, statusCode: 429, remainingMs: 600000 },
        { baseMs: 0.4, retryIndex: 4, statusCode: 429, remainingMs: 600000 },
        { baseMs: 900.25, retryIndex: 2, statusCode: 503, remainingMs: 1234.75 }
    ];
    for (const options of cases) {
        const delay = admissionRetryDelay(options);
        assert.ok(Number.isInteger(delay) && delay >= 0, `${JSON.stringify(options)} -> ${delay}`);
    }
    assert.equal(admissionRetryDelay(cases[0]), 1500);
    assert.equal(admissionRetryDelay(cases[1]), 3001);
    assert.equal(admissionRetryDelay(cases[3]), 900);
});
