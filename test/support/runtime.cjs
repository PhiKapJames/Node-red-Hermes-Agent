'use strict';
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function startRuntime(t, flows, credentials = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-nr5-'));
    const bus = new EventEmitter();
    const history = new Map();
    const pending = new Map();
    let failure;
    let diagnostics = '';
    const child = fork(path.join(__dirname, 'runtime-process.cjs'), [], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced'
    });
    child.stdout.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16000); });
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16000); });
    const fail = error => {
        failure = String(error);
        bus.emit('failure', failure);
    };
    child.on('error', fail);
    child.on('exit', (code, signal) => { if (code !== 0 || signal) fail(`Runtime exit ${code}/${signal}: ${diagnostics}`); });
    const push = (port, value) => {
        if (!history.has(port)) { history.set(port, []); pending.set(port, []); }
        history.get(port).push(value);
        if (bus.listenerCount(port)) bus.emit(port, value);
        else pending.get(port).push(value);
    };
    child.on('message', message => {
        if (message.type === 'failure') fail(message.error);
        else if (message.type === 'output') push(message.port, message.msg);
        else if (message.type === 'inspection') push(`inspection:${message.id}`, message.value);
        else push(message.type, message);
    });
    async function next(port) {
        if (failure) throw new Error(failure);
        if (pending.get(port)?.length) return pending.get(port).shift();
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
        try {
            return await Promise.race([
                once(bus, port, { signal }).then(([value]) => value),
                once(bus, 'failure', { signal }).then(([error]) => { throw new Error(error); })
            ]);
        } catch (error) {
            throw new Error(`Runtime fixture did not produce ${port}: ${failure || diagnostics || error.message}`, { cause: error });
        } finally {
            controller.abort();
        }
    }
    let closing;
    const close = () => {
        closing ??= (async () => {
            if (child.exitCode !== null || child.signalCode) return;
            const exited = once(child, 'exit');
            const watchdog = setTimeout(() => child.kill('SIGKILL'), 10000);
            try {
                if (child.connected) child.send({ type: 'stop' });
                else child.kill('SIGTERM');
                const [code, signal] = await exited;
                assert.equal(signal, null, `Node-RED failed to stop: ${diagnostics}`);
                assert.equal(code, 0, `Node-RED exited with failure: ${diagnostics}`);
            } finally { clearTimeout(watchdog); }
        })();
        return closing;
    };
    t.after(async () => { try { await close(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
    child.send({ type: 'start', directory, flows, credentials, modulePath: path.resolve(__dirname, '../../nodes/hermes.js') });
    const ready = await next('ready');
    assert.ok(Number(ready.nodeRedVersion.split('.')[0]) >= 5, 'Real Node-RED 5+ is required');
    assert.ok(Number(ready.nodeVersion.slice(1).split('.')[0]) >= 24, 'Node.js 24+ is required');
    return {
        next, close, version: ready.nodeRedVersion,
        send(msg, id = 'input') { child.send({ type: 'inject', id, msg }); },
        messages(port) { return history.get(port) || []; },
        async inspectQueue(id = 'queue') { const value = next(`inspection:${id}`); child.send({ type: 'inspect', id }); return value; }
    };
}

module.exports = { startRuntime };
