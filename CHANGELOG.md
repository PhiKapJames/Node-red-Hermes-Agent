# Changelog

## 0.2.0 — Node-RED 5 and later only

Breaking release: require Node-RED 5.0.0+ and Node.js 22.9.0+. Remove Node-RED 4 support, runtime callback shims, and the previous Queue `requestTimeout` compatibility path; `asyncRequestTimeout` is the only Queue HTTP-wait setting (default 30 seconds), while the Connection `requestTimeout` remains unchanged. Simplify asynchronous queue promises using native `Promise.withResolvers()`, update the example Inject nodes to include fully typed `props[]`, and run the CI matrix exclusively on Node-RED 5 with Node.js 22/24. Existing transport-independent request contracts, credentials, session isolation, and reset/cancellation safeguards are retained. See the README for migration instructions; no Hermes server or radio-specific configuration changes are required.

## 0.1.0 review corrections

Correct canonical repository links and model-override/memory-scope documentation. Preserve and optionally map author bot flags, migrate the Queue async-request timeout setting compatibly, support more than ten shared Agent listeners, and use traced Node-RED done(error) handling without duplicate Catch notifications. Add standard node help sections, development-only ESLint, review regressions, and CI concurrency with one package artifact. Non-force reset retains its cancellation barrier; new tests protect it. No application-specific policies or memory configuration changes are introduced.

## 0.1.0

Initial transport-independent implementation. Adds shared profile credentials and TLS, a generic request mapper, sync chat and async Runs, a bounded shared FIFO, per-client sessions, queue controls, idempotent async admission retries, explicit uncertainty handling, and three separate Agent outputs. Model defaults are left to Hermes. Replies are not truncated or split. Includes examples, unit/mock-server tests, and CI runtime integration tests for Node-RED 4 and 5.
