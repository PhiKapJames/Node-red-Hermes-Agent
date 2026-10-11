# Node-RED Hermes Agent

`node-red-contrib-hermes-agent` is a transport-independent Node-RED package for **Nous Research Hermes Agent**. It provides reusable profile connections, protected credentials, synchronous Chat Completions, asynchronous Runs, per-client conversations, and a shared FIFO scheduler.

It does **not** implement application-specific channel routing, sender formats, text-command detection, reply-length limits, sentence truncation, or delivery protocols. Put those policies in a separate upstream/downstream adapter.

## Nodes

| Node | Purpose |
| --- | --- |
| **Hermes Connection** (configuration) | Shared server URL, profile, API key/environment reference, and TLS settings. |
| **Hermes Queue** (configuration) | One active job and a bounded FIFO shared by all referencing nodes, even across flows/profiles. |
| **Hermes Prepare** | Optional generic property mapper for input, client ID, author, context and instructions. |
| **Hermes Agent** | Sync or async operation, with separate final-answer, lifecycle and error outputs. |
| **Hermes Control** | Status, pause, resume, clear, cancel, reset and uncertain-run recovery. |

```text
Application input -> application adapter -> [Prepare] -> Agent -> application output adapter
                                                        |  |  |
                                                        |  |  +-> errors
                                                        |  +----> lifecycle events
                                                        +-------> final answer
Application control adapter --------------------------> Control

Agent nodes reuse Connection credentials and a shared Queue.
```

## Install

This repository is an installable Node-RED npm package, **not flow JSON**. It is not automatically published to npm by this repository.

Install the supplied `.tgz` in the Node-RED user directory, then restart Node-RED:

```sh
cd ~/.node-red
npm install /path/to/node-red-contrib-hermes-agent-0.3.0.tgz
```

Or install the package directly from the GitHub repository:

```sh
npm install 'github:PhiKapJames/node-red-contrib-hermes-agent#main'
```

A deployment should pin a reviewed commit/tag rather than a moving branch. Node-RED editors with palette upload enabled can install the `.tgz` through the Palette Manager. A normal **Import** of flow JSON will not install this package.

For the Home Assistant Community Node-RED app, additional npm modules can be configured in its `npm_packages` list. Keep existing entries and add the reviewed GitHub package specification. Restart the app afterward. Runtime package installation is separate from importing the examples.

**Requirements:** Node-RED 5.0.0+ and Node.js 24.0.0+. Use a supported, patched Node.js release. The Hermes integration follows the v0.21.6 API contract and requires compatible server endpoints. The package has no runtime npm dependencies.

## Quick start

1. Add **Hermes Connection** with the server root, such as `http://127.0.0.1:8642`, and an optional profile. Enter that profile's `API_SERVER_KEY`. Do not enter the inference-provider or memory-service key.
2. Add one **Hermes Queue**. Reference it from every Agent node that must share a global processing limit.
3. Add **Hermes Agent**, choose the connection and queue, and select **Async** or **Sync**. Leave **Model override blank** to use the Hermes profile's default model.
4. Send a string in `msg.payload`. Wire output 1 to Debug first. Output 2 is lifecycle information; output 3 is error information, not a successful answer.
5. Import `examples/sync-and-async.json` for a disabled example using both modes and a shared queue. Configure the connection before enabling it.

## Generic input contract

A simple prompt needs only `msg.payload = "Hello"`. For richer requests, supply:

```js
msg.hermes = {
    input: "What should I do next?", // optional: otherwise uses Agent's input property
    clientId: "client-123",         // opaque ID chosen/validated by your application
    author: { id: "user-123", name: "Alex", is_bot: false },
    context: { locale: "en-US" },   // optional JSON context deliberately sent to the model
    instructions: "Use plain language."
};
return msg;
```

Optional fields:

| Field | Behavior |
| --- | --- |
| `input` | Nonempty string; overrides the configured input property. |
| `clientId` | Gives this client a stable generated conversation during this runtime. |
| `sessionId` | Explicit caller-managed transcript ID; used verbatim. |
| `sessionKey` | Optional stable `X-Hermes-Session-Key`, independent of the transcript ID. Honcho uses it for memory scoping: use a distinct key per client when separate scopes are intended; a shared key can share that scope. Other memory providers depend on their own configuration. |
| `author` | `{id, name, is_bot}`. Attribution only, not authentication. |
| `context` | JSON-serializable model-visible data, capped at 16 KiB. |
| `instructions` | Appended to the Agent node's configured instructions. |
| `history` | Optional explicit array of `{role, content}` text messages. Overrides server-history loading. |
| `mode` | `sync` or `async`; honored only when Agent mode is **From message**. |
| `model` | Per-message model override; accepted only when enabled in Agent settings. Async honors it. Sync also requires the Hermes server setting described below (unless selecting a server-defined model route). |

The optional Prepare node maps arbitrary message properties into this contract. Its optional **Author bot flag property** maps a boolean to `author.is_bot`; otherwise a previously supplied flag is preserved. Omitted flags default to false. String values such as `"false"` are rejected rather than coerced. There is no prescribed sender-ID format. Inputs, client context, and instructions are bounded and validated before queue admission.

By default, supplied author/context is included in the actual model input as labeled data. The Agent checkbox can disable this prompt injection while retaining API author attribution. Existing application routing properties on the Node-RED message are preserved, but are **not automatically sent to Hermes**.

Never map an entire credential-bearing message into `context`. The upstream adapter is responsible for deciding which metadata is appropriate to disclose.

## Outputs

**Agent output 1 — successful final answer**

```js
msg.payload = "The full, untruncated answer.";
msg.hermes = {
    status: "completed", mode: "async", requestId: "...", runId: "...",
    clientId: "client-123", sessionId: "...", durationMs: 1234,
    usage: { input_tokens: 20, output_tokens: 30 }, runtime: { model: "...", provider: "..." }
};
```

The module emits at most one successful final-answer message for a submitted job within a running process. It does not split, shorten or add punctuation to the answer. It does not copy API `reasoning_content`, raw headers, tool arguments or the connection's credential into output metadata.

**Output 2 — lifecycle events:** `queued`, `starting`, `accepted`, `running`, `retrying`, `waiting_for_approval`, `stopping`, `completed`, `cancelled`, `failed` or `uncertain`. Event fields are in `msg.hermes`; `msg.payload` is null. Polls only emit a normal state event when state changes.

**Output 3 — errors:** `msg.hermes.error` includes a stable `code`, sanitized `message`, `statusCode`, `retryable` and `remoteUnknown`. `msg.payload` is null. Errors are passed to Node-RED through `done(error)` and also trigger a scoped Catch node; handle either output 3 or Catch to avoid duplicate application error notifications.

Raw response bodies are intentionally not an output option. Error messages are bounded and redact the configured API key and recognizable bearer strings. This does not replace application-level protection against secrets appearing inside ordinary model-generated prose.

## Sync versus async

**Sync** makes one non-streaming `POST /v1/chat/completions`. Its HTTP request stays open until completion or the queue's run deadline. Node-RED remains nonblocking, but this request occupies the shared queue slot. Sync requests are not automatically retried because a lost HTTP response does not prove the agent failed to execute.

**Async** makes `POST /v1/runs` and then short `GET /v1/runs/{run_id}` calls. A stable per-job `Idempotency-Key` is reused for admission retries. The queue remains reserved until completion or confirmed cancellation. Async is the default.

### Sync model-override prerequisite

On Hermes v0.21.6, a bare `model` on `/v1/chat/completions` is ignored unless `gateway.platforms.api_server.direct_model_requests: true`, except when it selects a configured `model_routes` alias. `/v1/runs` honors a supplied model. The Agent's local override checkbox does not enable this server setting. Leave Model blank to keep using the profile default, or configure the server deliberately; the client does not add a provider or alter credentials.

`sessionKey` is forwarded as `X-Hermes-Session-Key`. Honcho uses it to maintain a stable memory scope independently of transcript resets. Two clients given the same key can share that scope; assign distinct application-managed keys when separation is intended. This header alone does not isolate a statically configured Hindsight bank and is not an authorization mechanism.

Model is omitted by default on both APIs. A profile name is not assumed to be a model ID. URL/profile and credentials are fixed by the shared Connection node; incoming `msg.url`, `msg.headers`, keys or provider names cannot redirect the connection.

## Queue and reset semantics

One Queue configuration is one global FIFO and one active job. Different clients keep different transcripts while being globally serialized. Separate Queue configurations create separate concurrency groups. The optional minimum start interval defaults to zero and applies globally within that queue. **Async HTTP wait** (`asyncRequestTimeout`) bounds individual admission/status requests; **Run deadline** bounds the overall job. The Connection timeout is the client default; Sync uses the run deadline.

Control messages go to a separate **Hermes Control** node:

```js
msg.hermesControl = { action: "reset" };
return msg;
```

Configure Control to **From message**, or select a fixed action and send any message. A phrase in a normal Agent prompt never triggers queue control.

- `status`: summary of active and queued jobs without prompt text or credentials.
- `pause` / `resume`: block or resume new admissions; the active run is not paused.
- `clear`: cancel waiting jobs without changing active work or sessions.
- `cancel`: cancel the active job, or `requestId` for a particular waiting/active job.
- `reset`: clear the global queue, rotate generated sessions for all clients, request active cancellation, and discard stale final responses.
- `recover`: attempt to confirm termination of a known but uncertain remote run.

A stop endpoint returning `stopping` is **not** proof of cancellation. The package polls for a terminal state within the cancellation grace period. If admission or cancellation remains uncertain, the queue pauses rather than launching overlapping work.

For deliberate emergency recovery, enable **Allow force** on Control and send `{action:"reset", force:true}`. This releases local tracking; **remote work may continue**. A late run ID is still stopped when obtainable and its final answer is discarded. Force reset is not a security boundary or a guarantee of remote cancellation.

Reset does not delete server transcripts, change a Hermes profile, or erase Hindsight memory. Explicit `sessionId` values belong to the caller and are not rewritten by reset. Generated client IDs/session attribution do not isolate a shared Hindsight bank.

## Credentials and security

The Connection's `apiKey` uses Node-RED's password-credential system, not an ordinary flow property. Standard editor exports contain a reference to the config node but not its key. Enter it once and reuse that config node across Agent nodes. Separate profiles should normally have separate Connection configs/keys.

The optional environment setting stores only a variable name in the exported flow. A saved credential takes precedence. Protect Node-RED's runtime credential store and backups with its normal `credentialSecret` / app credential-secret configuration. Export exclusion is not protection from someone who controls the runtime.

Use HTTPS on untrusted networks. TLS verification is enabled by default, with optional Node-RED TLS config for a private CA. Redirects are rejected rather than forwarding bearer credentials. The package is an authenticated API client, not a sandbox for Hermes tools; tool permissions remain a Hermes-side responsibility. Author/client labels and input instructions are not authorization.

## Runtime design

The client uses native Node.js `http`/`https` with per-connection pooling and support for Node-RED TLS settings, including custom certificate authorities and client certificates. Request bodies are limited to 2 MiB, responses to 8 MiB, and redirects are rejected to protect bearer credentials.

HTTP responses use asynchronous stream iteration. `AbortSignal.any()` and `AbortSignal.timeout()` coordinate request deadlines, cancellation, and connection shutdown. Queue delays use `node:timers/promises`, and Node-RED 5 message and close callbacks handle the node lifecycle.

## Known limitations

**Queues and pending-job tracking are in memory.** A Node-RED restart or deployment that recreates these nodes does not resume polling or replay waiting jobs. Shutdown requests cancellation where possible, but a lost connection can leave remote work executing. Generated conversations start fresh after restart to avoid resurrecting a pre-reset session; applications requiring continuity must persist and supply their own `sessionId`.

There is no exactly-once delivery guarantee across process crashes. Durable job journaling, output acknowledgements, streaming SSE subscriptions and interactive approval submission are not implemented. Approval waits are surfaced as lifecycle events and remain active until resolved elsewhere, cancelled, or timed out. Model routing, web tools, skills, and long-term memory configuration are managed by the Hermes server.

## Develop and test

Development and deployment require Node.js 24+. Use `nvm use` with the supplied `.nvmrc`, and keep the selected 24.x release patched. The installed package has no runtime lint dependency.

```sh
npm ci
npm run check
npm test
npm pack
```

The fast suite uses Node's built-in test runner and localhost HTTP fixtures. `npm run check` includes syntax checks and ESLint for runtime code, tests, and the editor script embedded in `nodes/hermes.html`. ESLint is development-only; the package still has no runtime npm dependencies. For actual Node-RED runtime integration tests:

```sh
npm install --no-save --package-lock=false --ignore-scripts node-red@5
npm run test:integration
```

CI tests Node.js 24.0.0, current Node.js 24.x, and Node.js 26 with Node-RED 5. Integration tests start isolated Node-RED processes with temporary user directories and a mock Hermes server, exercising Catch and Complete nodes, credentials, sessions, errors, and shutdown. Deprecation warnings fail the tests. CI tests do not replace validation against your own Hermes deployment. The package ships no credentials, application-specific adapters, or runtime npm dependencies.

## References

- [Node-RED 5 and Node.js requirements](https://nodered.org/blog/2026/06/09/version-5-0-released)
- [Node-RED credentials](https://nodered.org/docs/creating-nodes/credentials)
- [Node-RED shared configuration nodes](https://nodered.org/docs/creating-nodes/config-nodes)
- [Hermes API contract (v0.21.6)](https://github.com/NousResearch/hermes-agent/blob/v0.21.6/website/docs/user-guide/features/api-server.md)
- [Home Assistant Community Node-RED app configuration](https://github.com/hassio-addons/repository/blob/master/node-red/DOCS.md)

MIT licensed. Independent integration; not an official Nous Research or Node-RED package.
