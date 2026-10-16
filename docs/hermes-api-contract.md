# Hermes Agent API server — verified contract notes

These notes record what `node-red-contrib-hermes-agent` relies on from the Hermes Agent API
server, **verified in server source** rather than inferred from prose documentation. They
exist so adapter behaviour can be reasoned about without re-reading the server.

Nothing here authorizes a request: the server still authenticates every call with the
profile-authorized API-server key.

## Provenance

| Item | Value |
| --- | --- |
| Project | `NousResearch/hermes-agent` |
| Ref | tag `v0.21.6` |
| Files read | `gateway/platforms/api_server.py`, `gateway/platforms/api_server_runs.py`, `tools/approval.py`, `tools/approval_gateway_wait.py` |
| Verified | 2026-10-15 |

Line numbers are from that tag and are given as evidence, not as an API. `main` diverges: it
adds `POST /v1/runs/{run_id}/resolve-unknown` and `/clarify`, which are **not** part of the
contract this package targets.

## URL construction

`endpoint()` in `lib/client.js` normalizes the configured base URL plus optional profile to a
`…​/v1` (or `…​/p/<profile>/v1`) prefix. Two probe routes differ in scope:

| Route | Resolved against |
| --- | --- |
| `GET /v1/capabilities` | the `/v1` prefix |
| `GET /health/detailed` | the **profile root**, i.e. the prefix with the trailing `/v1` removed |

Both require the bearer key (`@_require_auth` on `_handle_capabilities` and
`_handle_health_detailed`). `GET /health` is unauthenticated but carries no readiness data.

## `GET /v1/capabilities` (`api_server.py:2512`)

```jsonc
{
  "object": "hermes.api_server.capabilities",
  "platform": "hermes-agent",
  "model": "<resolved model id>",
  "auth": { "type": "bearer", "required": true },
  "runtime": { "mode": "server_agent", "tool_execution": "server", "split_runtime": false, "description": "…" },
  "features": { /* static flags + runs_idempotency + cors + browser_extension_control */ },
  "endpoints": { "<name>": { "method": "GET", "path": "/…" } }
}
```

Relevant static flags (`_STATIC_FEATURE_FLAGS`, `api_server.py:68`), order is part of the wire
shape: `run_status`, `run_events_sse`, `run_stop`, `run_steer`, **`run_approval_response`**,
`tool_progress_events`, `approval_events`, `session_resources`, `model_options`,
`session_chat`, `session_chat_streaming`, `session_fork`, `session_model_lock`,
`reasoning_streaming`, plus the `session_continuity_header` / `session_key_header` names.

**The flag and the endpoint key are not spelled the same.** Feature detection must read
`features.run_approval_response`; the endpoints table key is `run_approval`
(`_CAPABILITY_ENDPOINTS`, `api_server.py:86` → `POST /v1/runs/{run_id}/approval`).
`health_detailed` is advertised as `GET /health/detailed`.

A missing flag or endpoint entry means **unsupported**. Never treat absence as supported.

## `GET /health/detailed` (`api_server.py:2430`)

Top-level keys: `status`, `readiness` (object), `platform`, `version`, `gateway_state`,
`platforms` (map), `api_server` (metrics), `metrics_today`, `last_heartbeat`,
`active_agents`, `gateway_busy`, `gateway_drainable`, `exit_reason`, `updated_at`
(RFC 3339 string or `null`, never a number), `pid`.

The payload embeds per-platform maps and metrics. This package projects an **allowlist** of
bounded scalar fields instead of forwarding the object.

## Error envelope

Every error from these routes is OpenAI-style (`_openai_error`, `api_server.py:906`):

```jsonc
{ "error": { "message": "…", "type": "invalid_request_error", "param": null, "code": "approval_not_pending" } }
```

`lib/client.js` historically kept only `message`. It now also projects `error.code` as
`errorCode` after validating it against `/^[a-z0-9_.-]{1,64}$/`, because approval handling and
diagnostics need a machine-readable reason that survives redaction.

## Approvals

### How a pending decision is advertised

`_approval_notify` (`api_server_runs.py:850`, and the session-stream variant at
`api_server.py:3749`) does:

```python
self._set_run_status(run_id, "waiting_for_approval", last_event="approval.request", approval=event)
```

`_set_run_status` (`api_server_runs.py:258`) **pops `approval` whenever the status is not
`waiting_for_approval`** (line 270). So `GET /v1/runs/{run_id}` carries at most one approval
object, and only while it is pending. `GET /v1/runs/{run_id}` (`_handle_get_run`, line 1057)
returns that status object unfiltered.

`_approval_request_event` (`api_server.py:113`) builds the projection: the server's own
approval fields, with `command` **redacted before egress**, plus the `_run_event` envelope
(`{event, run_id, timestamp}`) and `choices`.

`choices` comes from `_approval_event_choices` (`api_server.py:107`) and is one of:

* `["once", "deny"]` — smart-denied guardian verdict, or `allow_session` is false
* `["once", "session", "deny"]`
* `["once", "session", "always", "deny"]`

An adapter must intersect these with its own policy and must never send a choice the server
did not advertise for *this* decision.

`request_id` originates in `tools/approval_gateway_wait.py:32`
(`self.data.setdefault("request_id", uuid.uuid4().hex)`) and is therefore a 32-character hex
string per decision.

### One pending decision per run

The approval waiter is keyed by **run id**, not by conversation:
`_RunLaunch.approval_session_key` returns `self.run_id` — "Isolated per run: session ids are
conversation scopes, not authorization namespaces" (`api_server_runs.py:506`). The agent
thread blocks until the decision resolves, so an API-server run cannot hold two concurrent
pending approvals. `resolve_gateway_approval`'s FIFO/`resolve_all` generality serves other
surfaces (CLI, shared session keys), not this one.

**Consequence:** status polling is a complete mechanism for this adapter. It is a genuine
bound, and it must be documented as such: only the currently pending decision for a run is
observable, and it is the only one the server will accept.

### `POST /v1/runs/{run_id}/approval` (`api_server_runs.py:1168`)

Request body:

| Field | Type | Notes |
| --- | --- | --- |
| `choice` | string | trimmed + lowercased, alias-mapped by `_APPROVAL_CHOICE_ALIASES`: `approve`/`approved`/`allow` → `once` |
| `request_id` | string, optional | invalid if present but empty or longer than 256 |
| `all` / `resolve_all` | bool | coerced; room grants may not use it |

Accepted `choice` values are `once`, `session`, `always`, `deny` — **except** when the request
carries a room-grant token, where they narrow to `once`/`deny` and `request_id` becomes
mandatory. This package authenticates with the API-server key and is never room-scoped, so it
sends the full set only when the operator allows it, and always sends `request_id`.

Success (`200`):

```jsonc
{ "object": "hermes.run.approval_response", "run_id": "…", "choice": "once",
  "request_id": "…", "resolved": 1 }
```

Server-side effects on success: `_mark_run_event(run_id, "approval.responded", …)` sets status
back to **`running`**, which also drops the `approval` object. A run may later return to
`waiting_for_approval` with a **new** `request_id`, so change detection must compare approval
identity rather than the status string alone.

Failure ladder:

| HTTP | `error.code` | Meaning |
| --- | --- | --- |
| 400 | `invalid_approval_request` | `request_id` present but empty or > 256 chars |
| 400 | `invalid_approval_choice` | choice not in the accepted set |
| 400 | `invalid_approval_scope` | room grant attempted `resolve_all` |
| 400 | `approval_request_required` | room grant without `request_id` |
| 409 | `approval_not_active` | run has no active approval session |
| 409 | `approval_not_pending` | nothing pending matched (stale or duplicate `request_id`) |
| 500 | — | approval core raised |

`resolve_gateway_approval` returns the number resolved, so a stale or replayed `request_id`
resolves zero and yields **409 `approval_not_pending`** rather than answering the wrong
decision. That is what makes exact-`request_id` targeting safe to automate.

`session` and `always` persist **server-side** (`tools/approval.py` keeps session-scoped and
permanent allowlists). This package relays the choice and cannot revoke it.

### Not implemented here

`POST /v1/runs/{run_id}/steer` (`run_not_accepting_steer` 409, `invalid_steer_input` 400,
`steer_not_accepted` 409) and `POST /v1/runs/{run_id}/stop` exist upstream but steering is not
exposed by this package. `GET /v1/runs/{run_id}/events` is SSE and is not consumed; this
adapter polls.

## Admission control and 429

Admission is `POST /v1/runs`, guarded by `_admit_api_agent_request`, which enforces
`max_concurrent_runs` (default 10) and answers **429** when the server is at capacity. The
`Retry-After` header appears **nowhere** in the pinned tag, so this package backs off on a
timer instead of honouring a server-provided delay, and should revisit only against a tag that
actually sends it.

## Fixtures

Synthetic, credential-free fixtures for the shapes above live in
`test/support/fixtures/` and are the inputs for the client/editor tests. They are modelled on
the verified field sets, never captured from a real deployment.
