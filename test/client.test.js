'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { HermesClient, endpoint } = require('../lib/client');
const { publicError } = require('../lib/errors');

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
test('an upstream error body cannot forge log lines or survive redaction over real HTTP', async t => {
    const client = await fixture(t, (_, res) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: { message: 'upstream says:\nERROR not authorized\r\ntoken test-secret-credential sk-abcdefghijklmnop' } }));
    });
    await assert.rejects(client.start({ input: 'x' }), error => {
        assert.equal(error.code, 'HTTP_500');
        // Redaction runs before the collapse, and the collapse before the cap, so a remote
        // 500 body yields exactly one safe line for the Node-RED log and for Catch.
        assert.equal(error.message, 'upstream says: ERROR not authorized token [REDACTED] [REDACTED]');
        assert.doesNotMatch(error.message, /[\r\n]/);
        assert.doesNotMatch(String(error), /test-secret-credential|sk-abcdef/);
        return true;
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
test('the two probes hit their own URL scopes on a profile-prefixed base', async t => {
    const routes = [];
    const client = await fixture(t, (req, res) => { routes.push([req.method, req.url, req.headers.authorization]); res.end('{}'); });
    await client.capabilities(); await client.healthDetailed();
    assert.deepEqual(routes, [
        ['GET', '/p/example/v1/capabilities', 'Bearer test-secret-credential'],
        // /health/detailed is served at the profile root, so only the trailing /v1 is removed.
        ['GET', '/p/example/health/detailed', 'Bearer test-secret-credential']
    ]);
});
test('the readiness probe stays inside the root on an unprefixed base', async t => {
    const routes = [];
    const client = await fixture(t, (req, res) => { routes.push(req.url); res.end('{}'); }, '');
    assert.equal(client.root, client.base.slice(0, -'/v1'.length));
    await client.capabilities(); await client.healthDetailed();
    assert.deepEqual(routes, ['/v1/capabilities', '/health/detailed']);
});
test('a non-2xx response carries the validated upstream machine-readable code', async t => {
    const client = await fixture(t, (_, res) => {
        res.writeHead(409);
        res.end(JSON.stringify({ error: { message: 'Nothing is pending for that request.', type: 'invalid_request_error', param: null, code: 'approval_not_pending' } }));
    });
    await assert.rejects(client.capabilities(), error => {
        assert.equal(error.code, 'HTTP_409');
        assert.equal(error.statusCode, 409);
        assert.equal(error.errorCode, 'approval_not_pending');
        assert.equal(publicError(error).errorCode, 'approval_not_pending');
        return true;
    });
});
test('an unusable upstream error code is dropped instead of forwarded', async t => {
    for (const code of ['APPROVAL_NOT_PENDING', 'approval not pending', 'a'.repeat(65), 'Bearer nope', 42, { nested: true }]) {
        const client = await fixture(t, (_, res) => {
            res.writeHead(400);
            res.end(JSON.stringify({ error: { message: 'Rejected.', type: 'invalid_request_error', param: null, code } }));
        });
        const label = typeof code === 'string' ? code : JSON.stringify(code);
        await assert.rejects(client.healthDetailed(), error => {
            assert.equal(error.code, 'HTTP_400', label);
            assert.equal(error.errorCode, undefined, label);
            assert.equal(Object.hasOwn(publicError(error), 'errorCode'), false, label);
            assert.doesNotMatch(JSON.stringify(publicError(error)), /APPROVAL_NOT_PENDING|Bearer nope|a{65}/);
            return true;
        }, label);
    }
});
