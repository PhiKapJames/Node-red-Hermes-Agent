'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { HermesError } = require('./errors');
const { pendingApproval, approvalEvent } = require('./approval');
const { sessionFor, bodyFor, resultFor } = require('./request');
const { admissionRetryDelay } = require('./retry');
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
// A fixed internal bound, like the client's 2 MiB/8 MiB transport caps rather than a
// node setting: `pending` already carries the true waiting count, so a longer FIFO
// prefix would only inflate every status/control message and each downstream clone.
// 50 summaries is ~13 KB of JSON and enough to identify what runs next.
const MAX_QUEUED_SUMMARIES = 50;

/** Shared single-worker FIFO. Application/delivery policy belongs to adapters. */
class HermesQueue extends EventEmitter {
    constructor(options = {}) {
        super();
        this.setMaxListeners(0); // Each Agent removes its own listener on close.
        this.id = options.id || randomUUID();
        this.clientFor = options.clientFor;
        this.maxPending = options.maxPending ?? 10;
        this.cooldownMs = options.cooldownMs ?? 0;
        this.pollIntervalMs = options.pollIntervalMs ?? 5000;
        this.jobTimeoutMs = options.jobTimeoutMs ?? 1200000;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
        this.stopTimeoutMs = options.stopTimeoutMs ?? 30000;
        this.retryDelayMs = options.retryDelayMs ?? 2000;
        this.startRetries = options.startRetries ?? 2;
        this.maxPollErrors = options.maxPollErrors ?? 3;
        // Off unless a Queue configuration says so: the approval preview is operator-facing text
        // about a pending remote decision, and a legacy or hand-edited flow must never show it.
        this.includeApprovalPreview = options.includeApprovalPreview === true;
        this.epoch = randomUUID();
        this.pending = [];
        this.active = null;
        this.executions = new Set();
        this.lastStartedAt = 0;
        this.paused = false;
        this.uncertain = null;
        this.closed = false;
        this.startDelay = null;
        this.shutdown = new AbortController();
        this.closePromise = null;
    }

    snapshot() {
        // A retained uncertain job has already emitted its terminal lifecycle event, so
        // job.phase is terminal. The snapshot must still report it as uncertain because
        // remote termination is unconfirmed: that is why the queue is paused.
        const summary = job => job ? {
            requestId: job.id, ownerId: job.ownerId, mode: job.spec.mode,
            clientId: job.spec.clientId || null, sessionId: job.sessionId,
            runId: job.runId || null, status: job === this.uncertain ? 'uncertain' : job.phase,
            createdAt: job.createdAt, startedAt: job.startedAt || null
        } : null;
        const queued = this.pending.slice(0, MAX_QUEUED_SUMMARIES);
        return {
            paused: this.paused, closed: this.closed, pending: this.pending.length,
            active: summary(this.active), uncertain: summary(this.uncertain),
            queued: queued.map(summary), queuedTruncated: this.pending.length > queued.length,
            cooldownRemainingMs: Math.max(0, this.cooldownMs - (Date.now() - this.lastStartedAt))
        };
    }

    /**
     * The job that is active right now, addressed by its queue request id, or null. This is the
     * only way to resolve an approval target: a caller gets the run id, the connection id and the
     * projected pending decision of the job this queue is running, and nothing else. A waiting job,
     * an unknown or missing id, a retired uncertain job and a closed queue all resolve to null, so
     * a late click can never name a job the queue has stopped running.
     */
    activeJob(requestId) {
        const job = this.active;
        if (!requestId || !job || this.closed || job === this.uncertain || job.id !== requestId) return null;
        return job;
    }

    event(job, status, details = {}) {
        job.phase = status;
        this.emit('progress', job, {
            requestId: job.id, status, mode: job.spec.mode, clientId: job.spec.clientId,
            sessionId: job.sessionId, ...(job.runId ? { runId: job.runId } : {}), ...details
        });
    }

    enqueue({ ownerId, connectionId, spec, message }) {
        if (this.closed) throw new HermesError('QUEUE_CLOSED', 'This Hermes queue is closed.');
        if (this.uncertain) throw new HermesError('QUEUE_UNCERTAIN', 'An earlier request may still be executing; recover or force-reset the queue.');
        const occupied = Boolean(this.active || this.pending.length || this.paused || Date.now() - this.lastStartedAt < this.cooldownMs);
        if (occupied && this.pending.length >= this.maxPending) throw new HermesError('QUEUE_FULL', 'The shared Hermes queue is full.');
        const job = {
            id: randomUUID(), ownerId, connectionId, spec, message,
            generation: this.epoch, createdAt: Date.now(), phase: 'queued',
            sessionId: sessionFor(spec, this.id, connectionId, this.epoch),
            idempotencyKey: `nr-${randomUUID()}`, runId: null,
            // The one decision this job's own run has reported as pending, projected by
            // lib/approval.js, or null whenever there is none. Explicit null, never a missing
            // field: an approval action must be able to tell "nothing pending" from "not looked".
            approval: null,
            cancelRequested: null, forced: false, settled: false,
            controller: new AbortController(), delayController: null
        };
        job.body = bodyFor(spec, job.sessionId);
        const deferred = Promise.withResolvers();
        job.finished = deferred.promise;
        job.resolve = deferred.resolve;
        job.reject = deferred.reject;
        this.pending.push(job);
        this.event(job, 'queued', { position: this.pending.length });
        this.kick();
        return { requestId: job.id, finished: job.finished };
    }

    kick() {
        this.startDelay?.abort();
        this.startDelay = null;
        if (this.closed || this.active || this.paused || this.uncertain || !this.pending.length) return;
        const controller = new AbortController();
        this.startDelay = controller;
        void this.runNext(controller);
    }

    async runNext(controller) {
        const signal = AbortSignal.any([controller.signal, this.shutdown.signal]);
        try { await delay(Math.max(0, this.cooldownMs - (Date.now() - this.lastStartedAt)), undefined, { signal }); }
        catch (error) { if (signal.aborted) return; throw error; }
        if (this.startDelay !== controller) return;
        this.startDelay = null;
        if (this.closed || this.active || this.paused || this.uncertain || !this.pending.length) return;
        const job = this.pending.shift();
        this.active = job;
        this.executions.add(job);
        this.lastStartedAt = job.startedAt = Date.now();
        try {
            this.event(job, 'starting');
            const result = await this.execute(job);
            if (job.cancelRequested || job.generation !== this.epoch) {
                this.settle(job, new HermesError('CANCELLED', 'The request was cancelled.'));
            } else this.settle(job, null, result);
        } catch (error) {
            if (error.remoteUnknown && !job.forced && !this.closed) {
                this.uncertain = job;
                this.paused = true;
                this.event(job, 'uncertain', { remoteUnknown: true });
            }
            this.settle(job, error);
        } finally {
            this.executions.delete(job);
            if (this.active === job) this.active = null;
            this.kick();
        }
    }

    settle(job, error, result) {
        if (job.settled) return;
        job.settled = true;
        if (error) {
            this.event(job, error.code === 'CANCELLED' ? 'cancelled' : 'failed', {
                code: error.code || 'HERMES_ERROR', remoteUnknown: Boolean(error.remoteUnknown)
            });
            job.reject(error);
        } else {
            const metadata = {
                requestId: job.id, mode: job.spec.mode, clientId: job.spec.clientId,
                sessionId: job.sessionId, runId: job.runId || undefined,
                durationMs: Date.now() - job.startedAt
            };
            this.event(job, 'completed');
            job.resolve({ ...result, ...metadata });
        }
    }

    async sleep(job, ms, confirmingStop = false) {
        if (this.closed || (job.cancelRequested && !confirmingStop)) return;
        const controller = new AbortController();
        job.delayController = controller;
        const signal = AbortSignal.any([controller.signal, this.shutdown.signal]);
        try { await delay(Math.max(0, ms), undefined, { signal }); }
        catch (error) { if (!signal.aborted) throw error; }
        finally { if (job.delayController === controller) job.delayController = null; }
    }

    options(job, extra = {}) {
        const remaining = Math.max(1, this.jobTimeoutMs - (Date.now() - job.startedAt));
        return { timeoutMs: Math.min(this.requestTimeoutMs, remaining), signal: job.controller.signal, ...extra };
    }

    async execute(job) {
        const client = this.clientFor(job.connectionId);
        if (!client) throw new HermesError('CONNECTION_UNAVAILABLE', 'The configured Hermes connection is unavailable.');
        job.client = client;
        if (job.cancelRequested) throw new HermesError('CANCELLED', 'The request was cancelled before execution.');
        const headers = {};
        if (job.spec.sessionKey) headers['X-Hermes-Session-Key'] = job.spec.sessionKey;
        if (job.spec.mode === 'sync') {
            this.event(job, 'running');
            try {
                const data = await client.chat(job.body, this.options(job, {
                    timeoutMs: Math.max(1, this.jobTimeoutMs - (Date.now() - job.startedAt)),
                    headers: { ...headers, 'X-Hermes-Session-Id': job.sessionId }
                }));
                if (job.cancelRequested) throw new HermesError('CANCELLED', 'The synchronous request was cancelled.');
                return resultFor(data, 'sync');
            } catch (error) {
                // Stopping a local HTTP wait is NOT confirmation of remote cancellation.
                if (job.cancelRequested && error.code === 'ABORTED') {
                    throw new HermesError('CANCELLED', 'Stopped waiting for synchronous response; server-side execution may continue.', { remoteUnknown: error.remoteUnknown });
                }
                throw error;
            }
        }

        let uncertainAdmission = false;
        for (let attempt = 0; ; attempt++) {
            if (job.cancelRequested && !uncertainAdmission) throw new HermesError('CANCELLED', 'Cancelled before another admission attempt.');
            if (Date.now() - job.startedAt >= this.jobTimeoutMs) {
                throw new HermesError('JOB_TIMEOUT', 'Run admission exceeded its deadline.', { remoteUnknown: uncertainAdmission });
            }
            try {
                const data = await client.start(job.body, this.options(job, {
                    headers: { ...headers, 'Idempotency-Key': job.idempotencyKey }
                }));
                if (typeof data.run_id !== 'string' || !data.run_id || data.run_id.length > 200) {
                    throw new HermesError('INVALID_RESPONSE', 'Hermes admission did not return a run_id.', { remoteUnknown: true });
                }
                job.runId = data.run_id;
                this.event(job, 'accepted');
                break;
            } catch (error) {
                uncertainAdmission ||= Boolean(error.remoteUnknown);
                if (this.closed || !error.retryable || attempt >= this.startRetries) {
                    error.remoteUnknown ||= uncertainAdmission;
                    throw error;
                }
                // A 429 means the server has no capacity for another run, so repeated
                // admission waits are backed off within the job's remaining deadline.
                const delayMs = admissionRetryDelay({
                    baseMs: this.retryDelayMs, retryIndex: attempt,
                    statusCode: error.statusCode,
                    remainingMs: this.jobTimeoutMs - (Date.now() - job.startedAt)
                });
                this.event(job, 'retrying', { operation: 'start', attempt: attempt + 1, delayMs });
                await this.sleep(job, delayMs);
            }
        }
        // An uncooperative in-flight admission may finish after shutdown. Stop a
        // late known run rather than orphaning it; never deliver its final answer.
        if (this.closed) {
            try { await client.stop(job.runId, { timeoutMs: 2000 }); } catch { /* Best effort only. */ }
            throw new HermesError('QUEUE_CLOSED', 'Queue stopped during admission; remote execution may continue.', { remoteUnknown: true });
        }

        let errors = 0;
        let lastStatus = '';
        let lastApprovalId = '';
        while (!this.closed) {
            if (job.cancelRequested || Date.now() - job.startedAt >= this.jobTimeoutMs) {
                const confirmed = await this.stopAndConfirm(job);
                throw new HermesError(job.cancelRequested ? 'CANCELLED' : 'JOB_TIMEOUT',
                    job.cancelRequested ? 'The asynchronous request was cancelled.' : 'The asynchronous run exceeded its deadline.',
                    { remoteUnknown: !confirmed });
            }
            let data;
            try { data = await client.status(job.runId, this.options(job)); }
            catch (error) {
                if (this.closed) throw error;
                if (job.cancelRequested) continue;
                errors++;
                if (!error.retryable || errors >= this.maxPollErrors) {
                    const confirmed = await this.stopAndConfirm(job);
                    error.remoteUnknown = !confirmed;
                    throw error;
                }
                this.event(job, 'retrying', { operation: 'poll', attempt: errors });
                await this.sleep(job, this.retryDelayMs);
                continue;
            }
            errors = 0;
            const status = String(data.status || '').toLowerCase();
            if (job.cancelRequested) {
                if (TERMINAL.has(status)) throw new HermesError('CANCELLED', 'The request was cancelled; its final output was discarded.');
                continue;
            }
            if (status === 'completed') return resultFor(data, 'async');
            if (['failed', 'cancelled', 'interrupted'].includes(status)) {
                throw new HermesError(`RUN_${status.toUpperCase()}`, typeof data.error === 'string' ? data.error : `Hermes run ${status}.`);
            }
            if (!['queued', 'started', 'running', 'stopping', 'waiting_for_approval'].includes(status)) {
                const confirmed = await this.stopAndConfirm(job);
                throw new HermesError('INVALID_RUN_STATUS', 'Hermes returned an unrecognized run status.', { remoteUnknown: !confirmed });
            }
            // A pending decision is identified by its `request_id`, not by the status string: the
            // server returns the run to `running` as soon as a decision is answered, so a second
            // decision arrives with a status this queue has already reported, and a poll can miss
            // the intervening `running` altogether. A decision with no usable id has no identity to
            // compare, so it is reported once rather than on every poll.
            if (status === 'waiting_for_approval') {
                const approval = pendingApproval(data.approval, { includeApprovalPreview: this.includeApprovalPreview });
                const identity = approval?.requestId || '';
                if (status !== lastStatus || identity !== lastApprovalId) {
                    // Only a decision with a usable identity becomes the job's claim. An approval
                    // object that reports no addressable `request_id` is surfaced, but never made
                    // answerable through the job: a lookup must not succeed on two absent values.
                    job.approval = approval?.requestId ? approval : null;
                    this.event(job, status, approvalEvent(approval));
                }
                lastApprovalId = identity;
            } else if (status !== lastStatus) {
                // The decision left with the status, so the job's claim on it goes too: an answered
                // or vanished decision is not addressable, whatever the next poll brings.
                job.approval = null;
                this.event(job, status);
            }
            lastStatus = status;
            await this.sleep(job, this.pollIntervalMs);
        }
        throw new HermesError('QUEUE_CLOSED', 'Queue stopped while the request was running.', { remoteUnknown: true });
    }

    async stopAndConfirm(job) {
        if (!job.runId || !job.client || this.closed) return false;
        const deadline = Date.now() + this.stopTimeoutMs;
        const options = () => ({
            timeoutMs: Math.max(1, Math.min(this.requestTimeoutMs, deadline - Date.now())), signal: this.shutdown.signal
        });
        this.event(job, 'stopping');
        try { await job.client.stop(job.runId, options()); } catch { /* A status check can still prove completion. */ }
        while (Date.now() < deadline && !this.closed) {
            try {
                const result = await job.client.status(job.runId, options());
                if (TERMINAL.has(String(result.status).toLowerCase())) return true;
            } catch (error) { if (error.statusCode === 401 || error.statusCode === 403) return false; }
            await this.sleep(job, Math.min(this.pollIntervalMs, 500, Math.max(0, deadline - Date.now())), true);
        }
        return false;
    }

    cancelJob(job, force = false) {
        job.cancelRequested = 'cancel';
        job.forced ||= force;
        // Do not abort async admission: its late ID is needed for safe cancellation.
        if (job.spec.mode === 'sync') job.controller.abort();
        job.delayController?.abort();
        if (force) {
            if (this.active === job) this.active = null;
            this.settle(job, new HermesError('CANCELLED', 'Force-reset discarded local tracking; remote work may continue.', { remoteUnknown: true }));
        }
    }

    clear() {
        const jobs = this.pending.splice(0);
        for (const job of jobs) this.settle(job, new HermesError('CANCELLED', 'Queued request was cleared before execution.'));
        return jobs.length;
    }

    reset(force = false) {
        const cleared = this.clear();
        const active = this.active;
        const unknown = Boolean(this.uncertain);
        this.epoch = randomUUID();
        this.lastStartedAt = 0;
        // A non-force reset retains active until termination is confirmed or the
        // queue is marked uncertain. Only explicit force can permit remote overlap.
        if (active) this.cancelJob(active, force);
        if (force) this.uncertain = null;
        this.paused = Boolean(this.uncertain);
        this.kick();
        return { action: 'reset', cleared, cancellationRequested: Boolean(active), force,
            remoteMayContinue: Boolean(force && (active || unknown)), ...this.snapshot() };
    }

    cancel(requestId) {
        if (!requestId || this.active?.id === requestId) {
            if (!this.active) return { action: 'cancel', cancelled: false };
            this.cancelJob(this.active);
            return { action: 'cancel', cancellationRequested: true, requestId: this.active.id };
        }
        const index = this.pending.findIndex(job => job.id === requestId);
        if (index < 0) throw new HermesError('REQUEST_NOT_FOUND', 'No queued or active request has that ID.');
        const [job] = this.pending.splice(index, 1);
        this.settle(job, new HermesError('CANCELLED', 'Queued request was cancelled.'));
        return { action: 'cancel', cancelled: true, requestId };
    }

    async recover() {
        const job = this.uncertain;
        if (!job) return { action: 'recover', recovered: true, ...this.snapshot() };
        if (!job.runId) throw new HermesError('QUEUE_UNCERTAIN', 'Admission is uncertain and no run ID is known. Check Hermes before force-resetting.');
        if (!await this.stopAndConfirm(job)) throw new HermesError('QUEUE_UNCERTAIN', 'Remote termination could not be confirmed. Queue remains paused.');
        // A concurrent force reset/recovery may already have replaced this job.
        if (this.uncertain === job) {
            this.uncertain = null;
            this.paused = false;
            this.kick();
        }
        return { action: 'recover', recovered: true, ...this.snapshot() };
    }

    control(action, options = {}) {
        switch (action) {
        case 'status': return { action, ...this.snapshot() };
        case 'pause': this.paused = true; this.kick(); return { action, ...this.snapshot() };
        case 'resume':
            if (this.uncertain) throw new HermesError('QUEUE_UNCERTAIN', 'Recover or force-reset before resuming an uncertain queue.');
            this.paused = false; this.kick(); return { action, ...this.snapshot() };
        case 'clear': return { action, cleared: this.clear(), ...this.snapshot() };
        case 'cancel': return this.cancel(options.requestId);
        case 'reset': return this.reset(options.force === true);
        case 'recover': return this.recover();
        default: throw new HermesError('INVALID_ACTION', 'Use status, pause, resume, clear, cancel, reset or recover.');
        }
    }

    cancelOwner(ownerId) {
        const jobs = this.pending.filter(job => job.ownerId === ownerId);
        this.pending = this.pending.filter(job => job.ownerId !== ownerId);
        for (const job of jobs) this.settle(job, new HermesError('CANCELLED', 'Owning Agent node was stopped.'));
        if (this.active?.ownerId === ownerId) this.cancelJob(this.active);
    }

    close() {
        this.closePromise ??= this.closeQueue();
        return this.closePromise;
    }

    async closeQueue() {
        this.closed = true;
        this.startDelay?.abort();
        this.startDelay = null;
        this.shutdown.abort();
        this.clear();
        const attempts = [];
        for (const job of this.executions) {
            job.cancelRequested = 'shutdown';
            job.controller.abort();
            job.delayController?.abort();
            if (job.runId && job.client) attempts.push(job.client.stop(job.runId, { timeoutMs: 2000 }).catch(() => {}));
            this.settle(job, new HermesError('QUEUE_CLOSED', 'Node-RED queue stopped. Remote execution may continue.', { remoteUnknown: true }));
        }
        await Promise.allSettled(attempts);
    }
}

module.exports = { HermesQueue };
