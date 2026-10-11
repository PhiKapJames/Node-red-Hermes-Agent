# Review follow-up disposition

Basis: the supplied review of PR #1 at `a7dbf54`, checked against the implementation and the Hermes v0.21.6 contract. The old PR is now merged; these corrections are a separate follow-up. No application-specific adapter policies were added.

| Finding | Disposition |
| --- | --- |
| 1. Renamed repository links | Fixed package repository/bugs/homepage, README installation URL, and canonical help links. |
| 2. Sync model override | Accepted documentation option (a): README and editor/help explicitly describe `gateway.platforms.api_server.direct_model_requests: true`, server-route exceptions, and the async distinction. Did not add automatic provider switching or widen credentials. |
| 3. sessionKey semantics | Clarified Honcho's stable memory scope, the risk of sharing a key across clients, and its independence from transcript resets. Retained the necessary caveat that a static Hindsight bank is not partitioned merely by forwarding this header. |
| 4. Non-force reset overlap | The alleged race is not present in the reviewed baseline: `cancelJob(..., false)` retains `active`; `kick()` refuses while active; `execute()` confirms termination or pauses on uncertainty. Added explicit regression coverage for a queued follow-up while the old run remains remote-running, plus an explanatory invariant comment. Force reset intentionally remains unsafe and opt-in. |
| 5. Help structure | Added Inputs/Outputs/Details/References and message-property/port lists. Configuration nodes have no message ports, so their help uses Details/References rather than inventing inputs/outputs. |
| 6. Linting | Added pinned development-only ESLint, recommended checks, unused-variable and strict-mode checks, equality checking, and linting of the embedded editor script. Nullish equality and deliberate HTTP control-character regexes are intentional exceptions. No runtime dependencies added. |
| 7. Shared listener ceiling | Removed the per-queue listener ceiling; Agent close handlers still remove listeners. Added coverage for many shared listeners. |
| 8. Scoped npm name | Deferred naming/publishing decision. Retained the existing installable package name rather than making an unrequested rename. New public publication should follow Node-RED scoped-name guidance. |
| 9. Anti-pattern test | The supplied row is truncated after the regex fragment. No complete actionable defect can be inferred. Retained the useful application-policy boundary regression; the entire test suite is now linted. |
| 10. Bot author mapping | Preserve existing author fields and bot flag, support an optional boolean bot-flag property, and reject nonboolean flags instead of silently coercing them. |
| 11. Timeout property naming | Queue now uses `asyncRequestTimeout`, with compatibility for old `requestTimeout` imports and editor-save migration. Connection retains its distinct default timeout. |
| 12. Error idiom | Use sanitized `done(error)` with message correlation, without also calling `node.error` for the same failure. Dedicated error outputs remain; tests check one Catch event, not duplicate notifications. |
| 13. Release tag | Deferred release/tagging and npm publication; merging source is not publishing a release. |
| 14. CI concurrency/artifacts | Cancel superseded runs; preserve both runtime test combinations; package/upload once. |
| 15. Inject examples | Add explicit payload type in props while keeping the compatible top-level payload/payloadType used by Inject. Do not remove working fields. |
| 16. Author/i18n | Add package author. Internationalization remains outside this correction scope. |

## References

- [Hermes v0.21.6 API server](https://github.com/NousResearch/hermes-agent/blob/v0.21.6/website/docs/user-guide/features/api-server.md)
- [Node-RED input error handling](https://nodered.org/docs/creating-nodes/node-js)
- [Node-RED help structure](https://nodered.org/docs/creating-nodes/help-style-guide)
- [Node-RED packaging and scoped names](https://nodered.org/docs/creating-nodes/packaging)

Validation uses mock Hermes services and actual Node-RED runtimes in CI; it is not a deployment to Home Assistant or a live Hermes test. Queue persistence, transport-specific formatting, and server-side tool/memory permissions are unchanged.
