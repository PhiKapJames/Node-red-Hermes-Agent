'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { HermesClient, endpoint } = require('../lib/client');

async function fixture(t, handler, profile = 'example') {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new HermesClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, profile, getKey: () => 'test-secret-credential', requestTimeoutMs: 1000 });
    t.after(async () => { client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    return client;
}

test('URLs handle reverse proxies and v1 without allowing credential-bearing URLs', () => {
    assert.equal(endpoint('https://example.org/proxy/v1', 'work'), 'https://example.org/proxy/p/work/v1');
    assert.equal(endpoint('https://example.org', ''), 'https://example.org/v1');
    for (const value of ['file:///tmp/x', 'http://a:b@example.org', 'https://example.org/?key=secret', 'https://example.org/p/work/v1']) {
        assert.throws(() => endpoint(value, 'work'), { code: 'CONFIG' });
    }
    assert.throws(() => endpoint('http://example.org', '../other'), { code: 'CONFIG' });
});
test('shared key is added internally; asynchronous body and profile route are correct', async t => {
    const client = await fixture(t, (req, res) => {
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/p/example/v1/runs');
        assert.equal(req.headers.authorization, 'Bearer test-secret-credential');
        assert.equal(req.headers['idempotency-key'], 'request-1');
        const chunks = [];
        req.on('data', data => chunks.push(data));
        req.on('end', () => {
            assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { input: 'hello' });
            res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ run_id: 'run_1', status: 'started' }));
        });
    });
    const data = await client.start({ input: 'hello' }, { headers: { 'Idempotency-Key': 'request-1', Authorization: 'Bearer wrong' } });
    assert.equal(data.run_id, 'run_1');
});
test('redirects are not followed and tokens do not appear in errors', async t => {
    let calls = 0;
    const client = await fixture(t, (_, res) => { calls++; res.writeHead(302, { Location: 'http://example.org/steal' }); res.end('{}'); });
    await assert.rejects(client.start({ input: 'x' }), { code: 'REDIRECT_BLOCKED' });
    assert.equal(calls, 1);
});
test('401/403 failures are non-retryable and redact server-echoed credentials', async t => {
    const client = await fixture(t, (_, res) => {
        res.writeHead(403); res.end(JSON.stringify({ error: { message: 'Rejected test-secret-credential' } }));
    });
    await assert.rejects(client.start({ input: 'x' }), error => {
        assert.equal(error.statusCode, 403); assert.equal(error.retryable, false); assert.equal(error.remoteUnknown, false);
        assert.doesNotMatch(error.message, /test-secret-credential/); return true;
    });
});
test('missing key fails locally without starting a request', async () => {
    const client = new HermesClient({ baseUrl: 'http://127.0.0.1:1', getKey: () => '' });
    await assert.rejects(client.start({ input: 'x' }), { code: 'MISSING_CREDENTIAL' }); client.close();
});
test('whole-response timeout works even while bytes trickle', async t => {
    const client = await fixture(t, (_, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{');
        const timer = setInterval(() => res.write(' '), 5); res.on('close', () => clearInterval(timer));
    });
    await assert.rejects(client.start({ input: 'x' }, { timeoutMs: 35 }), error => error.code === 'HTTP_TIMEOUT' && error.remoteUnknown);
});
test('abort terminates a synchronous request without claiming remote cancellation', async t => {
    const client = await fixture(t, () => {});
    const controller = new AbortController();
    const result = client.chat({ messages: [] }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(result, error => error.code === 'ABORTED' && error.remoteUnknown);
});
test('poll and stop use the same named profile and URL-encode run IDs', async t => {
    const routes = [];
    const client = await fixture(t, (req, res) => { routes.push([req.method, req.url]); res.end(JSON.stringify({ status: 'cancelled' })); });
    await client.status('run/one'); await client.stop('run/one');
    assert.deepEqual(routes, [['GET', '/p/example/v1/runs/run%2Fone'], ['POST', '/p/example/v1/runs/run%2Fone/stop']]);
});
test('invalid successful JSON is reported instead of triggering a parsing traceback', async t => {
    const client = await fixture(t, (_, res) => res.end('not JSON'));
    await assert.rejects(client.start({ input: 'x' }), error => error.code === 'INVALID_RESPONSE' && error.remoteUnknown);
});
