'use strict';
const js = require('@eslint/js');
const globals = require('globals');
module.exports = [
    { ignores: ['node_modules/**', 'coverage/**', '.review/**'] },
    js.configs.recommended,
    {
        files: ['**/*.js', '**/*.cjs'],
        languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: globals.node },
        rules: {
            strict: ['error', 'global'],
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
            // These patterns deliberately validate and scrub HTTP control characters.
            'no-control-regex': 'off'
        }
    },
    {
        files: ['nodes/hermes.editor.js'],
        languageOptions: { sourceType: 'script', globals: { ...globals.browser, RED: 'readonly', $: 'readonly' } }
    }
];
