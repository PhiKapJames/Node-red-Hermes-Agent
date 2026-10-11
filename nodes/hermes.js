'use strict';

const { HermesClient } = require('../lib/client');
const { HermesQueue } = require('../lib/queue');
const { prepareRequest, plainObject } = require('../lib/request');
const { HermesError, publicError } = require('../lib/errors');

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
                requestTimeoutMs: number(config.requestTimeout, 30, 1, 3600, 'HTTP timeout') * 1000,
                tlsOptions
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
        try {
            const maxPending = number(config.maxPending, 10, 0, 10000, 'Queue capacity');
            if (!Number.isInteger(maxPending)) throw new HermesError('CONFIG', 'Queue capacity must be an integer.');
            node.scheduler = new HermesQueue({
                id: node.id,
                clientFor: id => RED.nodes.getNode(id)?.client,
                maxPending,
                cooldownMs: number(config.cooldown, 0, 0, 86400, 'Cooldown') * 1000,
                pollIntervalMs: number(config.pollInterval, 5, 0.25, 300, 'Poll interval') * 1000,
                jobTimeoutMs: number(config.jobTimeout, 1200, 1, 86400, 'Run deadline') * 1000,
                requestTimeoutMs: number(config.asyncRequestTimeout, 30, 1, 3600, 'Async HTTP timeout') * 1000,
                stopTimeoutMs: number(config.stopTimeout, 30, 1, 300, 'Cancellation grace') * 1000,
                retryDelayMs: number(config.retryDelay, 2, 0.1, 300, 'Retry delay') * 1000,
                startRetries: Math.floor(number(config.startRetries, 2, 0, 10, 'Admission retries'))
            });
        } catch (error) { node.configError = publicError(error); node.error(node.configError.message); }
        node.on('close', (_removed, done) => {
            if (node.scheduler?.active) node.warn('Queue is stopping with active work; remote cancellation is best effort. Pending requests are not persisted.');
            Promise.resolve()
                .then(() => node.scheduler?.close())
                .catch(error => node.warn(`Hermes queue shutdown: ${publicError(error).message}`))
                .finally(done);
        });
    }
    RED.nodes.registerType('hermes-queue', Queue);

    function Prepare(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.on('input', (msg, send, done) => {
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
                    if (options.author !== undefined && !plainObject(options.author)) {
                        throw new HermesError('INVALID_INPUT', 'Existing author must be an object.');
                    }
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
                done();
            } catch (error) {
                node.status({ fill: 'red', shape: 'ring', text: error.code || 'invalid input' });
                const safe = publicError(error);
                msg.payload = null;
                msg.hermes = { status: 'failed', error: safe };
                done(new HermesError(safe.code, safe.message, safe));
            }
        });
    }
    RED.nodes.registerType('hermes-prepare', Prepare);

    function Agent(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const connection = RED.nodes.getNode(config.connection);
        const queue = RED.nodes.getNode(config.queue)?.scheduler;
        let closed = false;
        const secrets = () => [connection?.readKey?.() || ''];
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
        node.on('input', (msg, send, done) => {
            const original = clone(msg);
            let requestId;
            const fail = error => {
                if (!closed) {
                    const safe = publicError(error, secrets());
                    const out = clone(original);
                    out.payload = null;
                    out.hermes = { requestId, status: safe.code === 'CANCELLED' ? 'cancelled' : 'failed', error: safe };
                    send([null, null, out]);
                    node.status({ fill: 'red', shape: 'ring', text: safe.code });
                    // done() is bound to this input message, not the cloned output.
                    msg.payload = null;
                    msg.hermes = out.hermes;
                    done(new HermesError(safe.code, safe.message, safe));
                    return;
                }
                done();
            };
            try {
                if (!connection?.client || !queue) throw new HermesError('CONFIG', 'Select a valid Hermes connection and shared queue.');
                if (!connection.readKey()) throw new HermesError('MISSING_CREDENTIAL', 'Set the API key on the shared Hermes connection.');
                const spec = prepareRequest(property(msg, config.inputProperty || 'payload'), msg.hermes || {}, {
                    mode: config.mode || 'async', instructions: config.instructions || '', model: config.model || '',
                    includeContext: config.includeContext !== false, allowModelOverride: config.allowModelOverride === true
                });
                const ticket = queue.enqueue({ ownerId: node.id, connectionId: config.connection, spec, message: original });
                requestId = ticket.requestId;
                ticket.finished.then(result => {
                    if (!closed) {
                        const out = clone(original);
                        const { output, ...metadata } = result;
                        out.payload = output;
                        out.hermes = metadata;
                        send([out, null, null]);
                        node.status({ fill: 'green', shape: 'dot', text: 'completed' });
                    }
                    done();
                }).catch(fail);
            } catch (error) { fail(error); }
        });
        node.on('close', (_removed, done) => {
            closed = true;
            queue?.removeListener('progress', progress);
            queue?.cancelOwner(node.id);
            done();
        });
    }
    RED.nodes.registerType('hermes-agent', Agent);

    function Control(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const queue = RED.nodes.getNode(config.queue)?.scheduler;
        node.on('input', async (msg, send, done) => {
            try {
                if (!queue) throw new HermesError('CONFIG', 'Select a shared Hermes queue.');
                const options = msg.hermesControl || {};
                if (!plainObject(options)) throw new HermesError('INVALID_INPUT', 'hermesControl must be an object.');
                const action = config.action === 'message' ? options.action : config.action || 'status';
                if (options.force === true && config.allowForce !== true) throw new HermesError('OVERRIDE_DISABLED', 'Force reset is not enabled on this Control node.');
                const result = await queue.control(action, { requestId: options.requestId, force: options.force === true });
                msg.payload = result;
                msg.hermesControl = { action, ok: true };
                node.status({ fill: 'green', shape: 'dot', text: action });
                send([msg, null]);
                done();
            } catch (error) {
                const safe = publicError(error);
                const out = clone(msg);
                out.payload = null;
                out.hermesControl = { ok: false, error: safe };
                send([null, out]);
                node.status({ fill: 'red', shape: 'ring', text: safe.code });
                msg.payload = null;
                msg.hermesControl = out.hermesControl;
                done(new HermesError(safe.code, safe.message, safe));
            }
        });
    }
    RED.nodes.registerType('hermes-control', Control);
};
