'use strict';

const http = require('node:http');
const https = require('node:https');
const { addAbortSignal } = require('node:stream');
const { HermesError, redact } = require('./errors');
const MAX_BODY = 2 * 1024 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
const HEADERS = ['Idempotency-Key', 'X-Hermes-Session-Id', 'X-Hermes-Session-Key'];

function endpoint(baseUrl, profile = '') {
    let url;
    try { url = new URL(baseUrl); } catch { throw new HermesError('CONFIG', 'Enter a valid Hermes server URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new HermesError('CONFIG', 'Use an HTTP(S) URL without credentials, query parameters or a fragment.');
    }
    if (profile && !/^[a-zA-Z0-9_-]{1,80}$/.test(profile)) {
        throw new HermesError('CONFIG', 'Profile must contain only letters, numbers, underscores or hyphens.');
    }
    let path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    if (/\/p\/[^/]+$/.test(path)) throw new HermesError('CONFIG', 'Set the profile in the Profile field, not in the server URL.');
    path += profile ? `/p/${encodeURIComponent(profile)}/v1` : '/v1';
    url.pathname = path;
    return url.toString().replace(/\/$/, '');
}

class HermesClient {
    constructor(options) {
        this.base = endpoint(options.baseUrl, options.profile);
        // `GET /health/detailed` is served at the profile root, not under `/v1`. Deriving the
        // root from the same already-validated endpoint result keeps profile scoping correct and
        // never re-parses user input, so there is still exactly one trusted URL in this client.
        this.root = this.base.replace(/\/v1$/, '');
        this.getKey = options.getKey;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
        this.shutdown = new AbortController();
        // Core HTTP is intentional: one transport preserves the complete Node-RED
        // CA/client-certificate/TLS configuration without an Undici dependency.
        this.agent = this.base.startsWith('https:')
            ? new https.Agent({ keepAlive: true, ...options.tlsOptions })
            : new http.Agent({ keepAlive: true });
    }

    close() {
        this.shutdown.abort();
        this.agent.destroy();
    }

    async request(method, path, body, options = {}) {
        if (this.shutdown.signal.aborted) throw new HermesError('CONNECTION_CLOSED', 'The Hermes connection is closed.');
        const key = this.getKey();
        if (typeof key !== 'string' || !key.trim()) throw new HermesError('MISSING_CREDENTIAL', 'The Hermes connection has no API key.');
        if (/[\r\n]/.test(key)) throw new HermesError('CONFIG', 'API key contains a newline.');
        if (options.signal?.aborted) throw new HermesError('ABORTED', 'Request was interrupted before dispatch.');
        const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
            throw new HermesError('REQUEST_CONFIG', 'HTTP timeout must be a positive integer no greater than 2147483647 ms.');
        }
        let payload;
        try { payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body)); }
        catch { throw new HermesError('INVALID_INPUT', 'The request body must be JSON-serializable.'); }
        if (payload?.length > MAX_BODY) throw new HermesError('INPUT_TOO_LARGE', 'The request exceeds the 2 MiB transport limit.');

        // One signal covers caller cancellation, connection shutdown AND the entire
        // response deadline (including a slow/trickling body, not just headers).
        const deadline = AbortSignal.timeout(timeoutMs);
        const signal = AbortSignal.any([deadline, this.shutdown.signal, ...(options.signal ? [options.signal] : [])]);
        // Two fixed URL scopes only: the profile `/v1` prefix, or the profile root for the health
        // route. `fromRoot` is set by this class alone: a caller can never supply a URL.
        const url = new URL((options.fromRoot === true ? this.root : this.base) + path);
        const headers = { Accept: 'application/json', Authorization: `Bearer ${key}` };
        for (const name of HEADERS) {
            if (options.headers?.[name] !== undefined) headers[name] = options.headers[name];
        }
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = payload.length;
        }
        let req;
        let res;
        let dispatched = false;
        try {
            res = await new Promise((resolve, reject) => {
                req = (url.protocol === 'https:' ? https : http).request(url, {
                    method, headers, agent: this.agent, signal
                }, resolve);
                // Keep an error listener after headers: a body timeout can still
                // error the request. Rejecting an already-settled promise is safe.
                req.on('error', reject);
                req.end(payload);
                dispatched = true;
            });
            addAbortSignal(signal, res);
            const code = res.statusCode;
            const remoteUnknown = dispatched && method === 'POST';
            // No redirect is followed and no target receives the bearer key.
            if (code >= 300 && code < 400) throw new HermesError('REDIRECT_BLOCKED', `Hermes returned HTTP ${code}.`, { statusCode: code });
            if (Number(res.headers['content-length']) > MAX_RESPONSE) {
                throw new HermesError('RESPONSE_TOO_LARGE', 'Hermes response exceeded 8 MiB.', { remoteUnknown });
            }
            const chunks = [];
            let size = 0;
            for await (const chunk of res) {
                size += chunk.length;
                if (size > MAX_RESPONSE) throw new HermesError('RESPONSE_TOO_LARGE', 'Hermes response exceeded 8 MiB.', { remoteUnknown });
                chunks.push(chunk);
            }
            const text = Buffer.concat(chunks, size).toString('utf8');
            let data;
            try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
            if (code < 200 || code >= 300) {
                const detail = typeof data?.error === 'string' ? data.error : data?.error?.message || data?.detail;
                throw new HermesError(`HTTP_${code}`, redact(typeof detail === 'string' ? detail : `Hermes returned HTTP ${code}.`, [key]), {
                    statusCode: code, retryable: [408, 429, 500, 502, 503, 504].includes(code),
                    remoteUnknown: remoteUnknown && (code >= 500 || code === 408),
                    // The envelope is {error:{message,type,param,code}}. Only the machine-readable
                    // reason crosses over, and HermesError drops it unless it is a short lowercase
                    // token, so approval handling and diagnostics keep a stable reason without
                    // letting free-form upstream text through as a code.
                    errorCode: data?.error?.code
                });
            }
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new HermesError('INVALID_RESPONSE', 'Hermes returned an invalid JSON object.', { remoteUnknown });
            }
            return data;
        } catch (error) {
            if (error instanceof HermesError) throw error;
            const remoteUnknown = dispatched && method === 'POST';
            if (signal.aborted) {
                const timedOut = deadline.aborted && signal.reason === deadline.reason;
                throw new HermesError(timedOut ? 'HTTP_TIMEOUT' : 'ABORTED',
                    timedOut ? 'Hermes HTTP request timed out.' : 'Request was interrupted.',
                    { retryable: timedOut, remoteUnknown });
            }
            throw new HermesError(req ? 'NETWORK' : 'REQUEST_CONFIG',
                req ? 'Could not complete the Hermes HTTP request.' : 'Could not construct the Hermes HTTP request.',
                { retryable: Boolean(req), remoteUnknown });
        } finally {
            // Successful responses stay reusable in the keep-alive pool. Failed or
            // abandoned reads are destroyed immediately, including oversized bodies.
            if (!res?.readableEnded) {
                res?.destroy();
                req?.destroy();
            }
        }
    }

    capabilities(options) { return this.request('GET', '/capabilities', undefined, options); }
    // Profile root, not `/v1`: see the contract note for the two different URL scopes.
    healthDetailed(options) { return this.request('GET', '/health/detailed', undefined, { ...options, fromRoot: true }); }
    chat(body, options) { return this.request('POST', '/chat/completions', body, options); }
    start(body, options) { return this.request('POST', '/runs', body, options); }
    status(runId, options) { return this.request('GET', `/runs/${encodeURIComponent(runId)}`, undefined, options); }
    stop(runId, options) { return this.request('POST', `/runs/${encodeURIComponent(runId)}/stop`, {}, options); }
}

// A probe answer is read by operators and dashboards, so every surfaced value is a boolean, a
// clamped whole number or a short single-line string. Platform maps, metrics, extension or tool
// configuration are never copied, whatever the server adds to these payloads later.
const SUMMARY_TEXT = 200;
const SUMMARY_COUNT = 1000000;

// A malformed or partial payload still yields a closed summary instead of throwing.
const fields = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {});
const flag = value => value === true;

function summaryText(value) {
    if (typeof value !== 'string') return undefined;
    // redact() is the package's single redaction choke point: it removes credential-shaped text
    // and collapses CR/LF before this shorter summary cap is applied.
    const text = redact(value).trim();
    return text ? text.slice(0, SUMMARY_TEXT) : undefined;
}

function summaryCount(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
    return Math.min(Math.floor(value), SUMMARY_COUNT);
}

// Absent fields are omitted rather than stored as `undefined`, so a summary can never look like a
// value the server actually reported.
function compact(summary) {
    for (const [key, value] of Object.entries(summary)) {
        if (value === undefined) delete summary[key];
    }
    return summary;
}

// The feature flag and the endpoints-table key are spelled differently upstream, and both are
// required: `features.run_approval_response` is true and the endpoints table advertises
// `run_approval` with a path. Absence of either means unsupported, never "assume supported".
function approvalPath(payload) {
    return summaryText(fields(fields(payload).endpoints).run_approval?.path);
}

function approvalSupported(payload) {
    const features = fields(fields(payload).features);
    return flag(features.run_approval_response) && approvalPath(payload) !== undefined;
}

function projectCapabilities(payload) {
    const data = fields(payload);
    const auth = fields(data.auth);
    const features = fields(data.features);
    return compact({
        target: 'capabilities',
        model: summaryText(data.model),
        auth_type: summaryText(auth.type),
        auth_required: flag(auth.required),
        runtime_mode: summaryText(fields(data.runtime).mode),
        features: {
            run_status: flag(features.run_status),
            run_stop: flag(features.run_stop),
            run_approval_response: flag(features.run_approval_response)
        },
        run_approval_path: approvalPath(data)
    });
}

function projectReadiness(payload) {
    const data = fields(payload);
    return compact({
        target: 'readiness',
        status: summaryText(data.status),
        readiness_status: summaryText(fields(data.readiness).status),
        version: summaryText(data.version),
        gateway_state: summaryText(data.gateway_state),
        gateway_busy: flag(data.gateway_busy),
        active_agents: summaryCount(data.active_agents)
    });
}

module.exports = {
    HermesClient, endpoint, projectCapabilities, projectReadiness, approvalSupported
};
