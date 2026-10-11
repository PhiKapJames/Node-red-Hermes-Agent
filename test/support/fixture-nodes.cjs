'use strict';
// Test-only bridge registered by the real Node-RED loader, never shipped in npm.
const { EventEmitter } = require('node:events');
const inputs = new Map();
const output = new EventEmitter();
let inspect;

module.exports = function(RED) {
    // Embedded Node-RED runtimes without an editor may not preload these
    // built-in event nodes. Register the actual Node-RED implementations,
    // not mocks, before loading the fixture flow's Catch/Complete nodes.
    for (const [type, file] of [
        ['catch', '@node-red/nodes/core/common/25-catch.js'],
        ['complete', '@node-red/nodes/core/common/24-complete.js']
    ]) {
        if (!RED.nodes.getType(type)) require(file)(RED);
    }
    function Input(config) {
        RED.nodes.createNode(this, config);
        inputs.set(this.id, this);
        this.on('close', () => inputs.delete(this.id));
    }
    function Probe(config) {
        RED.nodes.createNode(this, config);
        this.on('input', (msg, _send, done) => { output.emit('message', { port: this.id, msg }); done(); });
    }
    RED.nodes.registerType('fixture-input', Input);
    RED.nodes.registerType('fixture-probe', Probe);
    inspect = id => {
        const scheduler = RED.nodes.getNode(id)?.scheduler;
        if (!scheduler) throw new Error('Missing fixture Queue configuration.');
        return { ...scheduler.snapshot(), requestTimeoutMs: scheduler.requestTimeoutMs };
    };
};
module.exports.inject = (id, msg) => {
    const input = inputs.get(id);
    if (!input) throw new Error(`Missing fixture input: ${id}`);
    input.send(msg);
};
module.exports.inspect = id => inspect(id);
module.exports.output = output;
