'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { HermesQueue } = require('../lib/queue');
const { prepareRequest } = require('../lib/request');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
    for (let i = 0; i < 400; i++) { if (fn()) return; await wait(5); }
    throw new Error('Condition timed out');
}
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function editorDefinitions() {
    const html = read('nodes/hermes.html');
    const code = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];
    const definitions = {};
    const values = {};
    vm.runInNewContext(code, {
        RED: { nodes: { registerType: (name, def) => { definitions[name] = def; } }, validators: { number: () => value => Number.isFinite(Number(value)) } },
        $: selector => ({ val: value => { values[selector] = value; } })
    });
    return { definitions, values, html };
}

test('non-force reset blocks follow-up admission until old remote run is terminal', async t => {
    let terminal = false;
    let stopping = false;
    const starts = [];
    const client = {
        start: async body => { starts.push(body.input); return { run_id: body.input }; },
        status: async id => id === 'old' ? { status: terminal ? 'cancelled' : 'running' } : { status: 'completed', output: 'New answer.' },
        stop: async () => { stopping = true; return { status: 'stopping' }; }
    };
    const queue = new HermesQueue({ clientFor: () => client, pollIntervalMs: 5, stopTimeoutMs: 1000, jobTimeoutMs: 5000 });
    t.after(() => queue.close());
    const submit = input => {
        const ticket = queue.enqueue({ ownerId: 'agent', connectionId: 'connection', spec: prepareRequest(input, { clientId: 'client' }), message: { payload: input } });
        ticket.finished.catch(() => {});
        return ticket;
    };
    const old = submit('old');
    await until(() => queue.active?.phase === 'running');
    const oldSession = queue.active.sessionId;
    queue.reset(false);
    const next = submit('new');
    await until(() => stopping);
    await wait(30);
    assert.deepEqual(starts, ['old']);
    assert.equal(queue.snapshot().active.runId, 'old');
    assert.equal(queue.snapshot().pending, 1);
    terminal = true;
    await assert.rejects(old.finished, error => error.code === 'CANCELLED' && !error.remoteUnknown);
    const result = await next.finished;
    assert.equal(result.output, 'New answer.');
    assert.notEqual(result.sessionId, oldSession);
    assert.deepEqual(starts, ['old', 'new']);
});

test('shared queue supports many listeners without changing global EventEmitter defaults', async t => {
    const defaultLimit = new EventEmitter().getMaxListeners();
    const queue = new HermesQueue();
    t.after(() => queue.close());
    assert.equal(queue.getMaxListeners(), 0);
    const listeners = Array.from({ length: 20 }, () => () => {});
    listeners.forEach(listener => queue.on('progress', listener));
    assert.equal(queue.listenerCount('progress'), 20);
    listeners.forEach(listener => queue.removeListener('progress', listener));
    assert.equal(queue.listenerCount('progress'), 0);
    assert.equal(new EventEmitter().getMaxListeners(), defaultLimit);
});

test('author bot flags are boolean and are not silently coerced', () => {
    for (const flag of [true, false]) {
        assert.equal(prepareRequest('Hello', { author: { name: 'Agent', is_bot: flag } }).author.is_bot, flag);
    }
    assert.throws(() => prepareRequest('Hello', { author: { name: 'Agent', is_bot: 'false' } }), { code: 'INVALID_INPUT' });
});

test('Node-RED 5 editor uses only the async HTTP timeout configuration', () => {
    const { definitions } = editorDefinitions();
    const queue = definitions['hermes-queue'];
    assert.equal(queue.defaults.asyncRequestTimeout.value, 30);
    assert.equal(Object.hasOwn(queue.defaults, 'requestTimeout'), false);
    assert.equal(Object.hasOwn(queue, 'oneditprepare'), false);
    assert.equal(Object.hasOwn(queue, 'oneditsave'), false);
    assert.ok(definitions['hermes-prepare'].defaults.authorIsBotProperty);
});

test('node help has property lists, details and references, with three distinct Agent outputs', () => {
    const { html } = editorDefinitions();
    const help = name => html.match(new RegExp('<script type="text/html" data-help-name="' + name + '">([\\s\\S]*?)</script>'))[1];
    for (const name of ['hermes-connection', 'hermes-queue', 'hermes-prepare', 'hermes-agent', 'hermes-control']) {
        assert.match(help(name), /<h3>Details<\/h3>/);
        assert.match(help(name), /<h3>References<\/h3>/);
    }
    for (const name of ['hermes-prepare', 'hermes-agent', 'hermes-control']) {
        assert.match(help(name), /<h3>Inputs<\/h3>/);
        assert.match(help(name), /<h3>Outputs<\/h3>/);
        assert.match(help(name), /<dl class="message-properties">/);
    }
    const ports = help('hermes-agent').match(/<ol class="node-ports">([\s\S]*?)<\/ol>/)[1];
    assert.equal((ports.match(/<li>/g) || []).length, 3);
});

test('canonical metadata and model/memory documentation retain the required distinctions', () => {
    const pkg = JSON.parse(read('package.json'));
    const repo = 'https://github.com/PhiKapJames/node-red-contrib-hermes-agent';
    assert.equal(pkg.repository.url, `git+${repo}.git`);
    assert.equal(pkg.bugs.url, `${repo}/issues`);
    assert.equal(pkg.homepage, `${repo}#readme`);
    assert.equal(pkg.author, 'PhiKapJames');
    assert.equal(pkg.dependencies, undefined);
    const docs = read('README.md');
    assert.match(docs, /github:PhiKapJames\/node-red-contrib-hermes-agent#main/);
    const help = read('nodes/hermes.html');
    assert.equal(help.split(repo).length - 1, 5);
    assert.match(docs, /direct_model_requests: true/);
    assert.match(docs, /Honcho uses it/);
    assert.match(docs, /does not isolate a statically configured Hindsight bank/);
});

test('examples retain compatible payload fields and explicit prop types with renamed queue wait', () => {
    const example = JSON.parse(read('examples/sync-and-async.json'));
    for (const node of example.filter(node => node.type === 'inject')) {
        const prop = node.props.find(prop => prop.p === 'payload');
        assert.equal(prop.vt, node.payloadType);
        if (node.payloadType === 'json') assert.doesNotThrow(() => JSON.parse(node.payload));
    }
    const queue = example.find(node => node.type === 'hermes-queue');
    assert.equal(queue.asyncRequestTimeout, 30);
    assert.equal(Object.hasOwn(queue, 'requestTimeout'), false);
});
