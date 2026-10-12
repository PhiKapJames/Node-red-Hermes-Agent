# Integration runbook for coding agents

This guide describes how to install **`node-red-contrib-hermes-agent`** into Node-RED and build a working, transport-neutral application flow. Follow [../AGENTS.md](../AGENTS.md) for contributor safety rules, [../README.md](../README.md) for the human overview, and [../examples/sync-and-async.json](../examples/sync-and-async.json) for **importable flow JSON**.

The code that defines the authoritative contract is `nodes/hermes.js`, `nodes/hermes.html`, `lib/request.js`, `lib/client.js` and `lib/queue.js`. If behavior changes, update this document alongside the code.

## 1. Prerequisites, installation and discovery

- **Node.js 24.0.0+; Node-RED 5.0.0+.** Use a patched, supported Node.js release.
- A running Hermes Agent API server reachable from the **Node-RED runtime**, not just the editor/browser, with its profile-specific `API_SERVER_KEY`.
- Know whether the Node-RED runtime is a host process, container or supported add-on. `127.0.0.1` inside a container is that **container**, not its Docker host.
- Install `node-red-contrib-hermes-agent` in the Node-RED user directory or use the environment's supported Palette Manager/add-on package configuration, then restart Node-RED. Installing modules on an unrelated terminal/host does not install them in the running editor.

One option for a self-managed Node-RED installation:

~~~sh
cd ~/.node-red
npm install 'github:PhiKapJames/node-red-contrib-hermes-agent#main'
~~~

For repeatable deployments, pin a reviewed commit or tag rather than a moving `main` branch. The repo currently supplies source and CI-produced npm archives; importing flow JSON is **not** a package installation. For the Home Assistant Community Node-RED app, configure its supported `npm_packages` and restart the app; preserve other packages.

Confirm the Node-RED palette contains **Hermes Prepare**, **Hermes Agent**, and **Hermes Control**; **Hermes Connection** and **Hermes Queue** appear as *configuration nodes* when referenced by an Agent/Control node.

## 2. Architecture and node wiring

~~~text
Authenticated application source
  -> application input adapter (validate, dedupe, choose client identity)
  -> [Hermes Prepare: optional mapping]
  -> Hermes Agent [Hermes Connection + Hermes Queue configurations]
       output 1 (final answer) -> application output adapter -> destination
       output 2 (lifecycle)   -> diagnostics/metrics only
       output 3 (error)       -> safe error policy / diagnostics

Authorized application control source
  -> command whitelist / authorization adapter
  -> Hermes Control [same Hermes Queue]
       output 1 -> control result / monitoring
       output 2 -> control error / monitoring
~~~

Node types in serialized flows are **`hermes-connection`**, **`hermes-queue`**, **`hermes-prepare`**, **`hermes-agent`** and **`hermes-control`**. Set a valid `z` tab ID and `x`/`y` coordinates on visual nodes. Config nodes are referenced by their `id`. A config node shared between Agent instances shares state as described below.

### Connection configuration

A representative export-safe connection config (NOT a secret):

~~~json
{
  "id": "example-hermes-connection",
  "type": "hermes-connection",
  "name": "Hermes application profile",
  "baseUrl": "http://hermes-host:8642",
  "profile": "",
  "apiKeyEnv": "HERMES_NODE_RED_API_KEY",
  "requestTimeout": 30
}
~~~

- `baseUrl` accepts HTTP(S) origin and, where applicable, a reverse-proxy base path. A trailing `/v1` is accepted. **Do not put `/p/name` in this URL.**
- Blank `profile` targets `/v1`; profile `work` targets `/p/work/v1`. The profile name is **not** a model ID.
- Set the server API key through the **Node-RED password credential** `apiKey`. Alternatively, set `apiKeyEnv` to the **name** of an environment variable containing that key in the *running Node-RED process*; this is not the API key's value. An entered credential takes precedence over the environment variable. The example requires the environment variable to be populated; it is not an immediately authenticated connection.
- Use the Hermes **API-server key**, not a LiteLLM inference-provider key or memory-provider key.
- `tls` may reference a configured Node-RED TLS node. Do not disable certificate verification for convenience.
- `requestTimeout` defaults to **30 seconds** and is the connection's per-request default; the Queue and synchronous job deadlines have their own settings.

### Queue configuration

~~~json
{
  "id": "example-hermes-queue",
  "type": "hermes-queue",
  "name": "Shared application FIFO",
  "maxPending": 10,
  "cooldown": 0,
  "pollInterval": 5,
  "jobTimeout": 1200,
  "asyncRequestTimeout": 30,
  "stopTimeout": 30,
  "retryDelay": 2,
  "startRetries": 2
}
~~~

All numeric values above are **seconds** except `maxPending` and `startRetries` (counts). Defaults/ranges are defined by the editor (`nodes/hermes.html`) and validated at runtime (`nodes/hermes.js`):

| Field | Default | Meaning |
| --- | ---: | --- |
| `maxPending` | 10 | Waiting-job capacity; does not include the active job |
| `cooldown` | 0 s | Minimum interval between job starts |
| `pollInterval` | 5 s | Async run-status poll interval |
| `jobTimeout` | 1200 s | Total time budget for a job |
| `asyncRequestTimeout` | 30 s | Single async HTTP admission/poll request limit |
| `stopTimeout` | 30 s | Grace for confirming remote cancellation |
| `retryDelay` | 2 s | Delay between eligible retries |
| `startRetries` | 2 | Maximum admission retries |

**One queue config ID** means one active Hermes job plus a bounded FIFO across every Agent node that references it, even across tabs and Hermes profiles. Two queue configs allow independent active work. A queue is **in memory** and is **not** durable across Node-RED restart/redeployment.

### Agent configuration and ports

~~~json
{
  "id": "example-hermes-agent",
  "type": "hermes-agent",
  "z": "your-tab-id",
  "name": "Hermes requests",
  "connection": "example-hermes-connection",
  "queue": "example-hermes-queue",
  "mode": "async",
  "inputProperty": "payload",
  "model": "",
  "instructions": "",
  "includeContext": true,
  "allowModelOverride": false,
  "x": 550,
  "y": 160,
  "wires": [ ["success-node-id"], ["lifecycle-node-id"], ["error-node-id"] ]
}
~~~

The three `wires` arrays are in **exact port order**: complete final answer; lifecycle events; errors. `mode` can be `async`, `sync`, or `message` (per-request `msg.hermes.mode`). When a fixed mode is configured, incoming `msg.hermes.mode` does **not** switch it. Async is the default.

Do not create a model name from the profile: leave `model` empty to let Hermes choose its configured model. `allowModelOverride` applies only to incoming `msg.hermes.model`. On the Hermes v0.21.6 contract, direct sync model overrides also require `gateway.platforms.api_server.direct_model_requests: true` on the server or an appropriate configured model route. Async Runs honors an explicit model.

## 3. Input contract: an application adapter produces the prompt

For a simple request, `msg.payload = "Hello"` works. For a real application, produce a curated `msg.hermes` object:

~~~js
// Upstream Function node, AFTER authenticating the application client.
// application.* names are illustrative; map from your actual input.
const app = msg.application;
if (!app || typeof app.text !== "string" || !app.text.trim()) return null;
if (typeof app.authenticatedClientId !== "string" || !app.authenticatedClientId) return null;

msg.hermes = {
    input: app.text,
    clientId: app.authenticatedClientId,
    author: {
        id: app.authenticatedClientId,
        name: typeof app.displayName === "string" ? app.displayName : "User",
        is_bot: false
    },
    instructions: "Reply clearly and use plain text."
};

// Keep transport/destination data in msg.application or msg.route;
// the Agent preserves unrelated fields without sending them automatically.
return msg;
~~~

Never treat the label `authenticatedClientId` as authentication by itself: the adapter must validate it using that application's real trust boundary. Duplicate-message suppression, slash-command parsing, destinations, output limits, and sender-name normalization belong here or downstream.

**Optional** `hermes-prepare`: instead of a Function, set `inputProperty: "payload.text"`, `clientProperty: "payload.userId"`, and author/context/instructions property paths as appropriate. The Prepare node **requires its mapped input property to contain a nonempty string** and maps it to `msg.hermes.input`, replacing any earlier `msg.hermes.input`. It preserves unrelated input properties and existing author fields unless mapped over them. If mapping an author bot flag, supply a real **boolean**, not the strings `"true"`/`"false"`.

The Agent validates these fields in `lib/request.js`:

| `msg.hermes` property | Contract |
| --- | --- |
| `input` | Optional override of configured input property; nonempty UTF-8 string, up to 1 MiB |
| `clientId` | Optional stable, application-assigned identity; string, max 256 UTF-8 bytes |
| `sessionId` | Optional explicit transcript ID; printable ASCII without spaces, max 200 bytes |
| `sessionKey` | Optional explicit header for memory scoping; printable ASCII without spaces, max 256 bytes |
| `author` | Optional object: at least `id` or `name`, each at most 200 bytes; `is_bot` boolean |
| `context` | Optional JSON-serializable context, up to 16 KiB |
| `instructions` | Optional plain text, maximum 32768 UTF-8 bytes; appended to node instructions |
| `history` | Optional explicit array of up to 2000 `{role,content}` text turns; roles `user`/`assistant`/`system`; total JSON capped at 1 MiB |
| `mode` | `sync`/`async` only when Agent setting `mode` is `message` |
| `model` | Optional per-message model; requires Agent `allowModelOverride: true`, plus the sync server prerequisite above |

Prompt context is **model-visible** when `includeContext: true`, including author data. Restrict it to the minimum intentionally disclosed fields; do not copy the original request wholesale or include secrets.

## 4. Session identities and memory are separate concepts

- With `clientId` and no explicit `sessionId`, the package generates a transcript ID derived from **queue config, connection config, client ID, and a runtime epoch**. Reuse the same IDs and config references for continuity within that Node-RED process.
- Without `clientId` or `sessionId`, each request gets a fresh generated transcript session.
- With explicit `sessionId`, the caller owns its continuity across restart. It is used as given and **is not rotated by reset**. Protect this ID from cross-user collisions.
- Ordinary queue `reset` rotates generated sessions for clients referencing that queue; it does **not** delete server transcripts or Hindsight memory.
- `sessionKey` is forwarded as `X-Hermes-Session-Key`. Honcho uses it for persistent memory scoping independent of transcript IDs. Two clients sharing the same key may share that scope; choose distinct application-managed keys when needed. A statically configured Hindsight bank is **not automatically partitioned** by this header.
- Neither `author.id` nor `clientId` nor `sessionKey` is authentication or permission to use Hermes tools.

## 5. Sync/async behavior and correct outputs

| Mode | Hermes API | Practical consequence |
| --- | --- | --- |
| `sync` | `POST /v1/chat/completions` | Non-streaming HTTP request holds the shared queue slot until response/deadline; no automatic replay |
| `async` | `POST /v1/runs`, `GET /v1/runs/{id}`, `POST /v1/runs/{id}/stop` | Idempotency key is stable across admission retries, poll until terminal; reserve queue until completion or confirmed stop |

All paths are beneath the configured `/v1` or `/p/<profile>/v1` prefix. The module does not start a separate Node-RED flow for every polling step.

**Agent outputs:**

| Port | `msg.payload` | `msg.hermes` | Delivery handling |
| --- | --- | --- | --- |
| **1** | Complete string answer | `status: "completed"`; `requestId`, `mode`, optional `runId`, `sessionId`, `clientId`, `durationMs`, `usage`, `runtime` | Send to destination formatter |
| **2** | `null` | Lifecycle statuses such as `queued`, `starting`, `accepted`, `running`, `retrying`, `waiting_for_approval`, `stopping`, `completed`, `cancelled`, `failed`, `uncertain` | Log/monitor; **never** send as a second answer |
| **3** | `null` | `status`, `requestId`, `error: {code,message,statusCode,retryable,remoteUnknown}` | Error policy; do not treat as success |

Unrelated routing properties on the input `msg` are retained in these outputs. The error is additionally reported to a scoped Node-RED **Catch** through `done(error)`; choose **one user-facing error-delivery path** rather than double-notifying from output 3 and Catch.

The library returns complete model text and does **not** implement length restrictions, sentence trimming, splitting or destination delivery. Downstream applications must verify their own size/format constraints, decide whether a complete answer fits, and apply a clear fallback when it does not.

## 6. Control messages, safety and recovery

Choose a fixed `hermes-control` action in its node configuration, or choose `action: "message"` to read `msg.hermesControl.action`. Dynamic actions must be authorized and whitelisted upstream.

~~~js
// After application-specific authorization:
msg.hermesControl = { action: "status" };
return msg;
~~~

For a queue reset:

~~~js
msg.hermesControl = { action: "reset" };
return msg;
~~~

Supported actions: `status`, `pause`, `resume`, `clear`, `cancel`, `reset`, `recover`. `cancel` optionally accepts `requestId` for a queued/active job. Force is only available if the Control node has `allowForce: true` and `msg.hermesControl.force === true`. Prefer to keep that setting disabled.

- `pause` blocks new starts but does not interrupt active work; `resume` refuses a queue that still has uncertain remote work.
- `clear` cancels waiting jobs only.
- `reset` clears pending work, rotates generated client sessions and requests cancellation of the active run. A normal reset **keeps the active slot** until remote termination is verified or the queue stops as uncertain.
- `recover` attempts to confirm remote termination for a known uncertain run. An unknown run ID may require an operator to inspect Hermes outside Node-RED.
- Force reset abandons local tracking and can permit overlapping remote work. Do not present it as confirmation of cancellation.

**Control outputs:** port 1 has the action result in `msg.payload` and `msg.hermesControl = {action,ok:true}`; port 2 contains an error in `msg.hermesControl.error` with `msg.payload: null`. A scoped Catch also sees control failures.

The queue's `status` snapshot provides `paused`, `closed`, `pending` (count), `active` (summary/null), `uncertain` (summary/null), `queued` (summaries), and `cooldownRemainingMs`. It intentionally excludes prompts and secrets. A retained uncertain job is reported as `uncertain.status: "uncertain"` for as long as the queue holds it, even though output 2 already emitted its terminal `failed` lifecycle event; a successful `recover` (or an explicit force reset) returns `uncertain: null`.

## 7. Security, limitations and failure diagnosis

- Never put raw API keys, passwords, cookies, access tokens, tool secrets or full inbound event objects in `msg.hermes.context`. Credentials are stored in Node-RED's protected credential store or environment variables.
- If an app sends text that looks like `/reset`, it stays **user text** unless your *authorized* upstream adapter explicitly routes that text to a Control node.
- Dynamic `msg.url`/`msg.headers`/`msg.apiKey` are not recognized as Hermes Connection overrides. Treat the server URL and profile as trusted configuration, not per-message parameters.
- Confirm the Hermes API server is reachable **from Node-RED** and is serving the chosen profile. A failing browser request from your laptop is not equivalent to Node-RED container connectivity.
- HTTP redirects are rejected rather than forwarding bearer credentials. Input requests over 2 MiB and responses over 8 MiB fail. TLS certificate validation is enabled unless a trusted custom Node-RED TLS configuration is supplied.
- Reported error text is redacted and every CR/LF run is collapsed to one space. An upstream error body therefore cannot forge additional CR/LF-delimited Node-RED log entries, and `msg.hermes.error.message` contains no CR or LF. Collapse happens after redaction and before the length cap, so neither can re-expose what redaction removed.
- Queued jobs and tracking are **in memory**. Restart, redeploy, crash or network partition can lose tracking even if remote work continues; do not promise exactly-once work or response delivery.
- Interactive approval submission, durable journaling, SSE streaming subscriptions, Hermes model-provider routing, tool permissions and memory-provider configuration are **not implemented by this package**.

| Symptom / code | Check or response |
| --- | --- |
| Missing Hermes nodes in palette | Confirm package installed in the active Node-RED runtime; restart; check module startup errors |
| `MISSING_CREDENTIAL` / 401 / 403 | Check saved Connection password or `apiKeyEnv` in runtime, matching Hermes profile and server API-server key |
| 404 from Hermes | Verify base URL, reverse-proxy path, profile and Hermes API version; no duplicate `/p/name` or `/v1` |
| `INVALID_INPUT` | Confirm prompt is text, property path is correct, mapped bot flag is boolean and size/JSON limits are satisfied |
| `OVERRIDE_DISABLED` | Per-message model override is disabled; remove `msg.hermes.model` or explicitly enable and validate it |
| `QUEUE_FULL` | Shared queue waiting capacity reached; application should retry later or apply backpressure |
| `HTTP_TIMEOUT` / `NETWORK` | Verify connectivity, configured deadlines and server state; an async admission may have started remotely |
| `QUEUE_UNCERTAIN` | Stop accepting new work, inspect Hermes run state, use `recover` if safe; avoid indiscriminate force reset |
| No destination reply but lifecycle arrives | Wire only Agent output 1 to final delivery; lifecycle output is not the reply |
| Two error notifications | Output 3 and scoped Catch both fire; keep only one destination-error path |
| Context disappears between turns | Check same `clientId`, Queue and Connection references and process epoch; explicit `sessionId` if persistence is needed |
| Answer exceeds destination capacity | Apply downstream formatting/fallback; never infer a global reply-size guarantee |

## 8. Acceptance checklist for autonomous integration

- [ ] Node.js 24+ and Node-RED 5+ confirmed on the target runtime.
- [ ] Package installed and five node types discoverable; configuration nodes created/reused.
- [ ] Hermes URL/profile and TLS resolved without guessing; API credential configured outside exported JSON.
- [ ] Queue shared intentionally; limits and deadlines chosen for the use case.
- [ ] Upstream application identity/authentication, input validation, deduplication and optional Prepare mapping implemented.
- [ ] Agent output 1 reaches the destination formatter; outputs 2 and 3 have separate monitoring/error handling.
- [ ] Session continuity checked with repeated authenticated client ID and isolation checked with a second client.
- [ ] Async and sync happy paths tested against a reachable Hermes endpoint (if authorized).
- [ ] Authorization for Control actions enforced; cancellation/reset tested without force.
- [ ] Empty/invalid prompts, credential failure, queue overflow, run timeout and uncertain work produce safe outcomes.
- [ ] No secrets in exports, git history or logged model-visible context.
- [ ] State explicitly whether tests used a real Hermes server, a mock, or a static code review. Do not call a mocked response a live integration test.

## 9. Maintenance and source map

| Path | Purpose |
| --- | --- |
| `AGENTS.md` | Entry point for agents working with this repository |
| `README.md` | Human installation/feature/security overview |
| `docs/adapter-contract.md` | Generic adapter boundary |
| `examples/sync-and-async.json` | Disabled, importable async/sync example with shared Queue and Control |
| `nodes/hermes.html` | Actual Node-RED editor defaults, settings, help and port labels |
| `nodes/hermes.js` | Runtime wiring, credentials, message cloning and `done(error)` |
| `lib/request.js` | Validated request shape, generated sessions, model/author/context handling |
| `lib/client.js` | API URLs, HTTP(S), TLS, timeout/abort, body limits and credential safety |
| `lib/queue.js` | Global FIFO-per-queue, idempotent admission, cancellation and recovery |
| `test/` | Unit and actual Node-RED 5 process integration tests |
| `.github/workflows/test.yml` | CI across supported Node.js and Node-RED runtime combinations |

For contribution-level validation on Node.js 24+:

~~~sh
npm ci
npm run check
npm test
npm install --no-save --package-lock=false --ignore-scripts node-red@5
npm run test:integration
npm pack
~~~

A successful build or CI run validates package behavior against fixtures. It does **not** install this package into someone's Node-RED instance, supply a Hermes key or prove their application delivery path works.
