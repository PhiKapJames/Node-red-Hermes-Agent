'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { HermesClient, notDispatched } = require('../lib/client');

async function fixture(t, handler, options = {}) {
    // options.config replaces the server entirely: point the client at a fixed address instead of a
    // listening socket, for failures that never reach a server at all.
    const address = options.config || null;
    const server = address ? null : options.server || http.createServer(handler);
    if (server) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new HermesClient({ baseUrl: address || `${options.server ? 'https' : 'http'}://127.0.0.1:${server.address().port}`, getKey: () => 'test-only-secret', ...options.client });
    t.after(async () => {
        client.close();
        if (!server) return;
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    return { client, server };
}

test('composed deadline covers a body that trickles after headers', async t => {
    const { client } = await fixture(t, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{');
        const interval = setInterval(() => res.write(' '), 5);
        res.on('close', () => clearInterval(interval));
    });
    await assert.rejects(client.start({}, { timeoutMs: 40 }), error => error.code === 'HTTP_TIMEOUT' && error.remoteUnknown);
});

test('caller abort after headers is not misreported as a timeout', async t => {
    const seen = Promise.withResolvers();
    const { client } = await fixture(t, (_req, res) => { res.writeHead(200); res.write('{'); seen.resolve(); });
    const controller = new AbortController();
    const response = client.start({}, { signal: controller.signal, timeoutMs: 5000 });
    await seen.promise;
    controller.abort();
    await assert.rejects(response, error => error.code === 'ABORTED' && error.remoteUnknown && !error.retryable);
});

test('pre-dispatch abort and invalid JSON never claim remote execution', async t => {
    let calls = 0;
    const { client } = await fixture(t, (_req, res) => { calls++; res.end('{}'); });
    await assert.rejects(client.start({}, { signal: AbortSignal.abort() }), error => error.code === 'ABORTED' && !error.remoteUnknown);
    const body = {}; body.self = body;
    await assert.rejects(client.start(body), error => error.code === 'INVALID_INPUT' && !error.remoteUnknown);
    await assert.rejects(client.start({}, { timeoutMs: 1.5 }), { code: 'REQUEST_CONFIG' });
    assert.equal(calls, 0);
});

test('connection shutdown aborts outstanding waits and prevents new dispatch', async t => {
    const { client, server } = await fixture(t, () => {});
    const received = once(server, 'request');
    const result = client.chat({});
    await received;
    client.close();
    await assert.rejects(result, error => error.code === 'ABORTED' && error.remoteUnknown);
    await assert.rejects(client.start({}), { code: 'CONNECTION_CLOSED' });
    client.close(); // idempotent
});

test('fixed credential destination and redaction survive async transport refactor', async t => {
    const { client } = await fixture(t, (req, res) => {
        assert.equal(req.headers.authorization, 'Bearer test-only-secret');
        assert.equal(req.headers['x-hermes-session-id'], 'conversation');
        assert.equal(req.headers['x-unsafe'], undefined);
        res.writeHead(403);
        res.end(JSON.stringify({ error: { message: 'Bad test-only-secret' } }));
    });
    await assert.rejects(client.start({}, { headers: { Authorization: 'attacker', 'X-Unsafe': 'bad', 'X-Hermes-Session-Id': 'conversation' } }), error => {
        assert.equal(error.code, 'HTTP_403');
        assert.equal(error.remoteUnknown, false);
        assert.equal(error.retryable, false);
        assert.doesNotMatch(error.message, /test-only-secret/);
        return true;
    });
});

test('redirect is rejected without contacting its credential-stealing target', async t => {
    let stolen = 0;
    const target = await fixture(t, (_req, res) => { stolen++; res.end('{}'); });
    const { client } = await fixture(t, (_req, res) => {
        res.writeHead(307, { Location: `http://127.0.0.1:${target.server.address().port}/steal` });
        res.end('{}');
    });
    await assert.rejects(client.start({}), { code: 'REDIRECT_BLOCKED' });
    assert.equal(stolen, 0);
});

for (const mode of ['declared', 'chunked']) {
    test(`8 MiB response cap is enforced for ${mode} bodies`, async t => {
        const { client } = await fixture(t, (_req, res) => {
            if (mode === 'declared') { res.writeHead(200, { 'Content-Length': 8 * 1024 * 1024 + 1 }); res.flushHeaders(); }
            else { res.writeHead(200, { 'Transfer-Encoding': 'chunked' }); res.end(' '.repeat(8 * 1024 * 1024 + 1)); }
        });
        await assert.rejects(client.start({}), error => error.code === 'RESPONSE_TOO_LARGE' && error.remoteUnknown);
    });
}

test('2 MiB request cap rejects locally', async t => {
    let calls = 0;
    const { client } = await fixture(t, (_req, res) => { calls++; res.end('{}'); });
    await assert.rejects(client.start({ input: 'x'.repeat(2 * 1024 * 1024) }), error => error.code === 'INPUT_TOO_LARGE' && !error.remoteUnknown);
    assert.equal(calls, 0);
});

test('keep-alive connections are reused only after complete response consumption', async t => {
    const sockets = new Set();
    const { client } = await fixture(t, (req, res) => { sockets.add(req.socket); res.end('{"ok":true}'); });
    for (let i = 0; i < 3; i++) assert.deepEqual(await client.status('r'), { ok: true });
    assert.equal(sockets.size, 1);
});

test('custom CA and mutual TLS are retained; default untrusted TLS is rejected', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-test-tls-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    // Disposable test-only key material. Nothing is embedded in the repository.
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { cwd: directory, stdio: 'ignore' });
    const key = await fs.readFile(path.join(directory, 'key.pem'));
    const cert = await fs.readFile(path.join(directory, 'cert.pem'));
    const server = https.createServer({ key, cert, ca: cert, requestCert: true, rejectUnauthorized: true }, (req, res) => {
        assert.equal(req.socket.authorized, true);
        res.end('{"secure":true}');
    });
    const { client } = await fixture(t, null, { server, client: { tlsOptions: { ca: cert, cert, key } } });
    assert.deepEqual(await client.start({}), { secure: true });
    const untrusted = new HermesClient({ baseUrl: client.base, getKey: () => 'test-only-secret' });
    t.after(() => untrusted.close());
    await assert.rejects(untrusted.start({}), { code: 'NETWORK' });
});

// A failed TCP connect reports syscall 'connect' and ECONNREFUSED on every supported Node;
// the two codes below are the only ones whose syscall is not already 'connect', and they are
// pinned by name rather than probed at runtime. See the spec for the portability caveat.
test('connect-phase transport failures are provably not dispatched', async t => {
    assert.equal(notDispatched({ code: 'ECONNREFUSED', syscall: 'connect' }), true);
    assert.equal(notDispatched({ code: 'ENOTFOUND', syscall: 'getaddrinfo' }), true);
    assert.equal(notDispatched({ code: 'EAI_AGAIN', syscall: 'getaddrinfo' }), true);
    assert.equal(notDispatched({ code: 'EHOSTUNREACH', syscall: 'connect' }), true);
    assert.equal(notDispatched({ code: 'ENETUNREACH', syscall: 'connect' }), true);
    assert.equal(notDispatched({ code: 'ERR_DNS_MOVE_LIST_NOTFOUND' }), true);
    assert.equal(notDispatched({ code: 'ETIMEDOUT', syscall: 'connect' }), true);
    assert.equal(notDispatched({ code: 'ECONNABORTED', syscall: 'read' }), false);
    assert.equal(notDispatched({ code: 'ERR_INVALID_ARG_TYPE', syscall: undefined }), false);
    assert.equal(notDispatched(new Error('plain')), false);
    assert.equal(notDispatched(undefined), false);
    assert.equal(notDispatched({ message: 'connect ECONNREFUSED 127.0.0.1:1' }), false);

    // A refused port is a real connect failure through the real transport.
    const { client: refusedClient } = await fixture(t, null, { config: 'http://127.0.0.1:9' });
    await assert.rejects(refusedClient.start({ input: 'x' }), error =>
        error.code === 'NETWORK' && error.remoteUnknown === false && error.retryable === true);
    await assert.rejects(refusedClient.chat({ input: 'x' }), error =>
        error.code === 'NETWORK' && error.remoteUnknown === false && error.retryable === true);

    // A request that was never constructed keeps its existing classification.
    const { client: configClient } = await fixture(t, null, { config: 'http://127.0.0.1:9' });
    await assert.rejects(configClient.start({ input: 'x' }, { headers: { 'X-Hermes-Session-Id': 'bad\nheader' } }), error =>
        error.code === 'REQUEST_CONFIG' && error.remoteUnknown === false && error.retryable === false);
});
