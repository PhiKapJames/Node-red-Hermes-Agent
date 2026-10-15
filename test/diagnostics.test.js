'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectCapabilities, projectReadiness, approvalSupported } = require('../lib/client');
const capabilitiesFixture = require('./support/fixtures/capabilities.json');
const healthFixture = require('./support/fixtures/health-detailed.json');

// The fixtures deliberately embed nested blobs and credential-shaped values
// (`features.browser_extension_control`, `platforms.*.metrics.authorization`, `api_key`) so
// these tests can prove an allowlist projection cannot surface them, rather than merely
// asserting that a filter "looked careful".

test('the capabilities summary is exactly the allowlisted fields', () => {
    assert.deepEqual(projectCapabilities(capabilitiesFixture), {
        target: 'capabilities',
        model: 'hermes-4-mock',
        auth_type: 'bearer',
        auth_required: true,
        runtime_mode: 'server_agent',
        features: { run_status: true, run_stop: true, run_approval_response: true },
        run_approval_path: '/v1/runs/{run_id}/approval'
    });
    assert.doesNotMatch(JSON.stringify(projectCapabilities(capabilitiesFixture)),
        /never-surfaced|browser_extension_control|artifact_transport|transports|admin_config|session_continuity_header|X-Hermes|websocket-subprotocol|protocol_version/i);
});

test('the readiness summary never surfaces platform maps, metrics or credential-shaped fields', () => {
    assert.deepEqual(projectReadiness(healthFixture), {
        target: 'readiness',
        status: 'ready',
        readiness_status: 'ready',
        version: '0.21.6',
        gateway_state: 'running',
        gateway_busy: true,
        active_agents: 1
    });
    assert.doesNotMatch(JSON.stringify(projectReadiness(healthFixture)),
        /Bearer|api_key|synthetic-value|checks|metrics|platforms|requests_in_flight|pid|heartbeat|exit_reason|drainable/i);
});

test('wrong-typed and oversized upstream values are dropped or clamped, never forwarded', () => {
    assert.deepEqual(projectCapabilities({
        model: 42,
        auth: { type: ['bearer'], required: 'yes' },
        runtime: { mode: { nested: true } },
        features: { run_status: 1, run_stop: 'true', run_approval_response: null },
        endpoints: { run_approval: { method: 'POST', path: 'x'.repeat(5000) }, run_steer: { path: '/v1/runs/{run_id}/steer' } }
    }), {
        target: 'capabilities',
        auth_required: false,
        features: { run_status: false, run_stop: false, run_approval_response: false },
        run_approval_path: 'x'.repeat(200)
    });
    assert.deepEqual(projectReadiness({
        status: 'ready'.repeat(900), readiness: { status: 7 }, version: { major: 1 },
        gateway_state: 'ok', gateway_busy: 'yes', active_agents: '9'
    }), {
        target: 'readiness', status: 'ready'.repeat(900).slice(0, 200), gateway_state: 'ok', gateway_busy: false
    });
    assert.equal(approvalSupported({ features: { run_approval_response: 1 }, endpoints: { run_approval: { path: '/v1/runs/x/approval' } } }), false);
});

test('credential-shaped or line-forging text in an allowlisted field cannot survive the projection', () => {
    const summary = projectReadiness({
        status: 'ready Bearer synthetic-value-never-real sk-abcdefghijklmnop1234\r\nFORGED LOG LINE',
        readiness: { status: 'Bearer abcdefghijkl' },
        gateway_state: 'run',
        active_agents: 5000000000000
    });
    assert.equal(summary.status, 'ready Bearer [REDACTED] [REDACTED] FORGED LOG LINE');
    assert.equal(summary.readiness_status, 'Bearer [REDACTED]');
    assert.doesNotMatch(JSON.stringify(summary), /synthetic-value|sk-abcdef|abcdefghijkl/);
    assert.doesNotMatch(`${JSON.stringify(summary)}${Object.values(summary).join()}`, /[\r\n]/);
    assert.equal(summary.active_agents, 1000000);
    assert.ok(summary.status.length <= 200);
});

test('a payload that is not the advertised shape still yields a closed summary', () => {
    for (const value of [undefined, null, {}, 'ready', [], 7]) {
        assert.deepEqual(projectCapabilities(value), {
            target: 'capabilities', auth_required: false,
            features: { run_status: false, run_stop: false, run_approval_response: false }
        });
        assert.deepEqual(projectReadiness(value), { target: 'readiness', gateway_busy: false });
        assert.equal(approvalSupported(value), false);
    }
});

test('approval support needs the flag and the endpoint together, and absence is never support', () => {
    assert.equal(approvalSupported(capabilitiesFixture), true);
    const withoutFlag = structuredClone(capabilitiesFixture); delete withoutFlag.features.run_approval_response;
    const withoutEndpoint = structuredClone(capabilitiesFixture); delete withoutEndpoint.endpoints.run_approval;
    const cases = [
        [withoutFlag, 'the feature flag is absent'],
        [withoutEndpoint, 'the endpoints table lacks run_approval'],
        [{ features: { run_approval_response: true } }, 'the endpoints table is missing entirely'],
        [{ endpoints: { run_approval: { method: 'POST', path: '/v1/runs/x/approval' } } }, 'the feature flag is absent'],
        [{ features: { run_approval_response: false }, endpoints: { run_approval: { path: '/v1/runs/x/approval' } } }, 'the feature flag is false'],
        [{ features: { run_approval_response: 'true' }, endpoints: { run_approval: { path: '/v1/runs/x/approval' } } }, 'the feature flag is not a boolean'],
        [{ features: { run_approval_response: true }, endpoints: { run_approval: { method: 'POST' } } }, 'the advertised entry carries no usable path'],
        [{ features: { run_approval_response: true }, endpoints: { run_approval: { path: '   ' } } }, 'the advertised path is blank']
    ];
    for (const [value, why] of cases) assert.equal(approvalSupported(value), false, why);
    // The summary agrees: no advertised endpoint means no path field to act on.
    assert.equal(Object.hasOwn(projectCapabilities(withoutEndpoint), 'run_approval_path'), false);
    assert.equal(Object.hasOwn(projectCapabilities(withoutFlag), 'run_approval_path'), true);
});

// docs/hermes-api-contract.md is the authority for these shapes, and the flag and the endpoints
// key are deliberately spelled differently upstream. If a fixture is ever regenerated from a newer
// server, these assertions fail loudly so the exact summaries above are re-derived instead of
// quietly matching a changed wire shape.
test('the committed fixtures still carry the contract note field names and tripwires', () => {
    assert.equal(capabilitiesFixture.features.run_approval_response, true);
    assert.equal(capabilitiesFixture.endpoints.run_approval.path, '/v1/runs/{run_id}/approval');
    assert.equal(Object.hasOwn(capabilitiesFixture.features, 'run_approval'), false);
    assert.equal(Object.hasOwn(capabilitiesFixture.endpoints, 'run_approval_response'), false);
    for (const key of ['status', 'version', 'gateway_state', 'gateway_busy', 'active_agents']) {
        assert.ok(Object.hasOwn(healthFixture, key), key);
    }
    assert.equal(healthFixture.readiness.status, 'ready');
    // The nested blobs that must never be surfaced are still in the fixtures.
    assert.match(JSON.stringify(healthFixture), /Bearer synthetic-value-never-real/);
    assert.match(JSON.stringify(capabilitiesFixture), /browser_extension_control/);
});
