'use strict';

class HermesError extends Error {
    constructor(code, message, options = {}) {
        super(message);
        this.name = 'HermesError';
        this.code = code;
        this.statusCode = options.statusCode || 0;
        this.retryable = Boolean(options.retryable);
        this.remoteUnknown = Boolean(options.remoteUnknown);
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
    return {
        code: /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'HERMES_ERROR',
        message: redact(error?.message || 'Hermes request failed.', secrets),
        statusCode: Number(error?.statusCode) || 0,
        retryable: Boolean(error?.retryable),
        remoteUnknown: Boolean(error?.remoteUnknown)
    };
}

module.exports = { HermesError, redact, publicError };
