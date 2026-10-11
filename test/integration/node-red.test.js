'use strict';
// Runs in CI (or after installing node-red + node-red-node-test-helper without --save).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const helper = require('node-red-node-test-helper');
const nodes = require('../../nodes/hermes');
helper.init(require.resolve('node-red'));

async function setup(t, mode) {
    const calls = [];
    const api = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
            calls.push({ url: req.url, headers: req.headers, body, method: req.method });
            res.setHeader('Content-Type', 'application/json');
            if (req.url.endsWith('/chat/completions')) res.end(JSON.stringify({ choices: [{ message: { content: 'A full answer.', reasoning_content: 'NOT_FOR_OUTPUT' }, finish_reason: 'stop' }] }));
            else if (req.method === 'POST' && req.url.endsWith('/runs')) { res.statusCode = 202; res.end(JSON.stringify({ run_id: 'test_run', status: 'started' })); }
            else res.end(JSON.stringify({ status: 'completed', output: 'A full answer.', reasoning_content: 'NOT_FOR_OUTPUT' }));
        });
    });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => helper.startServer(resolve));
    const flow = [
        { id:'flow', type:'tab', label:'Test' },
        { id:'connection', type:'hermes-connection', baseUrl:`http://127.0.0.1:${api.address().port}`, profile:'work' },
        { id:'queue', type:'hermes-queue', pollInterval:0.25 },
        { id:'prepare', type:'hermes-prepare', z:'flow', inputProperty:'payload.text', clientProperty:'payload.userId', authorNameProperty:'payload.name', wires:[['agent']] },
        { id:'agent', type:'hermes-agent', z:'flow', connection:'connection', queue:'queue', mode, wires:[['out'],['events'],['errors']] },
        { id:'control', type:'hermes-control', z:'flow', queue:'queue', action:'reset', wires:[['controlOut'],['errors']] },
        { id:'out', type:'helper', z:'flow' }, { id:'events', type:'helper', z:'flow' },
        { id:'errors', type:'helper', z:'flow' }, { id:'controlOut', type:'helper', z:'flow' }
    ];
    await helper.load(nodes, flow, { connection: { apiKey:'integration-secret' } });
    t.after(async () => { await helper.unload(); await new Promise(resolve => helper.stopServer(resolve)); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); });
    return { calls, flow };
}

for (const mode of ['sync','async']) {
    test(`real Node-RED: prepare -> ${mode} agent -> final output; shared credentials and reset`, { timeout:15000 }, async t => {
        const { calls, flow } = await setup(t, mode);
        const received = once(helper.getNode('out'), 'input');
        helper.getNode('prepare').receive({ payload:{ text:'Hello', userId:'client-A', name:'Alex' }, routing:{ recipient:'opaque-recipient' } });
        const [result] = await received;
        assert.equal(result.payload, 'A full answer.');
        assert.equal(result.hermes.status, 'completed');
        assert.equal(result.hermes.clientId, 'client-A');
        assert.equal(result.routing.recipient, 'opaque-recipient');
        assert.equal(calls[0].headers.authorization, 'Bearer integration-secret');
        assert.equal(Object.hasOwn(calls[0].body, 'model'), false);
        assert.match(calls[0].url, /^\/p\/work\/v1\//);
        assert.doesNotMatch(JSON.stringify(result), /integration-secret|NOT_FOR_OUTPUT|reasoning_content/);
        assert.doesNotMatch(JSON.stringify(flow), /integration-secret/);
        const resetReply = once(helper.getNode('controlOut'), 'input');
        helper.getNode('control').receive({ payload:'A control signal, not a user prompt.' });
        const [control] = await resetReply;
        assert.equal(control.payload.action, 'reset');
        assert.equal(control.hermesControl.ok, true);
    });
}
