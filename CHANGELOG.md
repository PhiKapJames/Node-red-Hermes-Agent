# Changelog

## 0.1.0 review corrections

Correct canonical repository links and model-override/memory-scope documentation. Preserve and optionally map author bot flags, migrate the Queue async-request timeout setting compatibly, support more than ten shared Agent listeners, and use traced Node-RED done(error) handling without duplicate Catch notifications. Add standard node help sections, development-only ESLint, review regressions, and CI concurrency with one package artifact. Non-force reset retains its cancellation barrier; new tests protect it. No application-specific policies or memory configuration changes are introduced.

## 0.1.0

Initial transport-independent implementation. Adds shared profile credentials and TLS, a generic request mapper, sync chat and async Runs, a bounded shared FIFO, per-client sessions, queue controls, idempotent async admission retries, explicit uncertainty handling, and three separate Agent outputs. Model defaults are left to Hermes. Replies are not truncated or split. Includes examples, unit/mock-server tests, and CI runtime integration tests for Node-RED 4 and 5.
