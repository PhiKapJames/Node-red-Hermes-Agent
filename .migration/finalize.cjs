'use strict';
// Temporary, deterministic metadata/documentation migration. Removed before merge.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
assert.equal(lock.version, '0.2.0');
lock.version = '0.3.0'; lock.packages[''].version = '0.3.0'; lock.packages[''].engines.node = '>=24.0.0';
fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
function edit(file, before, after, count = 1) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.split(before).length - 1, count, file + ': ' + before);
    fs.writeFileSync(file, text.replaceAll(before, after));
}
edit('nodes/hermes.html', 'Node-RED 5 and Node.js 22.9+ are required.', 'Node-RED 5 and Node.js 24+ are required.');
edit('nodes/hermes.html', 'Version 0.2 uses in-memory tracking:', 'Version 0.3 uses in-memory tracking:');
edit('scripts/lint.cjs', "'test/**/*.js',", "'test/**/*.js', 'test/**/*.cjs',");
edit('README.md', 'node-red-contrib-hermes-agent-0.2.0.tgz', 'node-red-contrib-hermes-agent-0.3.0.tgz');
edit('README.md', 'Requires **Node-RED 5.0.0+** and **Node.js 22.9.0+**. Node.js 24 is recommended by the Node-RED maintainers. CI exercises Node-RED 5 on Node.js 22 and Node.js 24.', 'Requires **Node-RED 5.0.0+** and **Node.js 24.0.0+**. Deploy the latest supported 24.x patch, not the old 24.0.0 floor. CI tests the 24.0.0 compatibility floor, current 24.x, and Node.js 26 for forward compatibility, all with Node-RED 5.');
edit('README.md', '## Migration to 0.2.0 (Node-RED 5 and later)', '## Migration to 0.3.0 (Node.js 24 and Node-RED 5)');
edit('README.md', 'This is a **breaking** upgrade from the 0.1.x package. Upgrade the Node-RED runtime to 5.0.0+ and Node.js to 22.9.0+ before installing.', 'This is a **breaking** upgrade from 0.1.x/0.2.x. Upgrade Node-RED to 5.0.0+ and Node.js to 24.0.0+ before installing.');
edit('README.md', 'Node-RED 4 and Node.js 18/20 are no longer supported.', 'Node-RED 4 and Node.js 18/20/22 are no longer supported.');
edit('README.md', '## Known limits in 0.2.0', '## Known limits in 0.3.0');
edit('README.md', 'Development checks use ESLint 10 and require Node.js 22.13+; Node.js 24 is recommended for development and deployment.', 'Development and deployment require Node.js 24+. Use `nvm use` with the supplied `.nvmrc`, and keep the selected 24.x release patched.');
edit('README.md', 'npm install --no-save --package-lock=false node-red@5 node-red-node-test-helper', 'npm install --no-save --package-lock=false --ignore-scripts node-red@5');
edit('README.md', 'node --test test/integration/node-red.test.js', 'npm run test:integration');
edit('README.md', 'CI runs the fast suite on Node.js 22/24 and Node-RED 5 runtime tests against a mock Hermes server.', 'CI runs the fast suite on Node.js 24.0.0, current 24.x and 26. Integration tests boot an isolated real Node-RED 5 process for every fixture through its embedding API, with a temporary user directory and mock Hermes server. There is no Node-RED test-helper/Sinon dependency or patched fake runtime; Catch and Complete nodes, credentials, sessions, errors and shutdown are exercised end to end. Deprecation warnings fail test commands rather than being hidden.');
fs.appendFileSync('README.md', '\n## Node.js 24 modernization\n\nHTTP response handling now uses async stream iteration with a composed `AbortSignal.any()` for caller cancellation, connection shutdown and the full-response `AbortSignal.timeout()`. Queue backoff, polling and cooldowns use `node:timers/promises` and abortable delays instead of manual timer/wake callbacks. Node handlers use `async`/`await` and one `done()` completion in `finally`.\n\nThe HTTP implementation intentionally keeps one native `http`/`https` transport rather than switching to `fetch()`: this preserves per-connection custom CA/client certificates and Node-RED TLS options without importing Undici, mutating a global dispatcher or adding a second fallback transport. Redirect blocking, 2 MiB request / 8 MiB response limits, credential redaction, idempotent admission and confirmed remote cancellation remain enforced. Local abort before dispatch is distinguished from uncertain remote execution after dispatch.\n\nNo runtime npm dependencies are introduced. The old test helper and its Sinon-related dependency chain are no longer installed. This is not a guarantee against future upstream deprecations; CI explicitly tests for deprecation regressions. See [the modernization decision record](docs/node24-modernization.md).\n');
const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
fs.writeFileSync('CHANGELOG.md', changelog.replace('# Changelog\n', '# Changelog\n\n## 0.3.0 — Node.js 24+ modernization\n\nBreaking: Node.js 24.0.0+ is now required alongside Node-RED 5+. Refactor native HTTP around async response streams and composed abort/deadline signals while retaining TLS and size limits. Use abortable promise timers for queue polling, cooldown and retry waits, simplify input/shutdown handlers with async/await, and cancel late known admissions on shutdown. Replace the deprecated Node-RED test helper with isolated embedded Node-RED process fixtures using node:test. CI covers the exact Node 24 floor, current 24.x and Node 26 forward compatibility. No runtime dependencies, credential changes, server-profile changes or radio-specific policy are added.\n'));
