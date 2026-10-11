'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HermesQueue } = require('../lib/queue');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('package requires Node-RED 5 and the supported Node.js runtime floor', () => {
    const pkg = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    assert.equal(pkg.version, '0.2.0');
    assert.equal(pkg['node-red'].version, '>=5.0.0');
    assert.equal(pkg.engines.node, '>=22.9.0');
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
    assert.equal(lock.packages[''].engines.node, pkg.engines.node);
    assert.equal(pkg.dependencies, undefined);
});

test('runtime requires Node-RED 5 message and close callback contracts', () => {
    const runtime = read('nodes/hermes.js');
    assert.doesNotMatch(runtime, /closeCallback|send\s*=\s*send\s*\|\||done\s*=\s*done\s*\|\|/);
    assert.match(runtime, /node\.on\('input', \(msg, send, done\)/);
    assert.match(runtime, /node\.on\('close', \(_removed, done\)/);
});

test('queue relies on built-in Promise.withResolvers without additional compatibility paths', async () => {
    assert.match(read('lib/queue.js'), /Promise\.withResolvers\(\)/);
    assert.equal(typeof Promise.withResolvers, 'function');
    const q = new HermesQueue();
    assert.equal(q.snapshot().pending, 0);
    await q.close();
});

test('Node-RED 5 example Inject nodes use fully typed props and preserved editor metadata', () => {
    const example = JSON.parse(read('examples/sync-and-async.json'));
    const injections = example.filter(node => node.type === 'inject');
    assert.ok(injections.length >= 2);
    for (const node of injections) {
        const prop = node.props.find(p => p.p === 'payload');
        assert.ok(prop);
        assert.equal(prop.vt, node.payloadType);
        assert.equal(prop.v, node.payload);
        if (prop.vt === 'json') assert.deepEqual(JSON.parse(prop.v), JSON.parse(node.payload));
    }
});

test('CI runs Node-RED 5 only on supported Node.js versions', () => {
    const yaml = read('.github/workflows/test.yml');
    assert.match(yaml, /node:\s*\[22, 24\]/);
    assert.match(yaml, /node-red@5/);
    assert.doesNotMatch(yaml, /node-red@4|runtime:\s*4/);
});
