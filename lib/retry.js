'use strict';

// Hermes v0.21.6 sends no Retry-After header (docs/hermes-api-contract.md), so the wait
// between admission attempts is computed here. Only 429 grows: the other retryable statuses
// are transient transport or server faults, where repeating the operator's own delay is right.
const CEILING_MS = 60000;

// Unusable configuration degrades to no wait at all rather than to a guessed one.
const nonNegative = value => Number.isFinite(value) ? Math.max(0, value) : 0;
const wholeMs = (value, budget) => Math.max(0, Math.floor(Math.min(value, budget)));

/**
 * Milliseconds to wait before admission retry `retryIndex`, which is 0-based. The ceiling
 * caps growth only, so an explicit `retryDelay` above it is never shortened and backoff can
 * never reduce an operator's intended wait. `remainingMs` keeps the wait inside the job
 * deadline; when it is missing or unusable no bound is invented, so nothing is clamped.
 */
function admissionRetryDelay(options = {}) {
    const base = nonNegative(options.baseMs);
    const budget = Number.isFinite(options.remainingMs) ? Math.max(0, options.remainingMs) : Infinity;
    if (options.statusCode !== 429) return wholeMs(base, budget);
    const index = Math.max(0, Math.floor(nonNegative(options.retryIndex)));
    // An absurd exponent overflows to Infinity, which the ceiling absorbs; a zero base is
    // kept out of the product so it cannot become NaN.
    const grown = base === 0 ? 0 : Math.min(base * 2 ** index, Math.max(CEILING_MS, base));
    return wholeMs(grown, budget);
}

module.exports = { admissionRetryDelay };
