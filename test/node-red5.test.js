'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HermesQueue } = require('../lib/queue');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('0.3.0 requires Node.js 24 and Node-RED 5 with synchronized lock metadata', () => {
    const pkg = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    assert.equal(pkg.version, '0.3.0');
    assert.equal(pkg['node-red'].version, '>=5.0.0');
    assert.equal(pkg.engines.node, '>=24.0.0');
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
    assert.equal(lock.packages[''].engines.node, pkg.engines.node);
    assert.equal(pkg.dependencies, undefined);
    assert.equal(read('.nvmrc').trim(), '24');
});

test('runtime uses modern Node-RED callbacks without obsolete fallbacks', () => {
    const runtime = read('nodes/hermes.js');
    assert.doesNotMatch(runtime, /closeCallback|send\s*=\s*send\s*\|\||done\s*=\s*done\s*\|\|/);
    assert.match(runtime, /node\.on\('input', async \(msg, send, done\)/);
    assert.match(runtime, /finally \{ done\(failure\); \}/);
    assert.match(runtime, /node\.on\('close', async \(_removed, done\)/);
});

test('queue uses promise timers and abort signals, not manual wake callbacks', async () => {
    const source = read('lib/queue.js');
    assert.match(source, /Promise\.withResolvers\(\)/);
    assert.match(source, /node:timers\/promises/);
    assert.match(source, /AbortSignal\.any/);
    assert.doesNotMatch(source, /job\.wake|clearTimeout\(|this\.timer/);
    const q = new HermesQueue();
    assert.equal(q.snapshot().pending, 0);
    await q.close();
});

test('Node-RED 5 Inject examples retain their native typed properties', () => {
    const example = JSON.parse(read('examples/sync-and-async.json'));
    for (const node of example.filter(item => item.type === 'inject')) {
        const prop = node.props.find(item => item.p === 'payload');
        assert.ok(prop);
        assert.equal(prop.vt, node.payloadType);
        assert.equal(prop.v, node.payload);
    }
});

test('CI covers Node 24 floor, latest 24 and forward compatibility without old helpers', () => {
    const yaml = read('.github/workflows/test.yml');
    assert.match(yaml, /node: \['24\.0\.0', '24', '26'\]/);
    assert.match(yaml, /node-red@5/);
    assert.doesNotMatch(yaml, /node-red@4|runtime:\s*4/);
    assert.match(yaml, /NODE_OPTIONS: --throw-deprecation/);
    assert.doesNotMatch(read('test/integration/node-red.test.js'), /require\(['"]node-red-node-test-helper/);
});
