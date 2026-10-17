# Connect-phase failures are provably not dispatched

Date: 2026-10-16 · Issue: [#12](https://github.com/PhiKapJames/node-red-contrib-hermes-agent/issues/12) · Status: implemented on `fix/connect-phase-not-dispatched`

## Problem

`lib/client.js` raises `remoteUnknown: true` for every transport failure on a `POST`, because
`dispatched` is set immediately after `req.end(payload)` — before the socket has even
established a connection. `lib/queue.js` treats `remoteUnknown` as "the server may still be
running this run", so it refuses to answer: it stores the job as `uncertain`, pauses the queue,
and rejects every later request — and ordinary `reset()` — with `QUEUE_UNCERTAIN` until an
operator calls the `force` recovery.

When the failure is a connect-phase error (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, …) the
request never reached the Hermes process. There is no remote run, so the uncertainty guarantee
has nothing to protect, and the guarantee costs availability: restarting Hermes behind a
Tailscale hostname turns every later Telegram message into
`Queue is uncertain and is not accepting requests. Run recover()…` and a phone cannot resolve it.

## Decision

Classify the failure from the error actually thrown, not from the optimistic `dispatched` flag:

```js
const notDispatched = (error) =>
  error?.code === 'ERR_DNS_MOVE_LIST_NOTFOUND' ||
  error?.syscall === 'connect' ||
  error?.syscall === 'getaddrinfo';
```

A `POST` failure is uncertain **only when it is not provably connect-phase**:

```js
const remoteUnknown = dispatched && method === 'POST' && !notDispatched(error);
```

Chosen over the alternatives:

- **errno allowlist only** (`ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH`, `ENETDOWN`,
  `EADDRNOTAVAIL`, `ENOTFOUND`, `EAI_AGAIN`): correct today, and any errno added later stays wrong.
- **syscall gate alone**: misses the Node >= 20 internal
  `ERR_DNS_MOVE_LIST_NOTFOUND`, which surfaces with no `syscall` of its own.
- **`error.code === undefined` as an extra guard**: rejected — it would drop the uncertainty
  guarantee for any post-dispatch failure that lacks a code (including some
  `ERR_STREAM_*`/socket-hang-up shapes). Safety loses to tidiness.

The syscall gate is deliberately the load-bearing check: `syscall === 'connect'` can only be set
by the TCP connect attempt, so future errnos cannot be swept in.

## Contract after the fix

| Failure | Code | `retryable` | `remoteUnknown` | Queue |
| --- | --- | --- | --- | --- |
| Connect-phase `POST` failure (`syscall` `connect`/`getaddrinfo`, or `ERR_DNS_MOVE_LIST_NOTFOUND`) | `NETWORK` | `true` | `false` | stays `running`; next request admitted after `cooldownMs`; `startRetries` applies; `Idempotency-Key` unchanged across the admission retry |
| Post-dispatch failure (`ECONNRESET`, `ERR_STREAM_WRITE_AFTER_END`, `EPIPE`, socket hang up, `HTTP_TIMEOUT`) | `NETWORK` | `true` | `true` | `uncertain` + paused (unchanged) |
| Any failure on a `sync` (`chat`) call | `NETWORK` | `true` | classified the same way (`false` for connect-phase, `true` after dispatch) | untouched — `chat` never enters the queue |

One consequence of classifying in one place, `request()`:

- `sync` mode gains the same accuracy on its error objects (`chat` is a `POST`, so a connect
  failure used to claim `remoteUnknown: true`). Nothing about sync *queueing* changes — sync
  requests never enter the queue, so they could never pause anything.

Explicitly **not** in scope:

- `ECONNABORTED`, `EPIPE`, `socket hang up`, `HTTP_TIMEOUT` and any post-dispatch 5xx/408 stay
  uncertain.
- `INVALID_RESPONSE` without a `run_id` stays uncertain (issue #10).
- `QUEUE_CLOSED` during admission stays uncertain (issue #9).
- Non-force `reset()` still refuses to clear `uncertain` — the cancellation barrier keeps its
  teeth.
- The `recover()`-reports-`QUEUE_UNCERTAIN` follow-up (see below) ships separately as its own
  issue.

## Tests required

1. **Unit, pure**: the predicate accepts synthetic `{ code: 'ECONNREFUSED', syscall: 'connect' }`
   and `{ code: 'ENOTFOUND', syscall: 'getaddrinfo' }` and rejects `{ code: 'ECONNRESET' }`,
   `{}`, `undefined`, and `{ code: 'ERR_DNS_MOVE_LIST_NOTFOUND', syscall: undefined }` handled
   through the code branch.
2. **Integration, real transport**: connect failure to a closed port → `NETWORK`, retryable,
   `remoteUnknown: false`, and `queue.snapshot()` shows `uncertain === null`,
   `paused === false`, `active === null` (nothing retained, queue still `running`).
   Non-vacuity guard: the same assertions must fail if `notDispatched` is stubbed to
   `() => false`.
3. **Integration**: after a connect failure settles, a second request is admitted (not rejected
   with `QUEUE_UNCERTAIN`) once `cooldownMs` has passed.
4. **Integration**: `startRetries` is honoured for a refused connection — the `retrying` progress
   events show `operation: 'start'` at attempts 1 and 2 before the job fails — and the
   `Idempotency-Key` the server would see is unchanged across the admission retries.
5. **Integration regression**: a server that accepts the connection and destroys the socket
   **after** the request is read still pauses the queue with `remoteUnknown: true`.
6. **Integration regression**: `sync` (`chat`) errors use the same classification (a connect
   failure reports `remoteUnknown: false`) and never touch a queue.
7. **Integration regression**: the `!req` fallback still reports `REQUEST_CONFIG` — it is not a
   connect-phase errno signature, so it keeps today's behaviour.

Existing `NETWORK`/`HTTP_TIMEOUT` uncertainty tests in `test/queue.test.js` and
`test/queue-modern.test.js` are the regression floor and must stay green, together with the
`REQUEST_CONFIG` assertion in `test/client-modern.test.js`.

## Documentation updates

- `docs/agent-integration.md`: uncertainty rules and the error-code table — state that connect
  failures are provably not dispatched, keep the barrier wording for everything else. (The planned
  pointer to #10 was dropped: that is a merged PR about cancel-barrier coverage, not a tracked
  follow-up, and no shipped doc in this package references issue numbers.)
- `README.md`: node help + status section, same wording.
- `test/agent-docs.test.js`: extend the doc-consistency assertions if it pins the sentences changed.

## Forward compatibility

`docs/agent-integration.md` will state that the connect-phase classification is contract and will
not be broadened without a major-version note, so downstream adapters may treat `remoteUnknown`
as the conservative signal it is.

## Deferred follow-up (separate issue)

`recover()` reuses `QUEUE_UNCERTAIN` for the no-`run_id` case (`lib/queue.js:339`), so an app
cannot tell "retry later" from "needs a human". A distinct code (or a `recoverable: false` flag)
belongs in that follow-up, not here.
