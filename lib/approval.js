'use strict';

const { HermesError, redact } = require('./errors');

// The four decisions the pinned Hermes server accepts (docs/hermes-api-contract.md). This set is
// closed on purpose: an adapter must never send a choice the server did not advertise for the
// decision it is answering. The server alias-maps `approve`/`allow` onto `once`, and an adapter
// that copied that generosity would turn a typo into a grant, so anything outside these four
// literals is a local error and is never normalised into one of them.
const CHOICES = new Set(['once', 'session', 'always', 'deny']);

// `request_id` is a 32-character hex uuid in v0.21.6; the wider character class and the
// 256-character bound are the server's own limits. The id is the only reliable signal that a new
// decision has arrived, so an unusable one is dropped rather than guessed: an invented identity
// would make an unaddressable decision look answerable.
const REQUEST_ID = /^[A-Za-z0-9_-]{1,256}$/;

// A run id is a URL path segment. The printable-ASCII/no-space bound is the one this package uses
// for identifiers elsewhere, so an unintended destination fails locally instead of in flight.
const RUN_ID = /^[\x21-\x7e]{1,200}$/;

// Preview text is operator-facing and rides a lifecycle event that a shared queue can fan out to
// every flow in a runtime, so it is capped well inside redact()'s 600-character cap.
const PREVIEW_MAX = 300;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The advertised literals only: in the server's order, deduplicated, and never widened. */
function advertisedChoices(value) {
    if (!Array.isArray(value)) return [];
    const advertised = new Set();
    for (const item of value) if (CHOICES.has(item)) advertised.add(item);
    return [...advertised];
}

// Deliberately no coercion and no trimming: a decision is addressed exactly or not at all.
function validatedRequestId(value) {
    return typeof value === 'string' && REQUEST_ID.test(value) ? value : undefined;
}

function previewText(value) {
    if (typeof value !== 'string') return undefined;
    // redact() is the package's single redaction choke point: credential scrubbing and the CR/LF
    // collapse happen there, before this shorter cap is applied to the final single-line form.
    const text = redact(value).trim();
    return text ? text.slice(0, PREVIEW_MAX) : undefined;
}

/**
 * The queue's projection of one pending approval, or `null` when the run reported no approval
 * object at all. Nothing is copied wholesale: the upstream object is read field by field, so a
 * value that is not the documented shape is omitted instead of forwarded, and a missing or
 * malformed `request_id` never becomes a fabricated identity. Absent fields are omitted rather
 * than stored as `undefined`, so a projection cannot look like something the server reported.
 */
function pendingApproval(raw, options = {}) {
    if (!isObject(raw)) return null;
    const preview = options.includeApprovalPreview === true;
    const command = preview ? previewText(raw.command) : undefined;
    const description = preview ? previewText(raw.description) : undefined;
    return {
        requestId: validatedRequestId(raw.request_id),
        choices: advertisedChoices(raw.choices),
        ...(command ? { command } : {}),
        ...(description ? { description } : {})
    };
}

/**
 * How a projected approval appears on a lifecycle event: the identity a flow needs in order to
 * address the decision, plus the only choices that may ever be sent for it. A decision whose id is
 * unusable still reports its advertised choices, so a flow can see that something is pending which
 * it cannot answer; `null` means the run reported no approval object, and adds nothing at all.
 */
function approvalEvent(approval) {
    if (!approval) return {};
    return {
        ...(approval.requestId ? { approvalRequestId: approval.requestId } : {}),
        approvalChoices: approval.choices,
        ...(approval.command ? { approvalCommand: approval.command } : {}),
        ...(approval.description ? { approvalDescription: approval.description } : {})
    };
}

/**
 * The request body for one exact decision, validated before anything is dispatched. `request_id`
 * is mandatory: without it the server answers whatever happens to be pending, which is the failure
 * this bridge exists to prevent. A rejected value is never echoed back into a message or a log.
 */
function approvalDecision(value) {
    if (!isObject(value) || !CHOICES.has(value.choice)) {
        throw new HermesError('INVALID_INPUT', 'An approval decision must be once, session, always or deny, and only when the server advertised it for that decision.');
    }
    const requestId = validatedRequestId(value.requestId);
    if (requestId === undefined) throw new HermesError('INVALID_INPUT', 'An approval decision needs the request ID of the pending decision.');
    // Exactly these two fields are sent, and only for the run the caller addressed.
    return { choice: value.choice, request_id: requestId };
}

/** A run ID used as a URL path segment, or a local failure that never reaches the network. */
function approvalRunId(value) {
    if (typeof value !== 'string' || !RUN_ID.test(value)) {
        throw new HermesError('INVALID_INPUT', 'A run ID must be printable ASCII of at most 200 characters, without spaces.');
    }
    return value;
}

module.exports = { pendingApproval, approvalEvent, approvalDecision, approvalRunId };
