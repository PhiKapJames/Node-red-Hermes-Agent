'use strict';

const { HermesError, redact } = require('./errors');

// The four decisions the pinned Hermes server accepts (docs/hermes-api-contract.md). This set is
// closed on purpose: an adapter must never send a choice the server did not advertise for the
// decision it is answering. The server alias-maps `approve`/`allow` onto `once`, and an adapter
// that copied that generosity would turn a typo into a grant, so anything outside these four
// literals is a local error and is never normalised into one of them. Every other module - the
// queue, the Control node, the editor contract test - reads this one list instead of restating it.
const APPROVAL_CHOICES = Object.freeze(['once', 'session', 'always', 'deny']);
const CHOICES = new Set(APPROVAL_CHOICES);

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
    return Object.freeze([...advertised]);
}

/**
 * The choices one Control node may ever send, from its own configuration. Both the editor's
 * comma-separated text and a JSON array are accepted, because flow JSON is a supported way to write
 * a flow; nothing else is. Trimming here is for an operator typing a setting, never for a value read
 * off the wire, and an entry that is not exactly one of the four literals is dropped rather than
 * repaired - a typo in this setting must disable, never widen, what a node is allowed to do.
 */
function allowedChoices(value) {
    const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    const allowed = new Set();
    for (const item of items) {
        if (typeof item !== 'string') continue;
        const literal = item.trim();
        if (CHOICES.has(literal)) allowed.add(literal);
    }
    return [...allowed];
}

// Deliberately no coercion and no trimming: a decision is addressed exactly or not at all.
function validatedRequestId(value) {
    return typeof value === 'string' && REQUEST_ID.test(value) ? value : undefined;
}

// A non-empty string is the only shape either required id may arrive in from a message; anything else is
// absent input, and an approval never defaults to "whichever job is running" or
// "whichever decision is pending".
const presentId = value => typeof value === 'string' && value.length > 0 ? value : undefined;

function previewText(value, secrets) {
    if (typeof value !== 'string') return undefined;
    // redact() is the package's single redaction choke point: credential scrubbing and the CR/LF
    // collapse happen there, before this shorter cap is applied to the final single-line form. The
    // caller's own API key is passed as a secret so a server that echoes the bearer it just received
    // cannot hand it back through a preview field.
    const text = redact(value, secrets).trim();
    return text ? text.slice(0, PREVIEW_MAX) : undefined;
}

/**
 * The queue's projection of one pending approval, or `null` when the run reported no approval
 * object at all. Nothing is copied wholesale: the upstream object is read field by field, so a
 * value that is not the documented shape is omitted instead of forwarded, and a missing or
 * malformed `request_id` never becomes a fabricated identity. Absent fields are omitted rather
 * than stored as `undefined`, so a projection cannot look like something the server reported.
 * Frozen, because this object is what makes a decision look answerable: widening or blanking a
 * shared projection must be impossible rather than merely discouraged.
 */
function pendingApproval(raw, options = {}) {
    if (!isObject(raw)) return null;
    const preview = options.includeApprovalPreview === true;
    const command = preview ? previewText(raw.command, options.secrets) : undefined;
    const description = preview ? previewText(raw.description, options.secrets) : undefined;
    const requestId = validatedRequestId(raw.request_id);
    return Object.freeze({
        ...(requestId === undefined ? {} : { requestId }),
        choices: advertisedChoices(raw.choices),
        ...(command ? { command } : {}),
        ...(description ? { description } : {})
    });
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

/**
 * Everything one Control node may decide about an approval request, decided before anything is
 * dispatched. The rule is exact or nothing: the caller names a queue job AND the decision inside it,
 * the choice must be one this node was configured to send AND one the server advertised for that
 * very decision, and both must still be what the queue sees right now. A rejection is local - no
 * connection is resolved, so nothing can reach the network - and a rejected value is never echoed
 * back into a message or a log.
 *
 * `job` is the closed projection `HermesQueue.activeJob()` hands out, or `null` when the named job is
 * not the active one; which lookup happened is the caller's business. The stale window between that
 * lookup and the POST cannot be closed from here, and is not: the server answers an already-resolved
 * decision with 409 `approval_not_pending`, which is the accurate outcome.
 */
function approvalSubmission(options = {}) {
    // Node policy first, so a legacy or hand-edited flow - or a node that simply was not given any
    // permitted choice - reports that rather than anything the message got wrong.
    if (options.allowApprove !== true) {
        throw new HermesError('OVERRIDE_DISABLED', 'This Control node is not allowed to answer an approval.');
    }
    const allowed = allowedChoices(options.choices);
    if (!allowed.length) {
        throw new HermesError('OVERRIDE_DISABLED', 'This Control node has no permitted approval choice.');
    }
    const control = isObject(options.control) ? options.control : {};
    const requestId = presentId(control.requestId);
    const approvalRequestId = presentId(control.approvalRequestId);
    if (requestId === undefined || approvalRequestId === undefined) {
        throw new HermesError('INVALID_INPUT', 'An approval needs both the queue request ID and the pending decision ID; neither defaults to the active one.');
    }
    const job = options.job;
    if (!isObject(job)) throw new HermesError('REQUEST_NOT_FOUND', 'No active Hermes job has that request ID.');
    const pending = isObject(job.approval) ? job.approval : null;
    // The one comparison that makes a late click harmless: a decision that has been answered, or
    // replaced by a newer one, is addressed by nobody. Two absent values must never match here, so
    // both sides are required rather than compared loosely.
    if (!pending || pending.requestId !== approvalRequestId) {
        throw new HermesError('INVALID_INPUT', 'That decision is not the one this job reports as pending now.');
    }
    if (!CHOICES.has(control.choice)) {
        throw new HermesError('INVALID_INPUT', 'An approval decision must be once, session, always or deny, and only when the server advertised it for that decision.');
    }
    if (!allowed.includes(control.choice)) {
        throw new HermesError('OVERRIDE_DISABLED', 'This Control node is not permitted to send that approval decision.');
    }
    if (!Array.isArray(pending.choices) || !pending.choices.includes(control.choice)) {
        throw new HermesError('OVERRIDE_DISABLED', 'The server did not advertise that decision for this approval.');
    }
    // Only what the POST and its routing need. The projection deliberately has nothing else to give.
    return { choice: control.choice, requestId, approvalRequestId, runId: job.runId, connectionId: job.connectionId };
}

module.exports = {
    APPROVAL_CHOICES, pendingApproval, approvalEvent, approvalDecision, approvalRunId, allowedChoices, approvalSubmission
};
