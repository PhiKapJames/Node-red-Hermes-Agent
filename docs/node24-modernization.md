# Node.js 24 modernization decisions (0.3.0)

## Baseline

Node-RED >=5.0.0 and Node.js >=24.0.0. Use the latest patched 24.x release in production; 24.0.0 is tested only to verify the declared compatibility floor. Node 26 is a forward-compatibility test target, not an instruction to switch production away from LTS. CommonJS registration and `RED.util.cloneMessage` remain deliberate supported Node-RED APIs, not compatibility shims.

## Transport

Evaluated native fetch. Node's fetch dispatcher is not an `https.Agent`; retaining Node-RED's custom CA/client-certificate/TLS configuration would need an additional compatible dispatcher implementation (such as an external Undici dependency) or a second transport path. Neither simplifies this zero-runtime-dependency package. Retain one core HTTP/TLS path and modernize it instead: asynchronous stream iteration, one per-connection pool, composed abort signals, full-response deadlines and one cleanup block.

Preserve the fixed profile/endpoint and credential source, header allowlist, no redirects, request/response byte limits, default TLS verification, custom CA/mutual TLS, sanitized errors and conservative uncertain-execution semantics. The stream remains bounded; do not replace it with unbounded `response.json()`.

## Scheduling and lifecycle

Use abortable `node:timers/promises` waits rather than timer handles and stored wake functions. Cancellation of an async admission must not discard the late run ID required to stop it. A definitive rejected admission can be cancelled without another POST; an ambiguous attempt is retried only with the original idempotency key. Non-force reset still retains the active slot through terminal confirmation; unconfirmed execution pauses admissions. Connection shutdown interrupts local requests. Queue shutdown settles waiting tickets, wakes timers and best-effort stops known/late runs without claiming remote termination.

Input handlers complete through `done(error)` once in a `finally` block. Async control/node shutdown does not emit a result after the node has closed. Shutdown remains best effort, not a durability or process-crash recovery feature.

## Tests and future maintenance

Remove `node-red-node-test-helper`, Sinon and related legacy helper dependencies. Real Node-RED integration tests now use the documented embedding lifecycle in a separate process per fixture, loaded nodes, temporary flow/credential storage and a small test-only IPC bridge. No Node-RED singleton is stopped and restarted, and no runtime internals are monkeypatched. Native `node:test`, assertions and mock Hermes HTTP services cover final output, Catch/Complete, credential secrecy, author mapping, queue settings, session routing and reset.

Transport regressions cover trickling bodies, abort timing, redirects, body-size caps, keep-alive reuse and custom CA/mutual TLS. Queue regressions cover cancellation during sleeps, definite versus ambiguous admission, cooldown interruption, shutdown and late admission. Tests run with `--throw-deprecation` and CI checks that removed helper packages stay absent. Test fixtures and generated TLS keys are not included in the published package. Dependencies can acquire new warnings/advisories in the future; modernizing is not a permanent no-deprecation guarantee.

## References

- https://nodejs.org/download/release/v24.0.0/docs/api/globals.html
- https://nodejs.org/download/release/v24.0.0/docs/api/timers.html
- https://nodejs.org/download/release/v24.0.0/docs/api/http.html
- https://nodered.org/docs/user-guide/runtime/embedding
- https://nodered.org/docs/creating-nodes/node-js
