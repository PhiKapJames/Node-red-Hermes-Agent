# Build plan — admission backoff, server diagnostics, approval bridge

Status: **approved**. Source of truth for this increment.
Design origin: evaluation of `node-red-contrib-ai-agent` (lesichkovm) at commit
`37e3d93986397278521caae7eecd174e79802718` (npm `0.5.17`, **AGPL-3.0**). That project is a
different licence from this MIT package, so **no code is reused**; only concepts were
evaluated, and everything here is implemented independently.

## Global constraints (never violated)

1. **Transport neutrality.** No transport-specific policy (channel recognition, sender
   authentication, dedup, destinations, delivery formatting, output-size limits) enters this
   package. Those are upstream/downstream adapter concerns.
2. **No new runtime dependencies.** Core Node only.
3. **Credential safety.** Every string that can carry upstream text passes `redact()` in
   `lib/errors.js` (the single choke point, 600-char single-line cap). No key, and no
   upstream secret, may appear in `msg.hermes`, node status, logs, tests or commits.
4. **Transport limits preserved.** 2 MiB request / 8 MiB response caps, no-redirect,
   header allowlist (`Idempotency-Key`, `X-Hermes-Session-Id`, `X-Hermes-Session-Key`),
   bearer-only auth, stable idempotency key across admission retries.
5. **Queue guarantees preserved.** One active slot per queue config, FIFO, bounded
   `maxPending`, and the cancellation barrier: after an ordinary reset/cancel the slot stays
   reserved until remote termination is confirmed or the queue pauses as uncertain.
6. **Compatibility.** Existing outputs, lifecycle vocabulary, error codes and frozen test
   names stay. New behaviour is gated on explicit node configuration, and a missing/legacy
   configuration must never enable a new capability (fail closed).
7. **No claims the code cannot honour.** No durable queues, exactly-once delivery,
   persistent generated sessions, or automatic memory isolation.

## Scope decision table (from the evaluation)

| Capability | Decision | Owner |
| --- | --- | --- |
| Bounded async-admission backoff for HTTP 429 | **Adopt (A)** | this package |
| `GET /v1/capabilities` + `GET /health/detailed` probes | **Adopt (B)** | this package |
| Run-approval submission bridge | **Adopt (C)** | this package (decision made by the flow) |
| `provider` passthrough, `POST /v1/runs/{id}/steer` | Defer | upstream server |
| `resolve-unknown`, `/clarify` (`main` only, not in `v0.21.6`) | Defer | upstream server |
| Memory/vector store, tool nodes, orchestrator/chain discovery | Reject | Hermes server / flows |
| Durable journaling, exactly-once | Reject | out of scope |
| `node-red-node-test-helper` / sinon / mocha | Reject | repo uses `node:test` + real Node-RED 5 |

## Task 0 — upstream contract gate (blocking for B and C) — **DONE**

Pinned to Hermes Agent tag `v0.21.6`. Verified in source, not documentation. Recorded in
[docs/hermes-api-contract.md](../../hermes-api-contract.md) with synthetic fixtures in
`test/support/fixtures/`.

Gate answers:

* **Multi-pending approvals are not an obstacle.** The approval waiter is keyed by run id
  (`_RunLaunch.approval_session_key` returns `run_id`), and the agent thread blocks while a
  decision is pending, so an API-server run has exactly one pending approval. Status polling
  is sufficient; **no SSE is required** and the package must not claim otherwise.
* `session`/`always` persistence is server-side and profile-scoped; this package only relays
  the choice and must never claim to revoke it.
* Stale/duplicate `request_id` resolves to zero and the server answers **409
  `approval_not_pending`**; an unknown/inactive run gives **409 `approval_not_active`**.
* Polling exposes the **currently** pending decision only (the `approval` object is dropped
  as soon as status leaves `waiting_for_approval`), which is exactly the one that can be
  resolved. Documented as a bound.

If any later task needs a shape that is not in the contract note, **stop and raise it**
instead of guessing.

## Task 1 — Bounded backoff for admission retries

*Increment: PR A (`improve/async-admission-backoff`).*

New `lib/retry.js` exporting exactly:

```js
admissionRetryDelay({ baseMs, retryIndex, statusCode, remainingMs })
```

* `statusCode === 429`: `Math.min(baseMs * 2 ** retryIndex, Math.max(60000, baseMs), remainingMs)`
* any other status: `Math.min(baseMs, remainingMs)`
* `retryIndex` is **0-based** (first retry is 0). No jitter. `Retry-After` is deliberately
  **not** honoured yet — `v0.21.6` never sends it (scope choice, not a safety claim).
* The `Math.max(60000, baseMs)` ceiling keeps an explicit `retryDelay` above 60 s from being
  *shrunk* by backoff, so backoff never reduces an operator's intended wait.
* Result must be a non-negative integer, never negative, never above `remainingMs`.

Wire it into the admission loop in `lib/queue.js` (currently `await this.sleep(job,
this.retryDelayMs)` after a failed `client.start`). Poll retries keep the flat delay. Add the
delay to the `retrying` lifecycle event only as `delayMs` (additive field).

Default maths that tests must pin: with `retryDelayMs = 2000`, `startRetries = 2` the
scheduled waiting goes **4 s → 6 s** (2 s + 4 s) for pure 429. With `startRetries = 10` the
429 schedule is 2+4+8+16+32+60+60+60+60+60 s = **362 s** before request durations.

Also: `package.json → scripts.check:syntax` lists source files explicitly, so add
`lib/retry.js`.

Tests (`test/retry.test.js` new, plus `test/queue-modern.test.js` extension): pure-math
cases (429 vs other status, ceiling, `remainingMs` clamp, non-integer/NaN inputs, explicit
`retryDelay` above 60 s), and a queue-level test proving the second 429 waits longer than
the first while `test/queue-modern.test.js`'s existing 429 cancellation behaviour does **not**
regress.

## Task 2 — Server diagnostics: probes and the `probe` control action

*Increment: PR B (`feat/server-diagnostics`). The client transport work and the Control
surface are one reviewable unit: the projection is only testable through the action.*

### 2.1 Client probes

`lib/client.js`:

* `capabilities(options)` → `GET {base}/capabilities` (already under `/v1`).
* `healthDetailed(options)` → `GET {root}/health/detailed` where `root` is the endpoint base
  **minus** the trailing `/v1`, because that route is served at profile root, not under
  `/v1`. Derive `this.root` in the constructor from the same `endpoint()` result; do not
  re-parse user input.
* Project the machine-readable upstream error code: on a non-2xx response read
  `data.error.code` (envelope is `{error:{message,type,param,code}}`), validate it against
  `/^[a-z0-9_.-]{1,64}$/`, and set it as `errorCode` on the `HermesError`. Anything else is
  dropped. `lib/errors.js` gains `errorCode` in `HermesError` and `publicError` (validated
  again on the way out).

### 2.2 `probe` action on Hermes Control

* New Control action `probe` with `target` of `capabilities` | `readiness`.
* A queue config can be referenced by **multiple** connection configs, so the probe needs an
  explicit, trusted Connection. Add a `connection` field to `hermes-control` and, for
  `action: "probe"`, require it to resolve to a configured client. Never accept a URL or key
  from `msg`.
* Output 1 carries a **normalised, bounded** summary built by an allowlist projection (no
  free-form upstream object copy): for capabilities — `model`, `auth.type`,
  `auth.required`, `runtime.mode`, and booleans for the feature flags this package acts on,
  plus `features.run_approval_response` and the `run_approval` endpoint path. For readiness —
  `status`, `readiness.status`, `version`, `gateway_state`, `gateway_busy`, `active_agents`
  (booleans/ints/short strings only, each length- and range-clamped).
* Approval support is **disabled** when capabilities cannot be read, when
  `features.run_approval_response` is absent, or when the endpoints table lacks
  `run_approval` (a missing flag means "unsupported", never "assume supported").
* `msg.hermes.probe.stale` is informational only; a failed probe never pauses the queue.

## Task 3 — Approval plumbing: client method and approval-identity detection

*Increment: PR C (`feat/run-approval-control`), part 1 of 2. Deliberately split from the
Control surface: this task is the concurrency-sensitive half and needs its own review.*

### 3.1 Detect an approval decision that needs an answer

`lib/queue.js` polling already tolerates `waiting_for_approval`. Add change detection that
compares the **approval identity**, not just the status string: track the last
`approvalRequestId` and emit `waiting_for_approval` again when a *new* request id appears
while the status string is unchanged. Emit `approvalRequestId` (and, when a
`hermes-control` opts in, a preview) on the lifecycle event. Only the queue's own active
job's approval is ever surfaced.

### 3.2 Client method for an exact decision

* `HermesClient.approve(runId, { choice, requestId }, options)` → `POST
  /runs/{runId}/approval` with body `{ choice, request_id }`. `choice` must be one of
  `once|session|always|deny`; `request_id` is **required**.
* Validate locally before dispatch; never send a `request_id` derived from `msg` without the
  caller supplying it.

## Task 4 — Approval control surface, editor, docs and examples

*Increment: PR C, part 2 of 2.*

### 4.1 Control node `approve` action

* `hermes-control` gains `allowApprove` (default **false**), `approvalChoices` (the choices
  this node may ever send, default none) and optional `includeApprovalPreview` (default
  **false**). Approval requires **both** `msg.hermesControl.requestId` (the queue job) and
  `msg.hermesControl.approvalRequestId` (the server decision) — no "default to the active
  one" behaviour, so a late dashboard click cannot answer a newer decision.
* The chosen decision must be in `approvalChoices` **and** in the server-advertised
  `choices` for that pending request. Anything else fails with `OVERRIDE_DISABLED` /
  `INVALID_INPUT` and never reaches the network.
* The Control node resolves the Connection through the job's `connectionId` (the same client
  that was admitted), never from `msg`.
* A 2xx response does **not** free the queue slot. The run keeps polling until terminal, so a
  lost acknowledgement can neither replay an approval nor release the slot early. On a
  retryable failure the POST is **not** blindly replayed.

### 4.2 Editor, docs, examples

* **Carried from Task 1 (review finding, must not be dropped):** the `retryDelay` row in
  `docs/agent-integration.md` still reads "Delay between eligible retries", which the Task 1
  backoff made wrong. Rewrite it to state that it is the *base* delay, that HTTP 429 admission
  retries grow exponentially from it, that growth is capped at 60 s, and that every wait is
  clamped to the remaining run deadline. Document the additive `delayMs` field on the
  `retrying` lifecycle event wherever lifecycle fields are listed.
* `nodes/hermes.html`: `allowApprove`, `approvalChoices`, `includeApprovalPreview`,
  `connection`, `probe`/`target` fields with safe defaults, plus help text stating the
  approval round trip is a *separate* message and that only the currently pending decision
  can be answered.
* `README.md` + `docs/agent-integration.md` + `docs/adapter-contract.md` + `AGENTS.md`:
  retract "interactive approval submission not implemented", document the Control actions,
  the exact-decision rule, the per-run single-pending-decision bound, and that `session` /
  `always` authorizations persist **server-side** and are not revocable from Node-RED.
* `CHANGELOG.md` entry. No version bump or release claim.

## Review focus (tests required for each)

1. A stale dashboard response cannot approve a *newer* decision.
2. Upgrade/import/save of an existing flow never enables approvals (`allowApprove`
   defaults false; missing `approvalChoices` means none).
3. A lost acknowledgement cannot replay an approval or free the slot early.
4. A queue shared by two Connections cannot misroute a probe or an approval.
5. Consecutive approvals are observable even when the status string never changes.
6. Redaction and truncation still hold for an approval preview (opt-in, bounded, and
   credential-aware).
7. Backoff never breaks existing 429 cancellation or the cancellation barrier.

## Verification gates

Every task: `npm run check && npm test`.
Before finishing the branch, in a Node 24+ environment:

```
npm ci
npm run check
npm test
npm install --no-save --package-lock=false --ignore-scripts node-red@5
npm run test:integration
npm pack
```

Independent review by the reviewer agent (read-only, provided requirements + diff + real
verification output) before the draft PR. Fix actionable findings, re-run affected checks.

## Explicitly out of scope

Steering (`/steer`), `provider` passthrough, `resolve-unknown`/`clarify`, SSE consumption,
approval *review* UIs, durable queues, and any claim that a `session`/`always` grant can be
revoked from Node-RED.
