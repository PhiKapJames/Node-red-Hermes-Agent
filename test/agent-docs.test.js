'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
