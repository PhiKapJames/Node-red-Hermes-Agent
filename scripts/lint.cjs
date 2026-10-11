'use strict';
const fs = require('node:fs/promises');
const { ESLint } = require('eslint');

async function main() {
    const eslint = new ESLint();
    const results = await eslint.lintFiles(['lib/**/*.js', 'nodes/**/*.js', 'test/**/*.js', 'scripts/**/*.cjs', 'eslint.config.cjs']);
    const html = await fs.readFile('nodes/hermes.html', 'utf8');
    const scripts = [...html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)];
    if (scripts.length !== 1) throw new Error('Expected exactly one editor JavaScript block.');
    results.push(...await eslint.lintText(scripts[0][1], { filePath: 'nodes/hermes.editor.js' }));
    const formatter = await eslint.loadFormatter('stylish');
    const report = formatter.format(results);
    if (report) console.log(report);
    if (results.some(result => result.errorCount || result.warningCount)) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
