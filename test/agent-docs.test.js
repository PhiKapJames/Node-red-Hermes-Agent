'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HermesQueue, CONTROL_ACTIONS } = require('../lib/queue');
const { APPROVAL_CHOICES } = require('../lib/approval');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('AGENTS entry point and runbook are included in the distributed package', () => {
    const pkg = JSON.parse(read('package.json'));
    const agents = read('AGENTS.md');
    const guide = read('docs/agent-integration.md');
    const readme = read('README.md');
    assert.ok(pkg.files.includes('AGENTS.md'));
    assert.ok(pkg.files.includes('docs/'));
    assert.match(agents, /docs\/agent-integration\.md/);
    assert.match(guide, /examples\/sync-and-async\.json/);
    assert.match(readme, /\[AGENTS\.md\]\(AGENTS\.md\)/);
    assert.match(readme, /\[agent integration runbook\]\(docs\/agent-integration\.md\)/);
    for (const document of [agents, guide]) {
        assert.match(document, /Node-RED 5/);
        assert.match(document, /Node\.js 24/);
        assert.doesNotMatch(document, /MeshCore/i);
    }
});

test('agent instructions describe all five registered node types', () => {
    const runtime = read('nodes/hermes.js');
    const guide = read('docs/agent-integration.md');
    const agent = read('AGENTS.md');
    for (const type of ['hermes-connection', 'hermes-queue', 'hermes-prepare', 'hermes-agent', 'hermes-control']) {
        assert.match(runtime, new RegExp("registerType\\('" + type + "'"));
        assert.ok(guide.includes(type));
        assert.ok(agent.includes(type));
    }
});

test('runbook distinguishes cancelling an active run from cancelling a queued job', () => {
    const guide = read('docs/agent-integration.md');
    assert.match(guide, /`cancel` of the active run[\s\S]*?`cancellationRequested: true`[\s\S]*?\*\*keeps the active slot\*\*/);
    assert.match(guide, /Cancelling a queued job by ID returns `cancelled: true` immediately/);
});

test('existing disabled integration example has referenced configs and ordered Agent outputs', () => {
    const nodes = JSON.parse(read('examples/sync-and-async.json'));
    const byId = new Map(nodes.map(node => [node.id, node]));
    const tab = nodes.find(node => node.type === 'tab');
    assert.equal(tab.disabled, true);
    const agents = nodes.filter(node => node.type === 'hermes-agent');
    const controls = nodes.filter(node => node.type === 'hermes-control');
    assert.equal(agents.length, 2);
    assert.ok(controls.length >= 1);
    for (const node of agents) {
        assert.equal(byId.get(node.connection)?.type, 'hermes-connection');
        assert.equal(byId.get(node.queue)?.type, 'hermes-queue');
        assert.equal(node.wires.length, 3);
        assert.ok(node.wires.every(port => Array.isArray(port)));
    }
    assert.equal(agents[0].queue, agents[1].queue);
    assert.ok(controls.every(node => node.queue === agents[0].queue));
});

test('documented Control actions are exactly the actions the code accepts', () => {
    // The accepted set is derived from the code, never restated: the queue's own switch and the
    // two fixed-only actions the Control node handles before the queue is consulted at all.
    const runtime = read('nodes/hermes.js');
    const nodeOnly = [...runtime.matchAll(/const (?:probing|approving) = config\.action === '(\w+)'/g)]
        .map(match => match[1]).sort();
    assert.deepEqual(nodeOnly, ['approve', 'probe'], 'only probe and approve are fixed-only node actions');
    const accepted = new Set([...CONTROL_ACTIONS, ...nodeOnly]);
    const sorted = values => [...values].sort();

    const guide = read('docs/agent-integration.md');
    const line = guide.match(/Supported actions: ([^\n]*?)\./);
    assert.ok(line, 'the runbook keeps one canonical "Supported actions:" line');
    assert.deepEqual(sorted([...line[1].matchAll(/`([a-z]+)`/g)].map(match => match[1])), sorted(accepted),
        'the runbook action list drifted from the code');

    const readme = read('README.md');
    const bullets = readme.slice(readme.indexOf('Control messages go'), readme.indexOf('A stop endpoint returning'));
    assert.deepEqual(sorted([...bullets.matchAll(/^- `([a-z]+)`:/gm)].map(match => match[1])), sorted(accepted),
        'the README action list drifted from the code');

    const agents = read('AGENTS.md');
    const row = agents.split('\n').find(line => line.startsWith('| `hermes-control`'));
    assert.ok(row, 'the cheat sheet keeps its hermes-control row');
    for (const action of accepted) assert.ok(row.includes('`' + action + '`'), `the cheat sheet must list "${action}"`);
});

test('the queue rejection names exactly its accepted actions and never the fixed-only ones', () => {
    const queue = new HermesQueue({ id: 'docs', clientFor: () => null });
    assert.throws(() => queue.control('probe'), error => {
        assert.equal(error.code, 'INVALID_ACTION');
        assert.doesNotMatch(error.message, /approve|probe/, 'a rejection must not advertise the fixed-only actions');
        for (const action of CONTROL_ACTIONS) assert.ok(error.message.includes(action));
        return true;
    });
    void queue.close();
});

test('approval documentation states the rules and the stale claim is gone', () => {
    const readme = read('README.md');
    const guide = read('docs/agent-integration.md');
    const contract = read('docs/adapter-contract.md');
    for (const document of [readme, guide]) {
        assert.match(document, /approvalRequestId/);
        assert.match(document, /approvalChoices/);
        assert.match(document, /includeApprovalPreview/);
        assert.match(document, /delayMs/, 'the retrying event backoff field is documented');
        assert.match(document, /429[\s\S]{0,120}exponential/i, 'the 429 growth rule is documented');
        assert.match(document, /60 s/, 'the growth cap is documented');
        assert.match(document, /approval_not_pending[\s\S]*approval_not_active/, 'the accepted staleness codes are documented');
        assert.match(document, /not revocable from Node-RED/, 'server-side persistence of session/always is documented');
        assert.doesNotMatch(document, /interactive approval submission/i, 'the retracted claim must stay retracted');
    }
    assert.match(readme, /neither defaults to/i, 'the exact-decision rule is documented');
    assert.match(readme, /never chosen by message/i, 'probe and approve stay fixed-only');
    assert.match(guide, /Nothing defaults to/i, 'the exact-decision rule is documented');
    assert.match(guide, /fixed-only/, 'probe and approve stay fixed-only');
    assert.match(contract, /approvalRequestId/);
    assert.match(contract, /approval_not_pending|already answered/);
    assert.match(read('AGENTS.md'), /allowApprove/);
});

test('the example enables approval answering only on its explicit approval node', () => {
    const nodes = JSON.parse(read('examples/sync-and-async.json'));
    const controls = nodes.filter(node => node.type === 'hermes-control');
    const approvals = controls.filter(node => node.action === 'approve');
    assert.equal(approvals.length, 1, 'exactly one approval-relay example');
    const approval = approvals[0];
    assert.equal(approval.allowApprove, true);
    const choices = approval.approvalChoices.split(',').map(choice => choice.trim()).filter(Boolean);
    assert.ok(choices.length > 0, 'the approval example names the choices it permits');
    for (const choice of choices) assert.ok(APPROVAL_CHOICES.includes(choice), 'only the server literals are permitted');
    for (const node of controls) {
        if (node !== approval) assert.notEqual(node.allowApprove, true, 'no other node may answer approvals');
        if (node.action === 'probe') assert.ok(node.connection, 'the probe names its own Connection');
    }
    assert.equal(nodes.find(node => node.type === 'tab').disabled, true);
});
