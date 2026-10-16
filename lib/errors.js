'use strict';

// The upstream machine-readable reason (`{error:{code}}`) is the only upstream field allowed to
// survive as a code. A short lowercase token can be matched exactly by a flow, while free-form
// upstream text, credentials and log-line forgeries must stay in the redacted `message`.
const ERROR_CODE = /^[a-z0-9_.-]{1,64}$/;

function safeErrorCode(value) {
    // Deliberately no coercion: `42` or `{ toString() {} }` are not upstream codes.
    return typeof value === 'string' && ERROR_CODE.test(value) ? value : undefined;
}

class HermesError extends Error {
    constructor(code, message, options = {}) {
        super(message);
        this.name = 'HermesError';
        this.code = code;
        this.statusCode = options.statusCode || 0;
        this.retryable = Boolean(options.retryable);
        this.remoteUnknown = Boolean(options.remoteUnknown);
        // Anything but a validated token is dropped entirely rather than truncated or escaped,
        // so a caller can never forward an upstream string as if it were a reason code.
        const errorCode = safeErrorCode(options.errorCode);
        if (errorCode !== undefined) this.errorCode = errorCode;
    }
}

function redact(value, secrets = []) {
    let text = String(value == null ? '' : value);
    for (const secret of secrets) {
        if (typeof secret === 'string' && secret.length) text = text.split(secret).join('[REDACTED]');
    }
    return text
        .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
        // Only CR and LF can start a new record in a line-based log, so an upstream
        // error body could otherwise forge extra lines in the Node-RED log and in
        // msg.hermes.error.message. A run collapses to one space to keep words apart.
        // Tabs cannot forge a line and stay as they were. Collapsing happens before
        // the cap so 600 always describes the final single-line form.
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 600);
}

function publicError(error, secrets = []) {
    // Validated again on the way out: `error` may be a plain object that never went through
    // HermesError, and a code must not be invented from anything upstream sent.
    const errorCode = safeErrorCode(error?.errorCode);
    return {
        code: /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'HERMES_ERROR',
        message: redact(error?.message || 'Hermes request failed.', secrets),
        statusCode: Number(error?.statusCode) || 0,
        retryable: Boolean(error?.retryable),
        remoteUnknown: Boolean(error?.remoteUnknown),
        // Omitted, not null, unless the server actually advertised a usable reason code.
        ...(errorCode ? { errorCode } : {})
    };
}

module.exports = { HermesError, redact, publicError };
