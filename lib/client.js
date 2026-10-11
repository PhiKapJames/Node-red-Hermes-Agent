'use strict';

const http = require('node:http');
const https = require('node:https');
const { HermesError, redact } = require('./errors');
const MAX_BODY = 2 * 1024 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;

function endpoint(baseUrl, profile = '') {
    let url;
    try { url = new URL(baseUrl); } catch (_) { throw new HermesError('CONFIG', 'Enter a valid Hermes server URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new HermesError('CONFIG', 'Use an HTTP(S) URL without credentials, query parameters or a fragment.');
    }
    if (profile && !/^[a-zA-Z0-9_-]{1,80}$/.test(profile)) {
        throw new HermesError('CONFIG', 'Profile must contain only letters, numbers, underscores or hyphens.');
    }
    let path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    if (/\/p\/[^/]+$/.test(path)) {
        throw new HermesError('CONFIG', 'Set the profile in the Profile field, not in the server URL.');
    }
    path += profile ? `/p/${encodeURIComponent(profile)}/v1` : '/v1';
    url.pathname = path;
    return url.toString().replace(/\/$/, '');
}

class HermesClient {
    constructor(options) {
        this.base = endpoint(options.baseUrl, options.profile);
        this.getKey = options.getKey;
        this.requestTimeoutMs = options.requestTimeoutMs || 30000;
        this.tlsOptions = options.tlsOptions || {};
        this.httpAgent = new http.Agent({ keepAlive: true });
        this.httpsAgent = new https.Agent({ keepAlive: true, ...this.tlsOptions });
    }

    close() { this.httpAgent.destroy(); this.httpsAgent.destroy(); }

    request(method, path, body, options = {}) {
        const key = this.getKey();
        if (typeof key !== 'string' || !key.trim()) {
            return Promise.reject(new HermesError('MISSING_CREDENTIAL', 'The Hermes connection has no API key.'));
        }
        if (/[\r\n]/.test(key)) return Promise.reject(new HermesError('CONFIG', 'API key contains a newline.'));
        // Paths and headers are constructed by this library, never taken from msg.url/msg.headers.
        const url = new URL(this.base + path);
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        if (payload && payload.length > MAX_BODY) {
            return Promise.reject(new HermesError('INPUT_TOO_LARGE', 'The request exceeds the 2 MiB transport limit.'));
        }
        const signal = options.signal;
        if (signal?.aborted) return Promise.reject(new HermesError('ABORTED', 'Request was interrupted.', { remoteUnknown: method === 'POST' }));
        return new Promise((resolve, reject) => {
            let finished = false;
            let timer;
            let req;
            const finish = (err, result) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                if (err) reject(err); else resolve(result);
            };
            const abort = () => {
                finish(new HermesError('ABORTED', 'Request was interrupted.', { remoteUnknown: method === 'POST' }));
                req?.destroy();
            };
            const headers = { Accept: 'application/json', Authorization: `Bearer ${key}` };
            for (const name of ['Idempotency-Key', 'X-Hermes-Session-Id', 'X-Hermes-Session-Key']) {
                const value = options.headers?.[name];
                if (value !== undefined) headers[name] = value;
            }
            if (payload) {
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = payload.length;
            }
            try {
                req = (url.protocol === 'https:' ? https : http).request(url, {
                    method, headers,
                    agent: url.protocol === 'https:' ? this.httpsAgent : this.httpAgent
                }, res => {
                    let size = 0;
                    const chunks = [];
                    res.on('data', chunk => {
                        size += chunk.length;
                        if (size > MAX_RESPONSE) {
                            finish(new HermesError('RESPONSE_TOO_LARGE', 'Hermes response exceeded 8 MiB.', { remoteUnknown: method === 'POST' }));
                            res.destroy();
                            return;
                        }
                        chunks.push(chunk);
                    });
                    res.on('error', () => finish(new HermesError('NETWORK', 'Hermes response connection was interrupted.', { retryable: true, remoteUnknown: method === 'POST' })));
                    res.on('end', () => {
                        if (finished) return;
                        const code = res.statusCode;
                        const text = Buffer.concat(chunks).toString('utf8');
                        let data;
                        try { data = text ? JSON.parse(text) : {}; } catch (_) { data = null; }
                        if (code < 200 || code >= 300) {
                            // Never follow a redirect with a bearer credential.
                            const detail = typeof data?.error === 'string' ? data.error : data?.error?.message || data?.detail;
                            const errorCode = code >= 300 && code < 400 ? 'REDIRECT_BLOCKED' : `HTTP_${code}`;
                            finish(new HermesError(errorCode, redact(typeof detail === 'string' ? detail : `Hermes returned HTTP ${code}.`, [key]), {
                                statusCode: code, retryable: [408, 429, 500, 502, 503, 504].includes(code),
                                remoteUnknown: method === 'POST' && (code >= 500 || code === 408)
                            }));
                        } else if (!data || typeof data !== 'object' || Array.isArray(data)) {
                            finish(new HermesError('INVALID_RESPONSE', 'Hermes returned an invalid JSON object.', { remoteUnknown: method === 'POST' }));
                        } else finish(null, data);
                    });
                });
            } catch (_) {
                finish(new HermesError('REQUEST_CONFIG', 'Could not construct the Hermes HTTP request.'));
                return;
            }
            req.on('error', () => finish(new HermesError('NETWORK', 'Could not complete the Hermes HTTP request.', { retryable: true, remoteUnknown: method === 'POST' })));
            timer = setTimeout(() => {
                finish(new HermesError('HTTP_TIMEOUT', 'Hermes HTTP request timed out.', { retryable: true, remoteUnknown: method === 'POST' }));
                req.destroy();
            }, options.timeoutMs || this.requestTimeoutMs);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) { abort(); return; }
            req.end(payload);
        });
    }

    chat(body, options) { return this.request('POST', '/chat/completions', body, options); }
    start(body, options) { return this.request('POST', '/runs', body, options); }
    status(runId, options) { return this.request('GET', `/runs/${encodeURIComponent(runId)}`, undefined, options); }
    stop(runId, options) { return this.request('POST', `/runs/${encodeURIComponent(runId)}/stop`, {}, options); }
}

module.exports = { HermesClient, endpoint };
