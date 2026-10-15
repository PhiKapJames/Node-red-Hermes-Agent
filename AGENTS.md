# Agent guidance — node-red-contrib-hermes-agent

This file is for coding agents working in this repository **and** agents integrating the package into a Node-RED application. It is not a Hermes prompt or a replacement for application authorization.

**Read [docs/agent-integration.md](docs/agent-integration.md) before generating or modifying Node-RED flows.** The importable, disabled starter flow is [examples/sync-and-async.json](examples/sync-and-async.json). The human overview is [README.md](README.md); the transport/application boundary is [docs/adapter-contract.md](docs/adapter-contract.md).

## Scope and supported environment

- Package: `node-red-contrib-hermes-agent`; repository: `PhiKapJames/node-red-contrib-hermes-agent`.
- Requires **Node-RED 5.0.0+** and **Node.js 24.0.0+**. The package has no runtime npm dependencies.
- Connects to an existing Nous Research **Hermes Agent API server**, using its API-server key. This is not a direct LiteLLM or model-provider client.
- Five custom node types are registered by `nodes/hermes.js`: `hermes-connection`, `hermes-queue`, `hermes-prepare`, `hermes-agent`, and `hermes-control`.
- The package implements **both** non-streaming synchronous Chat Completions and asynchronous Runs/polling. It must remain **transport-neutral**.
- Installation is via the Node-RED npm user directory, Palette Manager, or a supported add-on package setting. **Importing flow JSON alone does not install a custom node package.**

## Non-negotiable integration rules

1. Keep transport/application-specific behavior **outside** this package: message recognition, sender authentication, deduplication, channel selection, destinations, rate limits imposed by another transport, output-size limits, formatting and delivery are upstream/downstream adapters.
2. Use shared **Hermes Connection** config nodes for server URL/profile/TLS and protected credentials. Store `apiKey` as a Node-RED password credential or store only its **environment variable name** in `apiKeyEnv`. Never place live keys in flow JSON, Function node bodies, `msg.payload`, `msg.hermes`, tests, or commits.
3. Use shared **Hermes Queue** config nodes for serialization. Every Agent node referencing the **same queue config ID** shares its single active slot and FIFO—even across tabs/profiles. Multiple queue configs are separate schedulers; don't describe them as one global queue.
4. Provide prompt text as `msg.payload` (string), a configured input property, or `msg.hermes.input`. Do not send entire untrusted HTTP/MQTT/application event objects as prompts.
5. Use validated, application-assigned `msg.hermes.clientId` for per-client generated conversations. A display name is not a secure identity. `sessionId` is a **caller-managed** transcript ID; `sessionKey` can establish a Honcho memory scope but does not partition a shared Hindsight bank or authenticate a sender.
6. Treat the Agent's **first output only** as a completed answer. Output 2 is lifecycle metadata (`payload: null`); output 3 is a sanitized error (`payload: null`). A scoped Catch also sees failures: avoid double-delivering errors from both Catch and output 3.
7. Keep queue control on a separate `hermes-control` node. Dynamic `msg.hermesControl.action` is enabled by the node setting `action: "message"`; **never** wire an untrusted input directly to that node. `probe` and `approve` are fixed-only and are never chosen by message. Prompts never implicitly execute reset.
8. Do not silently truncate or split the Hermes answer inside this module. Downstream adapters enforce any destination-specific limits, and must handle answers that do not fit.
9. Do not bypass the established cancellation barrier: after an ordinary reset/cancel, the active slot remains reserved until termination is confirmed or the queue pauses as uncertain. A force reset is explicit, opt-in and can leave remote work running.
10. Do not claim durable queues, exactly-once delivery, persistent generated sessions, automatic approval submission, or automatic Hindsight memory isolation. Tracking and pending jobs live in process memory. Approval **relay** exists (`approve`): it needs `allowApprove: true` plus explicit `approvalChoices`, addresses one decision by both IDs or fails locally, and never frees the queue slot. `session`/`always` grants persist server-side and are not revocable from Node-RED.

## Contract cheat sheet

| Component | Inputs or configuration | Outputs / role |
| --- | --- | --- |
| `hermes-connection` (config) | `baseUrl`, `profile`, `apiKeyEnv`, `tls`, `requestTimeout`; protected `apiKey` | Shared API client and credentials |
| `hermes-queue` (config) | `maxPending`, `cooldown`, `pollInterval`, `jobTimeout`, `asyncRequestTimeout`, `stopTimeout`, `retryDelay`, `startRetries`, `includeApprovalPreview` | One active job and bounded pending FIFO |
| `hermes-prepare` | Mapped input/client/author/context/instructions properties | One normal output; validation failures via `done(error)` / Catch |
| `hermes-agent` | `connection` ID, `queue` ID, `mode` (`async`, `sync` or `message`), `inputProperty`, `instructions`, `model`, `includeContext`, `allowModelOverride` | 1: final text; 2: lifecycle; 3: errors |
| `hermes-control` | `queue` ID, `action` (`status`, `pause`, `resume`, `clear`, `cancel`, `reset`, `recover`, `probe`, `approve` or `message`), `allowForce`, `connection` + `target` (probe), `allowApprove` + `approvalChoices` (approve) | 1: result; 2: error |

Full field validation, session rules, exact flow JSON, and operational runbook: [docs/agent-integration.md](docs/agent-integration.md).

## Workflow for an agent integrating this package

1. Verify Node-RED/Node.js versions and identify where Node-RED actually runs (host, container, or add-on).
2. Install the package in **that** Node-RED runtime and restart it; verify all five node types are registered.
3. Obtain the Hermes server base URL, optional named profile, a profile-authorized `API_SERVER_KEY`, TLS requirements and desired queue behavior. **Ask the owner** for missing sensitive configuration; never invent an endpoint, API key or profile.
4. Import the disabled example or build a small separate flow. Create/reuse one Connection and one Queue. Connect Agent output ports correctly and configure credentials through Node-RED.
5. Add an application-specific source adapter that authenticates clients and maps only the intended `msg.hermes` fields. Preserve routing metadata on unrelated `msg` properties.
6. Add a downstream destination formatter/delivery adapter. Route successful answers only from Agent output 1. Wire lifecycle and errors to separate monitoring.
7. If controls are required, authorize and whitelist control actions in a separate adapter; prefer fixed Control actions over dynamic actions for untrusted systems.
8. Test one sync and one async request, two distinct client IDs, an additional turn from an existing client, a queued second job, cancellation/reset behavior, an invalid prompt, and a deliberate HTTP error. Verify one application reply per successful result rather than one per lifecycle transition.
9. Report the actual status of **deployment, wiring, credentials, tests, and remaining limitations**. Never claim installation or live Hermes success from code review or mocks alone.

## Repository development rules

- Read `nodes/hermes.html` for editor property names/defaults and `nodes/hermes.js` for the actual Node-RED runtime contract. `lib/request.js` defines input and session semantics, `lib/client.js` defines secure HTTP transport, and `lib/queue.js` defines FIFO/cancellation semantics.
- Preserve bearer credential redaction, no-redirect behavior, protected TLS options, 2 MiB request and 8 MiB response limits, stable idempotency keys for async admission retries, and remote-unknown handling.
- Never add a transport-specific policy, a third-party service key, an LLM provider choice, or a Hermes profile setting as a package default.
- Add tests for behavior changes. Use `node:test` and **real Node-RED 5 process integration tests**, not `node-red-node-test-helper` or Sinon.
- Run `npm ci`, `npm run check`, `npm test`, `npm install --no-save --package-lock=false --ignore-scripts node-red@5`, `npm run test:integration`, and `npm pack` in a Node.js 24+ environment. CI also checks Node 24.0.0 and Node 26.
- Documentation and examples must be safe to export/commit: never include real credentials or service endpoints tied to one deployment. Confirm code and README/help stay in sync.
- Changes to package behavior belong in the appropriate source/tests, not merely in this document. Do not merge failing CI or use `npm audit fix --force` to mask upstream dependency findings.

**Key limitation:** The npm package is the adapter to an existing Hermes server. It does not install Hermes, configure LiteLLM/memory/tools, create sessions on disk, or automatically deploy flows to anyone's Node-RED instance.
