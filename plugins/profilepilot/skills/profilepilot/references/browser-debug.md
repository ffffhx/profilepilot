# Network, Console and performance inspection

Use the same owned `ppilot browser` session and selected connection. Both the
extension and Gateway routes support the commands below. Start capture before
the interaction: earlier traffic cannot be recovered. Queries do not invoke a model.
The extension route requires extension 0.2.14+ with the `debugCapture` capability.

```text
debug start
network requests --filter /api --type fetch,xhr --method POST --status 4xx --limit 50
network request REQUEST_ID --offset 0 --text-limit 16000
console --filter failed --level error
errors --since CURSOR
debug status
```

Filters combine with AND; resource types are comma-separated alternatives.
Status accepts `404`, `4xx`, or `400-599`; `--failed` includes network failures
and HTTP errors. Lists contain metadata, unique IDs, a cursor and `hasMore`.
Continue with `--since CURSOR`. Details include request/response headers and a
bounded text body; binary content is omitted from model output. Console objects
use CDP previews without invoking getters. Exceptions retain available stack
and source location. No error diagnosis or deduplication is inferred.

## Record response bodies before navigation

```text
network har start --content text
# Perform the intended page interaction in this same session.
network har stop "absolute path/requests.har"
```

HAR captures bodies at request completion, before CDP can evict them. `text`
captures text/JSON/XML/JavaScript; `all` also stores base64 binary bodies;
`none` excludes bodies. The default in-memory query list holds up to 2,000
requests and 16 MiB metadata; HAR has a separate limit of 5,000 entries and
16 MiB metadata. Bodies are limited to 2 MiB each and 32 MiB retained total.
Console/error lists are each limited to 1,000 entries and 4 MiB. Exports report
omitted entries, missing bodies, incomplete requests and interruption reasons.
Inspect these fields before claiming a complete recording.

`network clear` clears only the query list, preserving an active HAR recording.
DevTools' clear button and this tool's records are independent. Data remains in
the task process until cleared, evicted or ended; only an explicit HAR/trace
export writes an artifact. Export paths use exclusive creation and never
silently replace an existing file. HAR may contain the selected requests'
headers, request data and response bodies; choose the task's scope accordingly.

## Reproduce failures

```text
network route "*/api/example" --body '{"available":false}' --status 503
network route "*/api/example" --abort
network routes
network unroute "*/api/example"
```

URL patterns support `*` and `?`. Optional `--type` restricts resource types.
The newest matching route wins. `network unroute` without a pattern removes
all routes. These intercept requests from the selected tab and attached child
frames, not browser-wide traffic. Service Worker/cache paths that do not reach
the network may bypass interception. Use fresh requests when validating mocks.

## Performance and lifecycle

```text
profiler start
# Run the intended interaction.
profiler stop "absolute path/performance.json"
network har stop "absolute path/requests.har"
debug stop
```

`profiler` records Chrome performance trace events, capped at 32 MiB, with a
completion/truncation indicator. On Gateway, existing `trace start|stop` still
produces Playwright Trace ZIP; the extension uses `trace` as a profiler alias.
JSON params/file input can set `categories` on profiler start, route `headers`,
or the same query fields as CLI flags.

Cross-process iframe sessions are attached recursively and request/body reads
are routed to their originating CDP sessions. Capture belongs to one tab/task.
Changing tabs or losing control stops capture and marks active recordings as
interrupted. Do not automatically resume after takeover. After explicit return
of control, export any interrupted recording before starting a new one. Normal
navigation within the same tab preserves already captured data. Stop HAR and
profiler before `debug stop`, then complete the task session normally.
