# Connect-Phase Failures Are Provably Not Dispatched — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a connect-phase transport failure (`ECONNREFUSED`, `ETIMEDOUT` while connecting, DNS failure) fail its job retryably without pausing the shared Hermes queue, while every post-dispatch failure keeps claiming `remoteUnknown`.

**Architecture:** One classification predicate in `lib/client.js` reads the error that was actually thrown (`syscall`/`code`) instead of trusting the optimistic `dispatched` flag, and feeds the single `remoteUnknown` field that `lib/queue.js` already consumes. No new module, no new public option, no change to `lib/queue.js` — the queue keeps reacting to `error.remoteUnknown` exactly as today.

**Tech Stack:** Node.js 24 `node:http`, `node:test` (`assert/strict`), real `HermesQueue` + real `HermesClient` against localhost fixtures. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-16-connect-phase-not-dispatched-design.md`

## Verified signatures (measured, do not re-guess)

Measured on this machine (Linux, Node 24.22.0) with real `node:http` requests against real localhost fixtures. These are the facts the classification and the tests rest on:

| Situation | `error.code` | `error.syscall` | request `finish`ed? |
| --- | --- | --- | --- |
| Nothing listening on the port | `ECONNREFUSED` | `connect` | no |
| `*.invalid` host | `ENOTFOUND` | `getaddrinfo` | no |
| Server accepts, then destroys the socket | `ECONNRESET` (`socket hang up`) | `read` | **yes** |
| Server sends headers, then destroys | `ECONNRESET` | `read` | **yes** |
| Client deadline expires first | — (→ `HTTP_TIMEOUT`) | — | **yes** |
| `http.request()` throws synchronously (illegal header value) | → `REQUEST_CONFIG` | — | n/a, `req` never assigned |

Two consequences that are load-bearing for the tests below:

1. **A refused connect is already provable from the errno**, so the predicate discriminates correctly without any new plumbing.
2. **`finish`ed is not a usable signal** — a reset-after-connect and a refused connect differ in `syscall`, not in whether bytes were handed to the OS. Classify on `syscall`/`code` only.

`snapshot()` returns `paused, closed, pending, active, uncertain, queued, queuedTruncated, cooldownRemainingMs`. There is **no** `state` field — never assert one.

## Global Constraints

- Node.js `>= 24.0.0`, Node-RED `>= 5.0.0`; **zero runtime dependencies** — do not add an npm package, not even a dev dependency.
- Tests use `node:test` + `node:assert/strict` and real objects; never `node-red-node-test-helper`, never Sinon, never mocking `require`.
- Bearer-token redaction, no-redirect behaviour, the 2 MiB request / 8 MiB response caps, and stable `Idempotency-Key` values must be unchanged.
- `remoteUnknown` must stay **conservative**: an error that is not provably connect-phase keeps today's behaviour. Never widen the rule beyond the three signatures in the spec.
- Uncertainty semantics that stay exactly as today: `ECONNRESET`, `ECONNABORTED`, `ERR_STREAM_WRITE_AFTER_END`, `EPIPE`, `socket hang up`, `HTTP_TIMEOUT`, post-dispatch 5xx/408, `INVALID_RESPONSE` without `run_id`, `QUEUE_CLOSED` during admission, non-force `reset()` against `uncertain`, and the `recover()` `QUEUE_UNCERTAIN` response.
- **Do not convert the existing injected-error uncertainty tests** (`test/queue.test.js:153`, `test/queue-modern.test.js:65`) to a real client. They throw a hand-built `remoteUnknown: true` error and are the only regression floor for post-dispatch uncertainty that is independent of transport behaviour. Making them "more realistic" deletes that floor.
- **Portability limit:** the `syscall` values in the table above were observed on Linux/libuv. Windows/macOS libuv may report a different `syscall` for the same errno, so the synthetic-object unit test (Task 1 Step 1) is the *portable* pin and the localhost refused-connect test proves the rule only on the platform CI runs. State this in the changelog rather than implying an OS-independent guarantee.
- Commit per task with Conventional Commits on branch `fix/connect-phase-not-dispatched` (already checked out; the spec is commit `d523c4f`).

---

### Task 1: Classify the failure from the thrown error

**Files:**
- Modify: `lib/client.js` (the `catch` block of `HermesClient.request`, currently 116-127; and `module.exports` at the end of the file)
- Test: `test/client-modern.test.js` (append; it already imports `HermesClient` and defines `fixture(t, handler, options)`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `notDispatched(error): boolean`, exported from `lib/client.js` as a named export alongside `HermesClient` and `endpoint`. `error` may be any value, including `undefined`. Truthy only for: `code === 'ERR_DNS_MOVE_LIST_NOTFOUND'`, `syscall === 'connect'`, `syscall === 'getaddrinfo'`. Task 2 depends on this name and on it being exported.

- [ ] **Step 1: Write the predicate unit test** — append to `test/client-modern.test.js`, importing `notDispatched` from `../lib/client`. This is the portable pin (see the portability constraint): it pins the rule independently of what any OS reports.

```js
test('connect-phase errno signatures are provably not dispatched', () => {
    for (const error of [
        { code: 'ECONNREFUSED', syscall: 'connect' },
        { code: 'EHOSTUNREACH', syscall: 'connect' },
        { code: 'ENETUNREACH', syscall: 'connect' },
        { code: 'ETIMEDOUT', syscall: 'connect' },
        { code: 'ENOTFOUND', syscall: 'getaddrinfo' },
        { code: 'EAI_AGAIN', syscall: 'getaddrinfo' },
        { code: 'ERR_DNS_MOVE_LIST_NOTFOUND' }
    ]) assert.equal(notDispatched(error), true, JSON.stringify(error));
    for (const error of [
        { code: 'ECONNRESET', syscall: 'read' }, { code: 'ECONNRESET', syscall: 'write' },
        { code: 'ETIMEDOUT', syscall: 'read' }, { code: 'EPIPE', syscall: 'write' },
        { code: 'ERR_STREAM_WRITE_AFTER_END' }, { code: 'ECONNABORTED', syscall: 'accept' },
        new Error('socket hang up'),
        { code: undefined, syscall: undefined }, {}, null, undefined
    ]) assert.equal(notDispatched(error), false, JSON.stringify(error));
});
```

`{ code: 'ETIMEDOUT', syscall: 'connect' }` is the Tailscale-peer-down case, which is what actually happens when a VPN endpoint restarts — a handshake that is never answered, not a refusal. It is covered here and by the `syscall` gate, **not** by a live test: a real connect timeout needs an unroutable address and the kernel's SYN retransmit timeout (a probe against `10.255.255.1:9` produced no error in 18 s), so do not try to write one. `{ code: 'ETIMEDOUT', syscall: 'read' }` in the falsy list is the pair that keeps the gate on the *phase* rather than the errno.

- [ ] **Step 2: Write the transport tests that pin the new contract** — the closed port matches the existing `http://127.0.0.1:1` usage in `test/client.test.js`:

```js
test('a refused connection is retryable and never claims remote execution', async () => {
    const client = new HermesClient({ baseUrl: 'http://127.0.0.1:1', getKey: () => 'test-only-secret' });
    const isNotDispatched = error => error.code === 'NETWORK' && error.retryable && error.remoteUnknown === false;
    await assert.rejects(client.start({ input: 'x' }), isNotDispatched);
    await assert.rejects(client.chat({ messages: [] }), isNotDispatched);
    client.close();
});

test('a request that was never constructed still reports a configuration error', async () => {
    const client = new HermesClient({ baseUrl: 'http://127.0.0.1:1', getKey: () => 'test-only-secret' });
    await assert.rejects(client.start({ input: 'x' }, { headers: { 'Idempotency-Key': 'bad\nvalue' } }),
        error => error.code === 'REQUEST_CONFIG' && error.retryable === false && error.remoteUnknown === false);
    client.close();
});
```

`chat` is included because the classification is shared: a sync-mode connect failure used to report `remoteUnknown: true` and must now report `false` (spec "Contract after the fix").

The second test reaches the `!req` branch through a **synchronous throw from `http.request()` itself** — an illegal header value — which is the only deterministic way in. Measured: `http.request` throws `ERR_INVALID_CHAR` before assigning `req`, and `request()` reports `{ code: 'REQUEST_CONFIG', retryable: false, remoteUnknown: false }`. Do **not** use a throwing `getKey()` to reach that branch: `getKey()` is called at `lib/client.js:47`, *before* the `try`, so the error escapes `request()` as a raw `Error` with no `code` at all (measured: `code: undefined`). That pre-existing gap is recorded under *Not in scope* below.

- [ ] **Step 3: Run both tests and confirm they fail** — `node --test test/client-modern.test.js`. Expected: the first fails on `notDispatched is not a function`; the second fails the `remoteUnknown === false` assertion (today it is `true`). The third test (`REQUEST_CONFIG`) is expected to **pass already** — it is a floor, not a change. If the refused-connection test passes before the implementation, it proves nothing — fix the test before continuing.

- [ ] **Step 4: Implement.** Add the predicate above the `HermesClient` class in `lib/client.js` and add it to `module.exports`. Then, in the `catch (error)` of `request`, hoist the classification to one line before the `if (!req)` branch and use it in both places:

```js
const neverReachedServer = notDispatched(error);
// … in the !req branch:  remoteUnknown: false        (unchanged — req never existed)
// … in the shared throw: remoteUnknown: dispatched && method === 'POST' && !neverReachedServer
```

Keep `code: 'NETWORK'`, `retryable: true`, the `!req` branch's `REQUEST_CONFIG` code, and the `req.destroy()` call exactly as they are. Note the comment already in that branch — `notDispatched` is now the only thing that can prove a `POST` did not reach the server, so update that comment rather than leaving it pointing at `req`.

- [ ] **Step 5: Run the full unit suite** — `npm test`. Expected: all pass. Pay particular attention to `test/client.test.js:78` and `test/client-modern.test.js:32` (`HTTP_TIMEOUT … remoteUnknown`) and `test/client-modern.test.js:52` (`REQUEST_CONFIG`): those are the guarantee that post-dispatch uncertainty and the programmer-error code survived.

- [ ] **Step 6: Verify non-vacuity, then revert the check.** Temporarily change the predicate body to `return false;` and re-run `node --test test/client-modern.test.js` — the refused-connection test must fail. Restore the real body and re-run `npm run check && npm test`.

- [ ] **Step 7: Commit**

```bash
git add lib/client.js test/client-modern.test.js
git commit -m "fix: treat connect-phase failures as provably not dispatched"
```

---

### Task 2: Prove the queue stays available after a connect failure

**Files:**
- Create: `test/connect-phase.test.js` (picked up by `npm test`, which globs `test/*.test.js`)
- No production change expected. If a test fails here, the classification is wrong — fix `lib/client.js`, not the assertion.

**Interfaces:**
- Consumes: `notDispatched` classification from Task 1 through a **real** `HermesClient` (never a stubbed `start`), plus `HermesQueue` and `prepareRequest` as used by `test/queue-modern.test.js`.
- Produces: nothing consumed by later tasks.

**Acceptance standard for this file:** the queue must be *usable again*, not merely *not paused*. `enqueue` only rejects on `uncertain` (`lib/queue.js:73`), while `kick()` returns early on `paused` (`lib/queue.js:98`, `:110`) — so a fix that sets `paused = true` and leaves `uncertain` null passes every "not retained" assertion and still wedges the queue forever. Step 3 is what closes that hole; do not drop it.

- [ ] **Step 1: Write the file's fixtures.** Mirror `test/queue-modern.test.js`'s helpers. `sources()` lets one queue point at a dead endpoint and then at a live one, which is the deployment in the issue: Hermes behind Tailscale restarts and the next message must work.

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { HermesClient } = require('../lib/client');
const { HermesQueue } = require('../lib/queue');
const { prepareRequest } = require('../lib/request');

const secret = () => 'test-only-secret';
function queueFor(t, clientFor, options = {}) {
    const queue = new HermesQueue({ clientFor, pollIntervalMs: 5, stopTimeoutMs: 1000, jobTimeoutMs: 5000, retryDelayMs: 5, requestTimeoutMs: 1500, ...options });
    t.after(() => queue.close());
    return queue;
}
function submit(queue, input) {
    const ticket = queue.enqueue({ ownerId: 'agent', connectionId: 'connection', spec: prepareRequest(input, { clientId: 'agent' }), message: { payload: input } });
    ticket.finished.catch(() => {});
    return ticket;
}
const refused = () => new HermesClient({ baseUrl: 'http://127.0.0.1:1', getKey: secret });
const isNetwork = error => error.code === 'NETWORK' && error.retryable && error.remoteUnknown === false;

async function liveServer(t) {
    const server = http.createServer(async (req, res) => {
        for await (const _ of req) { /* drain */ }
        if (req.method === 'POST' && req.url.endsWith('/runs')) return void res.end(JSON.stringify({ run_id: 'run_live' }));
        if (req.method === 'POST') return void res.end(JSON.stringify({ status: 'cancelled' }));
        res.end(JSON.stringify({ status: 'completed', output: 'Recovered.' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    return new HermesClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, getKey: secret });
}
```

- [ ] **Step 2: Write the availability test.** `queue.enqueue` throws `QUEUE_UNCERTAIN` synchronously when a job is retained, so the second `submit` *is* the assertion that nothing was retained:

```js
test('a refused connection fails retryably and leaves the queue running', async t => {
    const client = refused();
    t.after(() => client.close());
    const queue = queueFor(t, () => client, { startRetries: 1 });
    await assert.rejects(submit(queue, 'first').finished, isNetwork);
    const after = queue.snapshot();
    assert.deepEqual([after.uncertain, after.paused, after.active], [null, false, null]);
    await assert.rejects(submit(queue, 'second').finished, isNetwork);
});
```

- [ ] **Step 3: Write the recovery test — the issue's actual symptom.** Fails before the fix with `QUEUE_UNCERTAIN` on the second submit; passes after. Verified against the real client and real queue: a completed job resolves with `output: 'Recovered.'`.

```js
test('the next request succeeds once the endpoint answers again', async t => {
    const dead = refused();
    t.after(() => dead.close());
    let endpoint = dead;
    const queue = queueFor(t, () => endpoint, { startRetries: 0 });
    await assert.rejects(submit(queue, 'while down').finished, isNetwork);
    endpoint = await liveServer(t);
    const result = await submit(queue, 'after restart').finished;
    assert.equal(result.output, 'Recovered.');
    assert.equal(result.status, 'completed');
    assert.deepEqual([queue.snapshot().paused, queue.snapshot().uncertain], [false, null]);
});
```

- [ ] **Step 4: Write the admission-retry test.** A thin recording wrapper keeps the real transport while capturing the header the queue sets once before its retry loop — a per-attempt key would be a bug, because the retry must resolve the same run:

```js
test('a refused connection exhausts startRetries under one idempotency key', async t => {
    const client = refused();
    t.after(() => client.close());
    const queue = queueFor(t, () => client, { startRetries: 2 });
    const keys = [];
    const attempts = [];
    queue.on('progress', (_job, event) => { if (event.status === 'retrying') attempts.push([event.operation, event.attempt]); });
    const recorder = { start: (body, options) => { keys.push(options.headers['Idempotency-Key']); return client.start(body, options); } };
    queue.clientFor = () => recorder;
    await assert.rejects(submit(queue, 'x').finished, isNetwork);
    assert.deepEqual(keys, Array(3).fill(keys[0]));
    assert.deepEqual(attempts, [['start', 1], ['start', 2]]);
    assert.deepEqual([queue.snapshot().uncertain, queue.snapshot().paused], [null, false]);
});
```

- [ ] **Step 5: Write the conservative-carry test.** The queue's last-resort rule (`error.remoteUnknown ||= uncertainAdmission`, `lib/queue.js:213`) must survive a fix that recomputes `remoteUnknown` from the *final* error alone. Attempt 1 is a retryable 503 (post-dispatch, uncertain); attempt 2 is a refused connect (provably not dispatched). Both attempts use the real client, so nothing about the transport is faked.

This test **discriminates**: before the fix, attempt 2 reports `remoteUnknown: true`; after the fix it reports `false` while the terminal error still reports `true` and the queue still pauses. Measured through the real queue: terminal `remoteUnknown: true`, `paused: true`, uncertain retained, 2 attempts.

```js
test('an earlier ambiguous admission still forces uncertainty after a refused retry', async t => {
    const failing = http.createServer((_req, res) => { res.statusCode = 503; res.end('{}'); });
    await new Promise(resolve => failing.listen(0, '127.0.0.1', resolve));
    t.after(() => { failing.closeAllConnections(); return new Promise(resolve => failing.close(resolve)); });
    const sick = new HermesClient({ baseUrl: `http://127.0.0.1:${failing.address().port}`, getKey: secret });
    const dead = refused();
    t.after(() => { sick.close(); dead.close(); });
    const unknown = [];
    let attempts = 0;
    const pick = () => (attempts++ ? dead : sick);
    const queue = queueFor(t, () => ({
        chat: (b, o) => pick().chat(b, o),
        start: async (b, o) => { try { return await pick().start(b, o); } catch (error) { unknown.push(error.remoteUnknown); throw error; } },
        status: (b, o) => pick().status(b, o),
        stop: (b, o) => pick().stop(b, o)
    }), { startRetries: 1 });
    await assert.rejects(submit(queue, 'x').finished, error => error.remoteUnknown === true);
    assert.deepEqual(unknown, [true, false], 'the 503 was ambiguous, the refused retry was provably not dispatched');
    assert.deepEqual([queue.snapshot().paused, Boolean(queue.snapshot().uncertain)], [true, true]);
});
```

- [ ] **Step 6: Write the regression test that keeps the guarantee.** The fixture must reset the **connection**, not the server-side request. `req.resume(); req.on('end', () => req.destroy())` destroys the `IncomingMessage`, which does **not** reset the connection: the client then waits out the whole request deadline and fails `HTTP_TIMEOUT`, and a bare `remoteUnknown === true` assertion would pass while pinning timeout behaviour instead of reset behaviour — the exact confusion this fix must not introduce. Use `req.socket.destroy()`, and assert `code === 'NETWORK'` so a regression to a hang cannot pass. `requestTimeoutMs` is small (from `queueFor`) so a hang fails in 1.5 s rather than after the 30 s default.

```js
test('a connection reset after the request is sent still pauses the queue', async t => {
    const server = http.createServer(req => { req.socket.destroy(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const client = new HermesClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, getKey: secret });
    t.after(() => client.close());
    const queue = queueFor(t, () => client, { startRetries: 1 });
    await assert.rejects(submit(queue, 'x').finished, error => error.code === 'NETWORK' && error.remoteUnknown === true);
    assert.equal(queue.snapshot().paused, true);
    assert.notEqual(queue.snapshot().uncertain, null);
    assert.throws(() => submit(queue, 'next'), error => error.code === 'QUEUE_UNCERTAIN');
});
```

- [ ] **Step 7: Run the new file** — `node --test test/connect-phase.test.js`. Expected: five passes. If Step 2 or 3 fails, `notDispatched` is not matching the real `ECONNREFUSED` error object: inspect the thrown error's `code`/`syscall` before changing anything, and do not broaden the predicate past the spec's three signatures. If Step 5's `unknown` array is `[true, true]`, the predicate is not being applied on the retry path.

- [ ] **Step 8: Run the unit and integration suites** — `npm run check && npm test && npm run test:integration`. Expected: all pass, including the existing `remoteUnknown: true` queue tests in `test/queue.test.js` and `test/queue-modern.test.js`, which stay as injected-error tests and must not be rewritten.

- [ ] **Step 9: Commit**

```bash
git add test/connect-phase.test.js
git commit -m "test: cover queue availability after connect-phase failures"
```

---

### Task 3: Keep the operator documentation honest

**Files:**
- Modify: `docs/agent-integration.md` (the `HTTP_TIMEOUT` / `NETWORK` row of the error table at 254, and the uncertainty paragraph ~152)
- Modify: `README.md` (the "A stop endpoint returning `stopping`…" paragraph, 150-152)
- Modify: `test/agent-docs.test.js` (add a doc-consistency test)
- Modify: `CHANGELOG.md` (new `Unreleased` section above `## 0.4.0-beta.1`)

**Interfaces:**
- Consumes: the shipped behaviour from Tasks 1-2.
- Produces: documentation strings that the new `agent-docs` assertions pin.

- [ ] **Step 1: Write the failing doc test** in `test/agent-docs.test.js`:

```js
test('runbook states that connect failures are not uncertain and list-reaches the barrier', () => {
    const guide = read('docs/agent-integration.md');
    const changelog = read('CHANGELOG.md');
    assert.match(guide, /connection was refused, timed out while connecting, or the host could not be resolved/);
    assert.match(guide, /provably not dispatched/i);
    assert.match(changelog, /connect-phase|connection was refused/);
});
```

Run `node --test test/agent-docs.test.js` and confirm it fails.

- [ ] **Step 2: Update `docs/agent-integration.md`.** Split the `HTTP_TIMEOUT` / `NETWORK` row into two rows and state the rule: `NETWORK` from a refused connection, a connection that timed out during the handshake, or an unresolved host is *provably not dispatched* — the job fails retryably, the queue stays running and admits the next request after `cooldownMs`; add a bullet under the uncertainty rules saying a refused or unresolved connection never puts the queue in the uncertain state, so `recover`/force reset are not needed for it, and that everything else listed there (`ECONNRESET`, `socket hang up`, `HTTP_TIMEOUT`, `INVALID_RESPONSE` without a `run_id`, `QUEUE_CLOSED`) still does. Name `ETIMEDOUT` while connecting explicitly — a VPN peer that is simply down times out rather than refusing, and that is the deployment case in issue #12. Keep `HTTP_TIMEOUT` (deadline exceeded after dispatch) in the uncertain row, unchanged. Mention that non-force `reset()` still refuses to clear an uncertain job. Use the exact phrases Step 1 asserts.

- [ ] **Step 3: Update `README.md`.** In the paragraph that begins "A stop endpoint returning `stopping`…", add one sentence with the same rule in operator language: a refused connection, a handshake timeout or an unresolved host is provably not dispatched, so the job fails retryably and the queue keeps running; a connection dropped after the request was sent still pauses the queue until `recover` or force reset.

- [ ] **Step 4: Update `CHANGELOG.md`.** Add an `## Unreleased` section above `## 0.4.0-beta.1` in the existing house style (one dense paragraph): fixes issue #12, names the syscall/errno rule, states that the uncertainty guarantee for post-dispatch failures is unchanged, states explicitly that a Hermes restart no longer requires editor access to a force reset, and notes that the classification keys on libuv `syscall` values observed on Linux with the rule pinned by platform-independent unit tests.

- [ ] **Step 5: Verify** — `node --test test/agent-docs.test.js && npm run check && npm test`. Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add docs/agent-integration.md README.md CHANGELOG.md test/agent-docs.test.js
git commit -m "docs: document connect-phase failures as provably not dispatched"
```

---

### Final validation (whole branch, after Task 3)

`AGENTS.md` requires the full sequence, not just the unit suites. On Node.js 24+ with no lockfile changes:

```bash
npm ci
npm run check
npm test
npm install --no-save --package-lock=false --ignore-scripts node-red@5
npm run test:integration
npm pack --dry-run
```

Expected: every command exits 0. `npm pack --dry-run` must list `AGENTS.md`, `docs/` and `CHANGELOG.md`. Report the actual Node version used and which commands were run — do not report this branch as green from unit tests alone.

## Not in scope (recorded, do not fix here)

- **A throwing credential getter escapes the error boundary.** `getKey()` is called at `lib/client.js:47`, outside the `try`, so a credential-store failure surfaces as a raw `Error` with no `code`, bypassing `HermesError`, `publicError` and redaction. Pre-existing, unrelated to issue #12, and it needs its own decision about the code and message. Worth a separate issue.
- **`recover()` reuses `QUEUE_UNCERTAIN`** for the no-`run_id` case (`lib/queue.js:339`), so an application cannot distinguish "retry later" from "needs a human". Its own follow-up issue.

## Review Focus

- **A failure with no `code` and no `syscall`** (`socket hang up` style `Error`s, `ERR_STREAM_*`, a callback error with a mangled errno) must still report `remoteUnknown: true` — the predicate is an allowlist of three signatures, never "code is missing". Pinned by Task 1 Step 1's falsy list and Step 6's revert check.
- **DNS failures that never produce a `syscall`** on Node ≥ 20 (`ERR_DNS_MOVE_LIST_NOTFOUND`) must be treated as connect-phase, or a Tailscale hostname that drops during a Hermes restart reproduces issue #12. Pinned by Task 1 Step 1.
- **The `syscall` gate, not the errno, carries the guarantee.** `ETIMEDOUT` must be connect-phase when `syscall` is `connect` and must stay uncertain when it is `read`. Pinned by Task 1 Step 1's paired cases.
- **`sync` mode callers reading `msg.hermes.error.remoteUnknown`** now get `false` instead of `true` for connect failures — intended, and it must not silently change for timeouts/aborts. Pinned by Task 1 Step 2 plus the untouched `HTTP_TIMEOUT`/`ABORTED` assertions in `test/client.test.js`.
- **A Hermes that accepts the socket and then dies** must keep pausing the queue; a fix that classifies on "no response received" instead of "connect failed" breaks exactly this. Pinned by Task 2 Step 6, which must reset the socket (`req.socket.destroy()`) — destroying the server-side `IncomingMessage` silently degrades the test into an `HTTP_TIMEOUT` test that still passes.
- **Not-paused is not the acceptance bar; usable is.** A fix that pauses the queue while leaving `uncertain` null passes every "not retained" assertion because `enqueue` only throws on `uncertain`. Pinned by Task 2 Step 3, which asserts a completed answer after the endpoint returns.
- **Uncertainty must not be recomputed from the final error alone.** An ambiguous admission followed by a provably-not-dispatched retry still has to pause the queue. Pinned by Task 2 Step 5.
- **Retries must not mint a fresh idempotency key per attempt**, or a retried admission can start two remote runs — the very thing the uncertainty machinery guards. Pinned by Task 2 Step 4.
- **The existing injected-error uncertainty tests stay as they are.** Rewriting `test/queue.test.js:153` or `test/queue-modern.test.js:65` onto a real client removes the only transport-independent floor for post-dispatch uncertainty.
