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
        const url = new URL(this.base + path);
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
                    remoteUnknown: remoteUnknown && (code >= 500 || code === 408)
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

    chat(body, options) { return this.request('POST', '/chat/completions', body, options); }
    start(body, options) { return this.request('POST', '/runs', body, options); }
    status(runId, options) { return this.request('GET', `/runs/${encodeURIComponent(runId)}`, undefined, options); }
    stop(runId, options) { return this.request('POST', `/runs/${encodeURIComponent(runId)}/stop`, {}, options); }
}

module.exports = { HermesClient, endpoint };
