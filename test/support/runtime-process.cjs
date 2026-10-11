'use strict';
// One isolated, embedded Node-RED runtime per fixture; no internal monkeypatches,
// Sinon, helper library, or attempt to restart a stopped Node-RED singleton.
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const RED = require('node-red');
const fixtures = require('./fixture-nodes.cjs');
let stopping = false;

function send(message) { if (process.connected) process.send(message); }
async function start(config) {
    const nodesDir = path.join(config.directory, 'nodes');
    await fs.mkdir(nodesDir, { recursive: true });
    await fs.writeFile(path.join(nodesDir, 'hermes.js'), `module.exports = require(${JSON.stringify(config.modulePath)});\n`);
    await fs.copyFile(config.modulePath.replace(/\.js$/, '.html'), path.join(nodesDir, 'hermes.html'));
    await fs.writeFile(path.join(nodesDir, 'fixture.js'), `module.exports = require(${JSON.stringify(require.resolve('./fixture-nodes.cjs'))});\n`);
    await fs.writeFile(path.join(nodesDir, 'fixture.html'), '<script type="text/html" data-template-name="fixture-input"></script><script type="text/html" data-template-name="fixture-probe"></script>');
    await fs.writeFile(path.join(config.directory, 'flows.json'), JSON.stringify(config.flows));
    await fs.writeFile(path.join(config.directory, 'flows_cred.json'), JSON.stringify(config.credentials));
    fixtures.output.on('message', data => send({ type: 'output', ...data }));
    RED.init({
        userDir: config.directory, flowFile: 'flows.json',
        httpAdminRoot: false, httpNodeRoot: false, credentialSecret: false,
        functionGlobalContext: {}, externalModules: { autoInstall: false },
        logging: { console: { level: 'off' } }
    });
    const ready = once(RED.events, 'flows:started', { signal: AbortSignal.timeout(15000) });
    await RED.start();
    await ready;
    send({ type: 'ready', nodeRedVersion: RED.version(), nodeVersion: process.version });
}

process.once('message', config => {
    start(config).catch(error => { send({ type: 'failure', error: error.stack }); process.exitCode = 1; process.disconnect(); });
});
process.on('message', async command => {
    try {
        if (command.type === 'inject' && !stopping) fixtures.inject(command.id, command.msg);
        if (command.type === 'inspect') send({ type: 'inspection', id: command.id, value: fixtures.inspect(command.id) });
        if (command.type === 'stop' && !stopping) {
            stopping = true;
            await RED.stop();
            send({ type: 'stopped' });
            process.disconnect();
        }
    } catch (error) { send({ type: 'failure', error: error.stack }); }
});
