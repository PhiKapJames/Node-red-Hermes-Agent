'use strict';

const { redact } = require('./errors');

// A probe answer is read by operators and dashboards, so every surfaced value is a boolean, a
// clamped whole number or a short single-line string. Platform maps, metrics, extension or tool
// configuration are never copied, whatever the server adds to these payloads later.
const SUMMARY_TEXT = 200;
const SUMMARY_COUNT = 1000000;

// A malformed or partial payload still yields a closed summary instead of throwing.
const fields = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});
// Deliberately `=== true`: a flag the server never reported is reported as `false`, never as support
// nobody claimed, and the palette help says so in the same words ("a flag the server does not report
// is reported as unsupported"). Absence and denial share one value here because the only decision this
// package makes from a flag is "may this be used", and for that decision both mean no.
const flag = value => value === true;

// `secrets` is the caller's own API key, passed so a server that echoes the bearer it just received
// back inside `status` or `version` cannot hand it to a flow. It is never part of a summary.
function summaryText(value, secrets) {
    if (typeof value !== 'string') return undefined;
    // redact() is the package's single redaction choke point: it removes credential-shaped text
    // and collapses CR/LF before this shorter summary cap is applied.
    const text = redact(value, secrets).trim();
    return text ? text.slice(0, SUMMARY_TEXT) : undefined;
}

function summaryCount(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
    return Math.min(Math.floor(value), SUMMARY_COUNT);
}

// Absent fields are omitted rather than stored as `undefined`, so a summary can never look like a
// value the server actually reported.
function compact(summary) {
    for (const [key, value] of Object.entries(summary)) {
        if (value === undefined) delete summary[key];
    }
    return summary;
}

// The feature flag and the endpoints-table key are spelled differently upstream, and both are
// required: `features.run_approval_response` is true and the endpoints table advertises
// `run_approval` with a path. Absence of either means unsupported, never "assume supported".
function approvalPath(payload, secrets) {
    return summaryText(fields(fields(payload).endpoints).run_approval?.path, secrets);
}

function approvalSupported(payload) {
    const features = fields(fields(payload).features);
    return flag(features.run_approval_response) && approvalPath(payload) !== undefined;
}

function projectCapabilities(payload, options = {}) {
    const secrets = options.secrets;
    const data = fields(payload);
    const auth = fields(data.auth);
    const features = fields(data.features);
    return compact({
        target: 'capabilities',
        model: summaryText(data.model, secrets),
        auth_type: summaryText(auth.type, secrets),
        auth_required: flag(auth.required),
        runtime_mode: summaryText(fields(data.runtime).mode, secrets),
        features: {
            run_status: flag(features.run_status),
            run_stop: flag(features.run_stop),
            run_approval_response: flag(features.run_approval_response)
        },
        run_approval_path: approvalPath(data, secrets)
    });
}

function projectReadiness(payload, options = {}) {
    const secrets = options.secrets;
    const data = fields(payload);
    return compact({
        target: 'readiness',
        status: summaryText(data.status, secrets),
        readiness_status: summaryText(fields(data.readiness).status, secrets),
        version: summaryText(data.version, secrets),
        gateway_state: summaryText(data.gateway_state, secrets),
        gateway_busy: flag(data.gateway_busy),
        active_agents: summaryCount(data.active_agents)
    });
}

module.exports = { projectCapabilities, projectReadiness, approvalSupported };
