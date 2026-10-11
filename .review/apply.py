"""Apply reviewed changes to the verified baseline. Temporary CI-only assembler."""
import json
import re
from pathlib import Path


def edit(path, old, new, count=1):
    p = Path(path)
    source = p.read_text()
    assert source.count(old) == count, f'{path}: expected {count} exact matches: {old[:90]}'
    p.write_text(source.replace(old, new))


p = Path('package.json')
pkg = json.loads(p.read_text())
pkg['repository']['url'] = 'git+https://github.com/PhiKapJames/Node-red-Hermes-Agent.git'
pkg['bugs']['url'] = 'https://github.com/PhiKapJames/Node-red-Hermes-Agent/issues'
pkg['homepage'] = 'https://github.com/PhiKapJames/Node-red-Hermes-Agent#readme'
pkg['author'] = 'PhiKapJames'
pkg['scripts']['check:syntax'] = pkg['scripts']['check']
pkg['scripts']['lint'] = 'node scripts/lint.cjs'
pkg['scripts']['check'] = 'npm run check:syntax && npm run lint'
pkg['scripts']['prepack'] = 'npm run check:syntax && npm test'
pkg['devDependencies'] = {'@eslint/js': '9.39.1', 'eslint': '9.39.1', 'globals': '16.5.0'}
p.write_text(json.dumps(pkg, indent=2) + '\n')

edit('lib/queue.js', '        super();', '''        super();
        // Each configured Agent has one progress listener; sharing is intentionally unbounded.
        // Agent close handlers still remove their listener to prevent lifecycle leaks.
        this.setMaxListeners(0);''')
edit('lib/queue.js', '        if (active) this.cancelJob(active, force);', '''        // Non-force cancellation keeps this.active reserved. kick() cannot admit
        // another job until execute() confirms termination (or pauses as uncertain).
        // Only the explicitly unsafe force path releases local tracking early.
        if (active) this.cancelJob(active, force);''')

edit('nodes/hermes.js', "requestTimeoutMs: number(config.requestTimeout, 30, 1, 3600, 'Async HTTP timeout') * 1000,", "requestTimeoutMs: number(config.asyncRequestTimeout ?? config.requestTimeout, 30, 1, 3600, 'Async HTTP timeout') * 1000,")
edit('nodes/hermes.js', '''                if (config.authorIdProperty || config.authorNameProperty) {
                    options.author = {
                        ...(config.authorIdProperty ? { id: property(msg, config.authorIdProperty) } : {}),
                        ...(config.authorNameProperty ? { name: property(msg, config.authorNameProperty) } : {}),
                        is_bot: false
                    };
                }''', '''                if (config.authorIdProperty || config.authorNameProperty || config.authorIsBotProperty) {
                    if (options.author !== undefined && !plainObject(options.author)) {
                        throw new HermesError('INVALID_INPUT', 'Existing author must be an object.');
                    }
                    const author = { ...(options.author || {}) };
                    if (config.authorIdProperty) author.id = property(msg, config.authorIdProperty);
                    if (config.authorNameProperty) author.name = property(msg, config.authorNameProperty);
                    if (config.authorIsBotProperty) {
                        const value = property(msg, config.authorIsBotProperty);
                        if (typeof value !== 'boolean') throw new HermesError('INVALID_INPUT', 'Mapped author bot flag must be a boolean.');
                        author.is_bot = value;
                    } else if (author.is_bot === undefined) author.is_bot = false;
                    options.author = author;
                }''')
edit('lib/request.js', "        author = {\n            id: text(options.author.id, 'author.id', 200),", "        if (options.author.is_bot !== undefined && typeof options.author.is_bot !== 'boolean') {\n            throw new HermesError('INVALID_INPUT', 'author.is_bot must be a boolean.');\n        }\n        author = {\n            id: text(options.author.id, 'author.id', 200),")

# done(error) preserves Node-RED message tracing and Catch semantics. Do not call
# node.error as well, since that would produce a second Catch notification.
edit('nodes/hermes.js', '            done = done || (() => {});', '            done = done || (error => { if (error) node.error(error, msg); });', 3)
edit('nodes/hermes.js', '''                node.error(publicError(error).message, msg);
                done();''', '''                const safe = publicError(error);
                msg.payload = null;
                msg.hermes = { status: 'failed', error: safe };
                done(new HermesError(safe.code, safe.message, safe));''')
edit('nodes/hermes.js', '''                    node.error(safe.message, out);
                }
                done();''', '''                    // done() is bound to this input message, not the cloned output.
                    msg.payload = null;
                    msg.hermes = out.hermes;
                    done(new HermesError(safe.code, safe.message, safe));
                    return;
                }
                done();''')
edit('nodes/hermes.js', '''                node.error(safe.message, out);
                done();''', '''                msg.payload = null;
                msg.hermesControl = out.hermesControl;
                done(new HermesError(safe.code, safe.message, safe));''')

# Preserve legacy Queue requestTimeout until an old flow is saved in the editor.
edit('nodes/hermes.html', '<script type="text/javascript">\n(function()', '<script type="text/javascript">\n\'use strict\';\n(function()')
edit('nodes/hermes.html', '''            jobTimeout: { value: 1200, validate: v => numeric(v, 1, 86400) },
            requestTimeout: { value: 30, validate: v => numeric(v, 1, 3600) },''', '''            jobTimeout: { value: 1200, validate: v => numeric(v, 1, 86400) },
            asyncRequestTimeout: { value: undefined, validate: v => v === undefined || numeric(v, 1, 3600) },
            requestTimeout: { value: undefined }, // legacy import compatibility''')
edit('nodes/hermes.html', '''        label: function() { return this.name || 'Shared Hermes FIFO'; }''', '''        label: function() { return this.name || 'Shared Hermes FIFO'; },
        oneditprepare: function() {
            $('#node-config-input-asyncRequestTimeout').val(this.asyncRequestTimeout ?? this.requestTimeout ?? 30);
        },
        oneditsave: function() { delete this.requestTimeout; }''')
edit('nodes/hermes.html', "clientProperty: { value: '' }, authorIdProperty: { value: '' }, authorNameProperty: { value: '' },", "clientProperty: { value: '' }, authorIdProperty: { value: '' }, authorNameProperty: { value: '' }, authorIsBotProperty: { value: '' },")
edit('nodes/hermes.html', '''<label for="node-config-input-requestTimeout">Async HTTP wait</label><input type="number" id="node-config-input-requestTimeout"''', '''<label for="node-config-input-asyncRequestTimeout">Async HTTP wait</label><input type="number" id="node-config-input-asyncRequestTimeout"''')
edit('nodes/hermes.html', '''    <div class="form-row"><label for="node-input-contextProperty">Context property</label>''', '''    <div class="form-row"><label for="node-input-authorIsBotProperty">Author bot flag</label><input type="text" id="node-input-authorIsBotProperty" placeholder="Optional boolean msg property"></div>
    <div class="form-row"><label for="node-input-contextProperty">Context property</label>''')
edit('nodes/hermes.html', '''The selected profile is not automatically a model ID. Final answer output''', '''The selected profile is not automatically a model ID. In Sync mode, a bare model override requires Hermes gateway.platforms.api_server.direct_model_requests: true (unless it matches a server-defined model route). Async Runs honors a supplied model. Final answer output''')

# Keep the existing help detail, adding the standard property and port markup.
def dl(items):
    return '<dl class="message-properties">' + ''.join(
        f'<dt>{name} <span class="property-type">{kind}</span></dt><dd>{desc}</dd>'
        for name, kind, desc in items) + '</dl>'

inputs = {
    'hermes-prepare': [('payload', 'string', 'Input text, or the configured input property.'), ('hermes', 'object', 'Optional existing request fields; mapped properties override only their corresponding fields.')],
    'hermes-agent': [('payload', 'string', 'User prompt, unless overridden by msg.hermes.input or the input-property setting.'), ('hermes', 'object', 'Optional input, clientId, sessionId, sessionKey, author, context, instructions, history, mode and model.')],
    'hermes-control': [('hermesControl', 'object', 'For From message mode: action; optionally requestId or the explicitly enabled force flag.')]
}
outputs = {
    'hermes-prepare': dl([('hermes', 'object', 'Mapped input, client identity, author, context and instructions. Other routing properties are preserved.')]),
    'hermes-agent': '<ol class="node-ports">' + ''.join('<li>' + name + dl(props) + '</li>' for name, props in [
        ('Final answer', [('payload', 'string', 'Complete, untruncated final answer.'), ('hermes', 'object', 'Status, request/run/session IDs, duration, usage and runtime metadata.')]),
        ('Lifecycle events', [('payload', 'null', 'Not an answer.'), ('hermes', 'object', 'State transitions and correlation IDs.')]),
        ('Errors', [('payload', 'null', 'No successful answer.'), ('hermes.error', 'object', 'Sanitized code, message, statusCode, retryable and remoteUnknown fields.')])]) + '</ol>',
    'hermes-control': '<ol class="node-ports"><li>Control result' + dl([('payload', 'object', 'Queue snapshot or action result.'), ('hermesControl', 'object', 'Action and ok: true.')]) + '</li><li>Errors' + dl([('payload', 'null', 'No successful control result.'), ('hermesControl.error', 'object', 'Sanitized error details.')]) + '</li></ol>'
}
extra = {
    'hermes-connection': '<p>Connection HTTP timeout is the client default. Async queue operations use the separate Async HTTP wait, bounded by the run deadline; Sync waits up to the run deadline.</p>',
    'hermes-queue': '<p>Async HTTP wait is stored as asyncRequestTimeout; legacy requestTimeout imports remain supported. It bounds each async admission or status call, not the total run time.</p>',
    'hermes-prepare': '<p>Author bot flag maps a boolean property. With no bot-flag mapping, an existing author.is_bot value is preserved; new authors default to false. Attribution is not authorization.</p>',
    'hermes-agent': '<p>Sync model overrides require gateway.platforms.api_server.direct_model_requests: true unless selecting a configured server model route. Async Runs honors the model field. This client does not enable that server setting or select a provider for you.</p><p>sessionKey is a stable memory-scope header used by Honcho independently of transcript IDs. Use distinct keys per client when separate Honcho scopes are intended; a shared key can share that scope. This does not itself partition a statically configured Hindsight bank or authenticate a sender.</p>',
    'hermes-control': '<p>Error output and a scoped Catch both report a failure; wire one notification path to avoid duplicate application alerts. A non-force reset retains the active slot until termination is confirmed, or pauses the queue if it cannot be confirmed.</p>'
}
p = Path('nodes/hermes.html')
s = p.read_text()
for name in ['hermes-connection', 'hermes-queue', 'hermes-prepare', 'hermes-agent', 'hermes-control']:
    pattern = r'(<script type="text/html" data-help-name="' + re.escape(name) + r'">)([\s\S]*?)(</script>)'
    def replace_help(match, name=name):
        original = match.group(2).strip()
        first = re.match(r'<p>[\s\S]*?</p>', original)
        assert first
        summary, detail = first.group(0), original[first.end():]
        sections = ''
        if name in inputs:
            sections = '\n<h3>Inputs</h3>\n' + dl(inputs[name]) + '\n<h3>Outputs</h3>\n' + outputs[name]
        refs = '<ul><li><a href="https://github.com/PhiKapJames/Node-red-Hermes-Agent">Package documentation</a></li><li><a href="https://github.com/NousResearch/hermes-agent/blob/v0.21.6/website/docs/user-guide/features/api-server.md">Hermes API contract</a></li></ul>'
        return match.group(1) + '\n' + summary + sections + '\n<h3>Details</h3>\n' + detail + extra[name] + '\n<h3>References</h3>\n' + refs + '\n' + match.group(3)
    s, count = re.subn(pattern, replace_help, s)
    assert count == 1
p.write_text(s)

p = Path('README.md')
s = p.read_text().replace('PhiKapJames/Node-red-Hermes-Agent-Async', 'PhiKapJames/Node-red-Hermes-Agent')
s = s.replace('Or install the implementation branch directly while the pull request is under review:', 'Or install the repository directly after the review fixes are merged:')
s = s.replace('#feat/transport-agnostic-hermes-nodes', '#main')
s = s.replace('| `sessionKey` | Optional `X-Hermes-Session-Key`; no memory-partition guarantee is implied. |', '| `sessionKey` | Optional stable `X-Hermes-Session-Key`, independent of the transcript ID. Honcho uses it for memory scoping: use a distinct key per client when separate scopes are intended; a shared key can share that scope. Other memory providers depend on their own configuration. |')
s = s.replace('| `model` | Explicit underlying model override; honored only when enabled in Agent settings. |', '| `model` | Per-message model override; accepted only when enabled in Agent settings. Async honors it. Sync also requires the Hermes server setting described below (unless selecting a server-defined model route). |')
s = s.replace('The optional Prepare node maps arbitrary message properties into this contract.', 'The optional Prepare node maps arbitrary message properties into this contract. Its optional **Author bot flag property** maps a boolean to `author.is_bot`; otherwise a previously supplied flag is preserved. Omitted flags default to false. String values such as `"false"` are rejected rather than coerced.')
s = s.replace('Model is omitted by default on both APIs.', '''### Sync model-override prerequisite

On Hermes v0.21.6, a bare `model` on `/v1/chat/completions` is ignored unless `gateway.platforms.api_server.direct_model_requests: true`, except when it selects a configured `model_routes` alias. `/v1/runs` honors a supplied model. The Agent's local override checkbox does not enable this server setting. Leave Model blank to keep using the profile default, or configure the server deliberately; the client does not add a provider or alter credentials.

`sessionKey` is forwarded as `X-Hermes-Session-Key`. Honcho uses it to maintain a stable memory scope independently of transcript resets. Two clients given the same key can share that scope; assign distinct application-managed keys when separation is intended. This header alone does not isolate a statically configured Hindsight bank and is not an authorization mechanism.

Model is omitted by default on both APIs.''')
s = s.replace('The optional minimum start interval defaults to zero and applies globally within that queue.', 'The optional minimum start interval defaults to zero and applies globally within that queue. **Async HTTP wait** (`asyncRequestTimeout`) bounds individual admission/status requests; **Run deadline** bounds the overall job. The Connection timeout is the client default; Sync uses the run deadline. Legacy Queue `requestTimeout` imports remain supported and migrate on editor save.')
s = s.replace('Errors also trigger a scoped Catch node;', 'Errors are passed to Node-RED through `done(error)` and also trigger a scoped Catch node;')
s = s.replace('The fast suite uses Node\'s built-in test runner and localhost HTTP fixtures.', 'The fast suite uses Node\'s built-in test runner and localhost HTTP fixtures. `npm run check` includes syntax checks and ESLint for runtime code, tests, and the editor script embedded in `nodes/hermes.html`. ESLint is development-only; the package still has no runtime npm dependencies.')
s += '\n\nReview disposition and intentionally deferred release decisions are recorded in [docs/review-disposition.md](docs/review-disposition.md).\n'
p.write_text(s)

p = Path('examples/sync-and-async.json')
examples = json.loads(p.read_text())
for node in examples:
    if node['type'] == 'hermes-queue':
        node['asyncRequestTimeout'] = node.pop('requestTimeout')
    if node['type'] == 'hermes-prepare':
        node['authorIsBotProperty'] = ''
    if node['type'] == 'inject':
        for prop in node.get('props', []):
            if prop['p'] == 'payload':
                prop['vt'] = node['payloadType']
p.write_text(json.dumps(examples, indent=2) + '\n')

p = Path('CHANGELOG.md')
s = p.read_text().replace('## 0.1.0', '''## 0.1.0 review corrections

Correct canonical repository links and model-override/memory-scope documentation. Preserve and optionally map author bot flags, migrate the Queue async-request timeout setting compatibly, support more than ten shared Agent listeners, and use traced Node-RED done(error) handling without duplicate Catch notifications. Add standard node help sections, development-only ESLint, review regressions, and CI concurrency with one package artifact. Non-force reset retains its cancellation barrier; new tests protect it. No application-specific policies or memory configuration changes are introduced.

## 0.1.0''', 1)
p.write_text(s)
Path('.github/workflows/test.yml').write_text(Path('.review/test-workflow.yml').read_text())
print('Applied review changes; lockfile and test validation follow.')
