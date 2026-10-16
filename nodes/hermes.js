'use strict';

const { HermesClient } = require('../lib/client');
const { projectCapabilities, projectReadiness, approvalSupported } = require('../lib/diagnostics');
const { approvalSubmission } = require('../lib/approval');
const { HermesQueue } = require('../lib/queue');
const { prepareRequest, plainObject } = require('../lib/request');
const { HermesError, publicError } = require('../lib/errors');

// The only probe targets this package knows, each mapping to one fixed route in lib/client.js.
// A Set, not a lookup object, so an inherited property name (`toString`, `constructor`) is never
// a hit. Anything else, including a legacy or hand-edited flow property, is rejected instead of
// picking a route, so a probe can never become a general "call any endpoint" escape hatch.
const PROBE_TARGETS = new Set(['capabilities', 'readiness']);

function number(value, fallback, min, max, name) {
    const parsed = value === '' || value === undefined ? fallback : Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new HermesError('CONFIG', `${name} must be between ${min} and ${max}.`);
    return parsed;
}

module.exports = function(RED) {
    const clone = msg => RED.util.cloneMessage(msg);
    const property = (msg, path) => path ? RED.util.getMessageProperty(msg, path) : undefined;

    function Connection(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.readKey = () => node.credentials?.apiKey || (config.apiKeyEnv ? process.env[config.apiKeyEnv] : '') || '';
        try {
            if (config.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) throw new HermesError('CONFIG', 'API-key environment variable name is invalid.');
            const tlsOptions = {};
            if (config.tls) {
                const tls = RED.nodes.getNode(config.tls);
                if (!tls?.addTLSOptions) throw new HermesError('CONFIG', 'TLS configuration is unavailable.');
                tls.addTLSOptions(tlsOptions);
            }
            node.client = new HermesClient({
                baseUrl: config.baseUrl, profile: config.profile || '', getKey: node.readKey,
                requestTimeoutMs: Math.round(number(config.requestTimeout, 30, 1, 3600, 'HTTP timeout') * 1000), tlsOptions
            });
        } catch (error) {
            node.configError = publicError(error, [node.readKey()]);
            node.error(node.configError.message);
        }
        node.on('close', (_removed, done) => {
            try { node.client?.close(); }
            finally { done(); }
        });
    }
    RED.nodes.registerType('hermes-connection', Connection, { credentials: { apiKey: { type: 'password' } } });

    function Queue(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const ms = (value, fallback, min, max, name) => Math.round(number(value, fallback, min, max, name) * 1000);
        try {
            const maxPending = number(config.maxPending, 10, 0, 10000, 'Queue capacity');
            if (!Number.isInteger(maxPending)) throw new HermesError('CONFIG', 'Queue capacity must be an integer.');
            node.scheduler = new HermesQueue({
                id: node.id, clientFor: id => RED.nodes.getNode(id)?.client, maxPending,
                cooldownMs: ms(config.cooldown, 0, 0, 86400, 'Cooldown'),
                pollIntervalMs: ms(config.pollInterval, 5, 0.25, 300, 'Poll interval'),
                jobTimeoutMs: ms(config.jobTimeout, 1200, 1, 86400, 'Run deadline'),
                requestTimeoutMs: ms(config.asyncRequestTimeout, 30, 1, 3600, 'Async HTTP timeout'),
                stopTimeoutMs: ms(config.stopTimeout, 30, 1, 300, 'Cancellation grace'),
                retryDelayMs: ms(config.retryDelay, 2, 0.1, 300, 'Retry delay'),
                startRetries: Math.floor(number(config.startRetries, 2, 0, 10, 'Admission retries')),
                // Set by the Queue configuration alone; a message can never ask for approval text.
                includeApprovalPreview: config.includeApprovalPreview === true
            });
        } catch (error) { node.configError = publicError(error); node.error(node.configError.message); }
        node.on('close', async (_removed, done) => {
            try {
                if (node.scheduler?.active) node.warn('Queue is stopping with active work; remote cancellation is best effort. Pending requests are not persisted.');
                await node.scheduler?.close();
            } catch (error) { node.warn(`Hermes queue shutdown: ${publicError(error).message}`); }
            finally { done(); }
        });
    }
    RED.nodes.registerType('hermes-queue', Queue);

    function Prepare(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.on('input', (msg, send, done) => {
            let failure;
            try {
                if (msg.hermes !== undefined && !plainObject(msg.hermes)) throw new HermesError('INVALID_INPUT', 'Existing msg.hermes must be an object.');
                const options = { ...(msg.hermes || {}) };
                options.input = property(msg, config.inputProperty || 'payload');
                if (typeof options.input !== 'string' || !options.input.trim()) throw new HermesError('INVALID_INPUT', 'The mapped input property is not a nonempty string.');
                if (config.clientProperty) {
                    const value = property(msg, config.clientProperty);
                    if (typeof value !== 'string' && typeof value !== 'number') throw new HermesError('INVALID_INPUT', 'The mapped client ID is missing or not a string/number.');
                    options.clientId = String(value);
                }
                if (config.authorIdProperty || config.authorNameProperty || config.authorIsBotProperty) {
                    if (options.author !== undefined && !plainObject(options.author)) throw new HermesError('INVALID_INPUT', 'Existing author must be an object.');
                    const author = { ...(options.author || {}) };
                    if (config.authorIdProperty) author.id = property(msg, config.authorIdProperty);
                    if (config.authorNameProperty) author.name = property(msg, config.authorNameProperty);
                    if (config.authorIsBotProperty) {
                        const value = property(msg, config.authorIsBotProperty);
                        if (typeof value !== 'boolean') throw new HermesError('INVALID_INPUT', 'Mapped author bot flag must be a boolean.');
                        author.is_bot = value;
                    } else if (author.is_bot === undefined) author.is_bot = false;
                    options.author = author;
                }
                if (config.contextProperty) options.context = property(msg, config.contextProperty);
                const instructions = [config.instructions || '', property(msg, config.instructionsProperty) || ''];
                if (instructions.some(value => typeof value !== 'string')) throw new HermesError('INVALID_INPUT', 'Mapped instructions must be text.');
                if (instructions.some(Boolean)) options.instructions = instructions.filter(Boolean).join('\n\n');
                msg.hermes = options;
                node.status({ fill: 'green', shape: 'dot', text: 'prepared' });
                send(msg);
            } catch (error) {
                const safe = publicError(error);
                msg.payload = null;
                msg.hermes = { status: 'failed', error: safe };
                node.status({ fill: 'red', shape: 'ring', text: safe.code });
                failure = new HermesError(safe.code, safe.message, safe);
            } finally { done(failure); }
        });
    }
    RED.nodes.registerType('hermes-prepare', Prepare);

    function Agent(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const connection = RED.nodes.getNode(config.connection);
        const queue = RED.nodes.getNode(config.queue)?.scheduler;
        let closed = false;
        const progress = (job, event) => {
            if (closed || job.ownerId !== node.id) return;
            const output = clone(job.message);
            output.hermes = event;
            output.payload = null;
            node.send([null, output, null]);
            node.status({ fill: ['failed', 'uncertain'].includes(event.status) ? 'red' : 'blue', shape: 'ring', text: event.status });
        };
        queue?.on('progress', progress);
        if (!connection?.client || !queue) node.status({ fill: 'red', shape: 'ring', text: 'check configuration' });
        node.on('input', async (msg, send, done) => {
            let original;
            let requestId;
            let failure;
            try {
                if (closed) return;
                original = clone(msg);
                if (!connection?.client || !queue) throw new HermesError('CONFIG', 'Select a valid Hermes connection and shared queue.');
                if (!connection.readKey()) throw new HermesError('MISSING_CREDENTIAL', 'Set the API key on the shared Hermes connection.');
                const spec = prepareRequest(property(msg, config.inputProperty || 'payload'), msg.hermes || {}, {
                    mode: config.mode || 'async', instructions: config.instructions || '', model: config.model || '',
                    includeContext: config.includeContext !== false, allowModelOverride: config.allowModelOverride === true
                });
                const ticket = queue.enqueue({ ownerId: node.id, connectionId: config.connection, spec, message: original });
                requestId = ticket.requestId;
                const { output, ...metadata } = await ticket.finished;
                if (closed) return;
                const out = clone(original);
                out.payload = output;
                out.hermes = metadata;
                send([out, null, null]);
                node.status({ fill: 'green', shape: 'dot', text: 'completed' });
            } catch (error) {
                if (closed) return;
                const safe = publicError(error, [connection?.readKey?.() || '']);
                const out = clone(original || { _msgid: msg._msgid });
                out.payload = null;
                out.hermes = { requestId, status: safe.code === 'CANCELLED' ? 'cancelled' : 'failed', error: safe };
                send([null, null, out]);
                node.status({ fill: 'red', shape: 'ring', text: safe.code });
                // done(error) is correlated with the original input, not out.
                msg.payload = null;
                msg.hermes = out.hermes;
                failure = new HermesError(safe.code, safe.message, safe);
            } finally { done(failure); }
        });
        node.on('close', (_removed, done) => {
            try {
                closed = true;
                queue?.removeListener('progress', progress);
                queue?.cancelOwner(node.id);
            } finally { done(); }
        });
    }
    RED.nodes.registerType('hermes-agent', Agent);

    // Control actions that talk to Hermes resolve their client here and nowhere else. A probe uses
    // the Connection chosen on this node; an approval uses the Connection the job was actually
    // admitted on, because one Queue config can be referenced by several Connections and answering a
    // decision on somebody else's server is exactly the failure this prevents. Neither ever reads a
    // Connection out of the message, and an approval never reads one out of this node's own field.
    function trustedConnection(connectionId) {
        const connection = connectionId ? RED.nodes.getNode(connectionId) : null;
        // The editor restricts the field to a Hermes Connection; this is the runtime gate that
        // keeps a hand-edited flow from pointing an action at another node type's client. For an
        // approval the id comes from the queue's own job, which only this package ever wrote.
        if (!connection || connection.type !== 'hermes-connection' || !connection.client) {
            throw new HermesError('CONFIG', 'Select a valid Hermes connection for this action.');
        }
        return connection;
    }

    function Control(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const queue = RED.nodes.getNode(config.queue)?.scheduler;
        // A probe is only ever the node's own fixed action with a node-configured target and
        // Connection, so a message can neither select it nor choose a server. It is also the only
        // action that does not consult the queue scheduler at all.
        const probing = config.action === 'probe';
        // Answering a decision is likewise only ever the node's own fixed action: a message supplies
        // the two IDs that address one, never the permission to send one.
        const approving = config.action === 'approve';
        const probeTarget = probing && PROBE_TARGETS.has(config.target) ? config.target : undefined;
        // `msg.hermes.probe` is the machine-readable conclusion. A capabilities probe that did
        // not complete reports approval support as unsupported; readiness never claims it.
        const probeOutcome = (ok, data) => ({
            target: probeTarget,
            ok,
            stale: !ok,
            ...(probeTarget === 'capabilities' ? { approvalSupported: ok ? approvalSupported(data) : false } : {})
        });
        const callerRequest = message => (plainObject(message.hermes) ? message.hermes : {});
        let closed = false;
        node.on('input', async (msg, send, done) => {
            let failure;
            let secrets;
            try {
                if (closed) return;
                if (!queue) throw new HermesError('CONFIG', 'Select a shared Hermes queue.');
                const options = msg.hermesControl || {};
                if (!plainObject(options)) throw new HermesError('INVALID_INPUT', 'hermesControl must be an object.');
                const action = config.action === 'message' ? options.action : config.action || 'status';
                // `force` is the reset action's override and nothing else: it is consulted for that
                // action alone, so a stray `force: true` on a dashboard button is neither rejected as
                // though it had attempted a reset nor allowed to become an override for anything else.
                const force = action === 'reset' && options.force === true;
                if (force && config.allowForce !== true) throw new HermesError('OVERRIDE_DISABLED', 'Force reset is not enabled on this Control node.');
                if (probing) {
                    // Fail closed before any network call: an unknown target never picks a route.
                    if (!probeTarget) throw new HermesError('CONFIG', 'Choose a probe target: capabilities or readiness.');
                    const connection = trustedConnection(config.connection);
                    secrets = [connection.readKey?.() || ''];
                    const data = probeTarget === 'capabilities'
                        ? await connection.client.capabilities()
                        : await connection.client.healthDetailed();
                    if (closed) return;
                    const out = clone(msg);
                    // The projection is the only place an upstream diagnostic becomes a message, so
                    // this node's own key is named as a secret before any of it is summarised.
                    const summary = probeTarget === 'capabilities'
                        ? projectCapabilities(data, { secrets })
                        : projectReadiness(data, { secrets });
                    out.payload = summary;
                    out.hermes = { ...callerRequest(out), probe: probeOutcome(true, data) };
                    out.hermesControl = { action: 'probe', ok: true, target: probeTarget };
                    node.status({ fill: 'green', shape: 'dot', text: `probed ${probeTarget}` });
                    send([out, null]);
                    return;
                }
                if (approving) {
                    // Every rule about which decision may be answered, and with what, is decided in
                    // lib/approval.js before a client is resolved at all: a refusal cannot reach the
                    // network, and nothing that was refused is echoed into a message or a status.
                    const target = approvalSubmission({
                        allowApprove: config.allowApprove,
                        choices: config.approvalChoices,
                        control: options,
                        job: queue.activeJob(options.requestId)
                    });
                    if (closed) return;
                    // The Connection that was admitted for this job, taken from the job: never from
                    // this node's Connection field, which belongs to the probe action alone.
                    const connection = trustedConnection(target.connectionId);
                    secrets = [connection.readKey?.() || ''];
                    await connection.client.approve(target.runId, { choice: target.choice, requestId: target.approvalRequestId });
                    if (closed) return;
                    // An approval is not a completion, and this is the whole of its effect: the queue is
                    // not touched, the run keeps its slot, and polling goes on until it is terminal. The
                    // server's acknowledgement body is deliberately not forwarded - a 2xx already means
                    // it resolved that decision, and nothing it echoes belongs on a flow message.
                    const out = clone(msg);
                    out.payload = {
                        action: 'approve', ok: true, requestId: target.requestId, runId: target.runId,
                        approvalRequestId: target.approvalRequestId, choice: target.choice
                    };
                    out.hermesControl = { action: 'approve', ok: true };
                    node.status({ fill: 'green', shape: 'dot', text: 'approved' });
                    send([out, null]);
                    return;
                }
                const result = await queue.control(action, { requestId: options.requestId, force });
                if (closed) return;
                msg.payload = result;
                msg.hermesControl = { action, ok: true };
                node.status({ fill: 'green', shape: 'dot', text: action });
                send([msg, null]);
            } catch (error) {
                if (closed) return;
                const safe = publicError(error, secrets || []);
                const out = clone(msg);
                out.payload = null;
                out.hermesControl = { ok: false, error: safe };
                if (probeTarget) out.hermes = { ...callerRequest(out), probe: probeOutcome(false) };
                send([null, out]);
                node.status({ fill: 'red', shape: 'ring', text: safe.code });
                msg.payload = null;
                msg.hermesControl = out.hermesControl;
                failure = new HermesError(safe.code, safe.message, safe);
            } finally { done(failure); }
        });
        node.on('close', (_removed, done) => { closed = true; done(); });
    }
    RED.nodes.registerType('hermes-control', Control);
};
