# Connect-Phase Failures Are Provably Not Dispatched — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a connect-phase transport failure (`ECONNREFUSED`, DNS failure) fail its job retryably without pausing the shared Hermes queue, while every post-dispatch failure keeps claiming `remoteUnknown`.

**Architecture:** One classification predicate in `lib/client.js` reads the error that was actually thrown (`syscall`/`code`) instead of trusting the optimistic `dispatched` flag, and feeds the single `remoteUnknown` field that `lib/queue.js` already consumes. No new module, no new public option, no change to `lib/queue.js` — the queue keeps reacting to `error.remoteUnknown` exactly as today.

**Tech Stack:** Node.js 24 `node:http`, `node:test` (`assert/strict`), real `HermesQueue` + real `HermesClient` against localhost fixtures. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-16-connect-phase-not-dispatched-design.md`

## Global Constraints

- Node.js `>= 24.0.0`, Node-RED `>= 5.0.0`; **zero runtime dependencies** — do not add an npm package, not even a dev dependency.
- Tests use `node:test` + `node:assert/strict` and real objects; never `node-red-node-test-helper`, never Sinon, never mocking `require`.
- Bearer-token redaction, no-redirect behaviour, the 2 MiB request / 8 MiB response caps, and stable `Idempotency-Key` values must be unchanged.
- `remoteUnknown` must stay **conservative**: an error that is not provably connect-phase keeps today's behaviour. Never widen the rule beyond the three signatures in the spec.
- Uncertainty semantics that stay exactly as today: `ECONNRESET`, `ECONNABORTED`, `ERR_STREAM_WRITE_AFTER_END`, `EPIPE`, `socket hang up`, `HTTP_TIMEOUT`, post-dispatch 5xx/408, `INVALID_RESPONSE` without `run_id`, `QUEUE_CLOSED` during admission, non-force `reset()` against `uncertain`, and the `recover()` `QUEUE_UNCERTAIN` response.
- Commit per task with Conventional Commits on branch `fix/connect-phase-not-dispatched` (already checked out; the spec is commit `d523c4f`).

---

### Task 1: Classify the failure from the thrown error

**Files:**
- Modify: `lib/client.js` (the `catch` block of `HermesClient.request`, currently ~116-127; and `module.exports` at the end of the file)
- Test: `test/client-modern.test.js` (append; it already imports `HermesClient` and defines `fixture(t, handler, options)`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `notDispatched(error): boolean`, exported from `lib/client.js` as a named export alongside `HermesClient` and `endpoint`. `error` may be any value, including `undefined`. Truthy only for: `code === 'ERR_DNS_MOVE_LIST_NOTFOUND'`, `syscall === 'connect'`, `syscall === 'getaddrinfo'`. Task 2 depends on this name and on it being exported.

- [ ] **Step 1: Write the predicate unit test** — append to `test/client-modern.test.js`, importing `notDispatched` from `../lib/client`:

```js
test('connect-phase errno signatures are provably not dispatched', () => {
    for (const error of [
        { code: 'ECONNREFUSED', syscall: 'connect' },
        { code: 'EHOSTUNREACH', syscall: 'connect' },
        { code: 'ENETUNREACH', syscall: 'connect' },
        { code: 'ENOTFOUND', syscall: 'getaddrinfo' },
        { code: 'EAI_AGAIN', syscall: 'getaddrinfo' },
        { code: 'ERR_DNS_MOVE_LIST_NOTFOUND' }
    ]) assert.equal(notDispatched(error), true, JSON.stringify(error));
    for (const error of [
        { code: 'ECONNRESET', syscall: 'read' }, { code: 'ECONNRESET', syscall: 'write' },
        { code: 'ERR_STREAM_WRITE_AFTER_END' }, { code: 'EPIPE', syscall: 'write' },
        { code: 'ECONNABORTED', syscall: 'accept' }, new Error('socket hang up'),
        { code: undefined, syscall: undefined }, {}, null, undefined
    ]) assert.equal(notDispatched(error), false, JSON.stringify(error));
});
```

- [ ] **Step 2: Write the transport test that pins the new contract** — the closed port is deliberate and matches the existing `http://127.0.0.1:1` usage in `test/client.test.js`:

```js
test('a refused connection is retryable and never claims remote execution', async () => {
    const client = new HermesClient({ baseUrl: 'http://127.0.0.1:1', getKey: () => 'test-only-secret' });
    const isNotDispatched = error => error.code === 'NETWORK' && error.retryable && error.remoteUnknown === false;
    await assert.rejects(client.start({ input: 'x' }), isNotDispatched);
    await assert.rejects(client.chat({ messages: [] }), isNotDispatched);
    client.close();
});

test('a request that was never constructed still reports a configuration error', async () => {
    const client = new HermesClient({ baseUrl: 'http://127.0.0.1:1', getKey: () => { throw new Error('credential store unavailable'); } });
    await assert.rejects(client.start({ input: 'x' }), { code: 'REQUEST_CONFIG' });
    client.close();
});
```

`chat` is included because the classification is shared: a sync-mode connect failure used to report `remoteUnknown: true` and must now report `false` (spec "Contract after the fix"). The second test pins the untouched `!req` fallback — `getKey()` throwing is the one deterministic way to reach it, and that branch stays `REQUEST_CONFIG` because it carries no connect-phase errno signature.

- [ ] **Step 3: Run both tests and confirm they fail** — `node --test test/client-modern.test.js`. Expected: the first fails on `notDispatched is not a function`; the second fails the `remoteUnknown === false` assertion (today it is `true`). If either test passes before the implementation, it proves nothing — fix the test before continuing.

- [ ] **Step 4: Implement.** Add the predicate above the `HermesClient` class in `lib/client.js` and add it to `module.exports`. Then, in the `catch (error)` of `request`, hoist the classification to one line before the `if (!req)` branch and use it in both places:

```js
const neverReachedServer = notDispatched(error);
// … in the !req branch:  remoteUnknown: false        (unchanged — req never existed)
// … in the shared throw: remoteUnknown: dispatched && method === 'POST' && !neverReachedServer
```

Keep `code: 'NETWORK'`, `retryable: true`, the `!req` branch's `REQUEST_CONFIG` code, and the `req.destroy()` call exactly as they are. Note the comment already in that branch — `notDispatched` is now the only thing that can prove a `POST` did not reach the server, so update that comment rather than leaving it pointing at `req`.

- [ ] **Step 5: Run the full unit suite** — `npm test`. Expected: all pass. Pay particular attention to `test/client.test.js:78` and `test/client-modern.test.js:32` (`HTTP_TIMEOUT … remoteUnknown`) and `test/client-modern.test.js:52` (`REQUEST_CONFIG`): those are the guarantee that post-dispatch uncertainty and the programmer-error code survived.

- [ ] **Step 6: Verify non-vacuity, then revert the check.** Temporarily change the predicate body to `return false;` and re-run `node --test test/client-modern.test.js` — the new transport test must fail. Restore the real body and re-run `npm run check && npm test`.

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

- [ ] **Step 1: Write the file's fixtures.** Mirror `test/queue-modern.test.js`'s helpers, but with the real client pointed at a closed port:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { HermesClient } = require('../lib/client');
const { HermesQueue } = require('../lib/queue');
const { prepareRequest } = require('../lib/request');

function refused(t, queueOptions = {}) {
    const client = new HermesClient({ baseUrl: 'http://127.0.0.1:1', getKey: () => 'test-only-secret' });
    const queue = new HermesQueue({ clientFor: () => client, pollIntervalMs: 5, stopTimeoutMs: 1000, jobTimeoutMs: 5000, retryDelayMs: 5, ...queueOptions });
    t.after(() => { queue.close(); client.close(); });
    return { client, queue };
}
function submit(queue, input) {
    const ticket = queue.enqueue({ ownerId: 'agent', connectionId: 'connection', spec: prepareRequest(input, { clientId: 'agent' }), message: { payload: input } });
    ticket.finished.catch(() => {});
    return ticket;
}
const isNetwork = error => error.code === 'NETWORK' && error.retryable && error.remoteUnknown === false;
```

- [ ] **Step 2: Write the availability test.** `queue.enqueue` throws `QUEUE_UNCERTAIN` synchronously when a job is retained, so the second `submit` *is* the assertion that nothing was retained:

```js
test('a refused connection fails retryably and leaves the queue running', async t => {
    const { queue } = refused(t);
    await assert.rejects(submit(queue, 'first').finished, isNetwork);
    const after = queue.snapshot();
    assert.equal(after.uncertain, null);
    assert.equal(after.paused, false);
    assert.equal(after.active, null);
    await assert.rejects(submit(queue, 'second').finished, isNetwork);
});
```

- [ ] **Step 3: Write the admission-retry test.** A thin recording wrapper keeps the real transport while capturing the header the queue sets once before its retry loop — a per-attempt key would be a bug, because the retry must resolve the same run:

```js
test('a refused connection exhausts startRetries under one idempotency key', async t => {
    const { client, queue } = refused(t, { startRetries: 2 });
    const keys = [];
    const attempts = [];
    queue.on('progress', (_job, event) => { if (event.status === 'retrying') attempts.push(event.attempt); });
    const recorder = { start: (body, options) => { keys.push(options.headers['Idempotency-Key']); return client.start(body, options); } };
    queue.clientFor = () => recorder;
    await assert.rejects(submit(queue, 'x').finished, isNetwork);
    assert.deepEqual(keys, Array(3).fill(keys[0]));
    assert.deepEqual(attempts, [1, 2]);
    assert.equal(queue.snapshot().uncertain, null);
    assert.equal(queue.snapshot().paused, false);
});
```

- [ ] **Step 4: Write the regression test that keeps the guarantee.** The handler only runs once the request has been read, so destroying the socket from it is unambiguously post-dispatch:

```js
test('a socket destroyed after the request is read still pauses the queue', async t => {
    const server = http.createServer(req => { req.resume(); req.on('end', () => req.destroy()); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.closeAllConnections());
    const client = new HermesClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, getKey: () => 'test-only-secret' });
    const queue = new HermesQueue({ clientFor: () => client, pollIntervalMs: 5, stopTimeoutMs: 1000, jobTimeoutMs: 5000, retryDelayMs: 5, startRetries: 1 });
    t.after(() => { queue.close(); client.close(); });
    await assert.rejects(submit(queue, 'x').finished, error => error.remoteUnknown === true);
    assert.equal(queue.snapshot().paused, true);
    assert.notEqual(queue.snapshot().uncertain, null);
    assert.throws(() => submit(queue, 'next'), error => error.code === 'QUEUE_UNCERTAIN');
});
```

- [ ] **Step 5: Run the new file** — `node --test test/connect-phase.test.js`. Expected: three passes. If Step 2 or 3 fails, `notDispatched` is not matching the real `ECONNREFUSED` error object: inspect the thrown error's `code`/`syscall` before changing anything, and do not broaden the predicate past the spec's three signatures.

- [ ] **Step 6: Run everything** — `npm run check && npm test && npm run test:integration`. Expected: all pass, including the existing `remoteUnknown: true` queue tests in `test/queue.test.js` and `test/queue-modern.test.js`.

- [ ] **Step 7: Commit**

```bash
git add test/connect-phase.test.js
git commit -m "test: cover queue availability after connect-phase failures"
```

---

### Task 3: Keep the operator documentation honest

**Files:**
- Modify: `docs/agent-integration.md` (the `NETWORK` row of the error table ~254, and the `status` snapshot paragraph ~233)
- Modify: `README.md` (the "A stop endpoint returning `stopping`…" paragraph, ~150-152)
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
    assert.match(guide, /connection was refused or the host could not be resolved/);
    assert.match(guide, /provably not dispatched/i);
    assert.match(changelog, /connect-phase|connection was refused/);
});
```

Run `node --test test/agent-docs.test.js` and confirm it fails.

- [ ] **Step 2: Update `docs/agent-integration.md`.** Split the `HTTP_TIMEOUT` / `NETWORK` row into two rows and state the rule: `NETWORK` from a refused connection or an unresolved host is *provably not dispatched* — the job fails retryably, the queue stays running and admits the next request after `cooldownMs`; add a bullet under the uncertainty rules saying a connection refused or an unresolved host never puts the queue in the uncertain state, so `recover`/force reset are not needed for it, and that everything else listed there (`ECONNRESET`, `socket hang up`, `HTTP_TIMEOUT`, `INVALID_RESPONSE` without a `run_id`, `QUEUE_CLOSED`) still does. Mention that non-force `reset()` still refuses to clear an uncertain job. Use the exact phrases Step 1 asserts.

- [ ] **Step 3: Update `README.md`.** In the paragraph that begins "A stop endpoint returning `stopping`…", add one sentence with the same rule in operator language: a refused connection or an unresolved host is provably not dispatched, so the job fails retryably and the queue keeps running; a connection dropped after the request was sent still pauses the queue until `recover` or force reset.

- [ ] **Step 4: Update `CHANGELOG.md`.** Add an `## Unreleased` section above `## 0.4.0-beta.1` in the existing house style (one dense paragraph): fixes issue #12, names the syscall/errno rule, states that the uncertainty guarantee for post-dispatch failures is unchanged, and states explicitly that a Hermes restart no longer requires editor access to a force reset.

- [ ] **Step 5: Verify** — `node --test test/agent-docs.test.js && npm run check && npm test`. Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add docs/agent-integration.md README.md CHANGELOG.md test/agent-docs.test.js
git commit -m "docs: document connect-phase failures as provably not dispatched"
```

---

## Review Focus

- **A failure with no `code` and no `syscall`** (`socket hang up` style `Error`s, `ERR_STREAM_*`, a callback error with a mangled errno) must still report `remoteUnknown: true` — the predicate is an allowlist of three signatures, never "code is missing". Pinned by Task 1 Step 1's falsy list and Step 6's revert check.
- **DNS failures that never produce a `syscall`** on Node ≥ 20 (`ERR_DNS_MOVE_LIST_NOTFOUND`) must be treated as connect-phase, or a Tailscale hostname that drops during a Hermes restart reproduces issue #12. Pinned by Task 1 Step 1.
- **`sync` mode callers reading `msg.hermes.error.remoteUnknown`** now get `false` instead of `true` for connect failures — intended, and it must not silently change for timeouts/aborts. Pinned by Task 1 Step 2 plus the untouched `HTTP_TIMEOUT`/`ABORTED` assertions in `test/client.test.js`.
- **A Hermes that accepts the socket and then dies** must keep pausing the queue; a fix that classifies on "no response received" instead of "connect failed" breaks exactly this. Pinned by Task 2 Step 4.
- **Retries must not mint a fresh idempotency key per attempt**, or a retried admission can start two remote runs — the very thing the uncertainty machinery guards. Pinned by Task 2 Step 3.
