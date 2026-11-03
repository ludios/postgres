# Logging audit: where an operator would want a log line

Auditors: Claude Mythos 5.1 and GPT-6 Astra (through `codex exec`, reasoning effort xhigh), each reading all of `src/` independently, on 2026-11-02, at commit `33aa4bd` on `prime`.

Today the library has no logging. Its only output is four bare `console.*` calls: the default `onnotice` in `src/connection.ts` and in `src/startup.ts`, the logical-replication error fallback in `src/subscribe.ts` (used when no subscriber has an `onerror` handler), and the `timeout` deprecation message in `src/index.ts`. Both auditors were asked to mark, as comments in a scratch copy of the tree, every place where an on-call operator running an application on this library would want a log line, with the level and the context fields, and also to mark the places that must not be logged.

## What is here

- [logging-audit.patch](logging-audit.patch): the 485 comments (157 `// XXX(claude): …` and 328 `// XXX(astra): …`) as one diff against `33aa4bd`, covering all 15 files in `src/`. It adds only comment lines; the code is unchanged, and `tsc` still passed with it applied. Where both auditors marked the same line, both comments are kept, Claude's first.
- [Claude's cross-cutting notes](#claudes-cross-cutting-notes) and [Astra's summary](#astras-summary): what does not fit at a single site.
- [The task given to Astra](#the-task-given-to-astra): the prompt, so that the audit can be repeated on a later tree.
- The four bugs found during Claude's read are in [mythos.md](mythos.md).

## Reading the comments in context

The patch applies cleanly to `33aa4bd` only. The later rework of `src/` (renames, strict types) changed most of the surrounding lines, so on later commits every hunk fails, and `git apply --3way` leaves conflicts in every file. Read it in a scratch clone at that commit, from the repository's top directory:

	git clone --shared . /tmp/logging-audit
	git -C /tmp/logging-audit checkout 33aa4bd
	git -C /tmp/logging-audit apply "$PWD/ai-code-reviews/logging-audit.patch"

then search that clone for `XXX(`.

## How the two passes compare

What the operator is blind to today, as both passes see it: connection retries and backoff (the pool retries forever, silently), startup rejections (`28P01`, `28000`, `3D000`, `53300`), unexpected connection loss and how many queries it failed, pool exhaustion, swallowed exceptions from `onnotify`, `onnotice` and `onparameter`, the silent plaintext downgrade with `ssl=prefer|allow`, `ssl=require|prefer|allow` never verifying the certificate, LISTEN and replication reconnects, `fetch_types` failures treated as success, and `reserve()` leases held forever.

Where Astra went further than Claude: detached promise chains whose rejections nobody sees (the `connect().then(opened, failed)` chain, the type-loading continuation, `AbortSignal` cancellation), `sql.file()` read failures, a large-object pass with byte accounting, protocol-level warnings about large frames being buffered, and a long list of explicit "do not log X" markers (Bind payloads, `BackendKeyData`, `Result.state`, whole `PostgresError` objects, since `detail`, `where` and `internal_query` can carry row values).

Two design questions that the passes answer differently, for whoever designs the logging layer:

- Query text. Claude treats SQL text truncated to about 200 characters as safe to log by default. Astra says SQL text should be opt-in, and redacted before truncation, because literals in `unsafe()` queries carry data.
- Transport. Claude suggests a sink that subscribes to the existing `postgres:*` diagnostics channels, so that most lines cost nothing on the hot paths. Astra argues that logging should not depend on `diagnostics_channel` subscribers.

## Claude's cross-cutting notes

The `// XXX(claude): log ...` comments in [logging-audit.patch](logging-audit.patch) mark every
place where an on-call operator running an application on this library would want a log
line. This section holds what does not fit at a single site.

### Where the gaps are today

Today the library emits nothing except four `console.*` calls. The silent events that
hurt an operator most, in rough order:

1. **Connection retries** (`pool.ts attempted/grow`): the pool retries forever with backoff
   and nobody is told. An app with a wrong password or an unreachable host just gets slow,
   then `CONNECT_TIMEOUT` errors on some queries.
2. **Startup rejections** (`startup.ts frame`, type `E`): `28P01`, `28000`, `3D000`,
   `53300`, `57P03` only reach whichever query triggered the connect.
3. **Unexpected connection loss** (`connection.ts onclose`, `pool.ts onclose`): FATAL
   `57P01` (admin shutdown), `57P05` (idle session timeout), `ECONNRESET`, and how many
   in-flight queries were failed by it.
4. **Pool exhaustion** (`pool.ts place`): queries queue silently until `queue_timeout`
   (default 0 = forever).
5. **Swallowed callback errors** (`connection.ts guard`): `onnotify`, `onnotice`,
   `onparameter` throwing is a `noop`.
6. **Silent TLS downgrade** (`startup.ts negotiate`, `cf.ts`): `ssl=prefer|allow` falls
   back to plaintext when the server refuses; and `ssl=require|prefer|allow` never verify
   the certificate (`rejectUnauthorized: false`).
7. **LISTEN and logical-replication reconnects** (`index.ts relisten`,
   `subscribe.ts restart`): retried silently and unbounded.
8. **Types fetch failing** (`pool.ts loadTypes`): a `PostgresError` is treated as success.
9. **Prepared-statement recoveries** (`connection.ts failed`): `42P05`, `26000`, cached-plan
   retries happen silently; the first two indicate a pooler or `DISCARD ALL` in the path.
10. **Leases held forever** (`pool.ts grant`): a `reserve()` without `release()` starves the
    pool with no symptom but slowness.

### Use the diagnostics channels first

`diagnostics.ts` already publishes `postgres:query`, `postgres:connect`,
`postgres:transaction`, `postgres:pool` and `postgres:notice` with most of the context a
log line needs (query text, queued/sent/first-byte/complete timestamps, connection id,
host, outcome, pool stats). A built-in logging sink could subscribe to those channels and
produce the "query failed", "slow query", "connected", "transaction rolled back",
"pool exhausted" and "notice" lines without touching the hot paths. Direct log calls are
only needed where no channel exists (items 1, 5, 6, 7, 8, 9, 10 above, plus idle/lifetime
closes, pool end/destroy, cancel, COPY lifecycle).

### Context to bind once, not per line

Per pool (`postgres()` call): hosts, database, user, application_name.
Per connection: connection id, host:port or path, backend pid, tls on/off.
Per query (when logged): statement name, text truncated to ~200 chars, parameter count.

### Levels

- error: the library could not do what the app asked and the app may not find out
  (connection lost with queries in flight, startup rejected, SCRAM mismatch, stream error
  with no handler, exception in a message handler).
- warn: something an operator should act on but the app keeps working (retrying connects,
  pool exhausted, TLS downgrade or unverified cert, lease released mid-transaction, cleartext
  password requested, statement-cache thrash, large result, slow cursor callback, COPY
  aborted, listen/replication reconnect).
- info: lifecycle milestones at a rate a human can read (effective config once, connection
  opened/closed, recovered after retries, transaction prepared, replication slot created,
  pool ending/ended, server parameter changed, re-listened).
- debug: one line per routine decision (opening a connection and why, idle close, retire,
  lease granted/released, cancel sent, types fetched, COPY started/finished, auth method).
- trace: per message or per query (query sent, notification received, keepalive, socket
  backpressure, StartupMessage contents).

### Never log

- Passwords, `.pgpass` contents, SCRAM nonces/proofs/keys/salted passwords, the cancel secret.
- Query parameter values (`q.args`, `built.values`) unless `options.debug` is set; they
  carry PII and credentials routinely.
- NOTIFY payloads at anything above trace (user data); log the length.
- Full query text for huge queries: truncate.

### Rate limiting

"pool exhausted", "statement cache evicting", "fail-fast rejecting", "COPY consumer not
reading" and "socket send buffer full" fire per event and must be edge-triggered or
rate-limited (once per state change, or N per minute with a suppressed count), or they
drown everything else exactly when the operator needs the log.

### Better as metrics than logs

Pool stats (`pool.stats`), queue length and wait time, connection open/close counts, retry
counts, replication lag (`received - acked`), evictions per minute, query latency
histograms. A log line at each change is too noisy; expose a gauge/counter hook, or emit
on the `postgres:pool` channel and let the app's metrics layer subscribe.

### Behavioural bugs found while reading

The four bugs are in [mythos.md](mythos.md).

## Astra's summary

Added **328 annotations across all 15 source files**, including replacements for all four console calls. Verified that removing the annotations restores every original byte. No tests, installs, or commits.

[src/build.ts](../src/build.ts)

- **warn:** Parameter limit, undefined parameters, empty SQL helpers, incorrectly awaited fragments.
- **Do not log:** Builder inputs or parameter values.

[src/cf.ts](../src/cf.ts)

- **debug:** Workers socket opening, TLS upgrade, first-response state, unavailable keepalive.
- **warn/error:** Unsupported direct TLS, plaintext fallback, required-TLS refusal, negotiation EOF.
- **trace:** Write backpressure and drain.
- **debug/warn/error:** Read/write failures, ignored close failures, detached read-task failure, early TLS closure.
- **Do not log:** Socket payloads.

[src/connection.ts](../src/connection.ts)

- **debug:** Graceful close, termination, destruction, recorded close reasons.
- **warn/error:** Unexpected EOF, socket/server failures, lost work, unsolicited server errors.
- **debug/trace:** Query blocking, encoding failures, simple protocol, descriptions, preparation, cache hits, eviction, invalidation.
- **warn:** Prepared-statement retries and server cancellation, including `statement_timeout`.
- **error:** Protocol processing failures and automatic rollback of unreserved transactions.
- **debug/trace:** Cursor start, batches, consumer closure, portal closure, completion.
- **warn:** Cursor callback failures, discarded late failures, cursors outliving transactions.
- **warn/debug:** Buffered-result thresholds and completion totals.
- **debug/warn:** COPY start, completion, abort, discarded output.
- **trace:** COPY backpressure and recovery; received notifications.
- **info/warn/debug:** Severity-mapped notices replacing `console.log`.
- **debug/warn:** Session parameter changes, callback failures, decoder compilation fallback.
- **Do not log:** Rows, parameter values, COPY chunks, diagnostic parameter arrays.

[src/diagnostics.ts](../src/diagnostics.ts)

- **debug:** Missing tracing support and failed channel creation.
- **Do not log:** Whole diagnostic contexts or results; synchronous dispatch completion must not imply operation completion.

[src/errors.ts](../src/errors.ts)

- **Do not log:** Whole serialized errors, query arguments, parameters, or errors merely being constructed.
- **debug, at most once:** Stack-location capability fallback.

[src/index.ts](../src/index.ts)

- **error:** Incompatible type-discovery options, SQL-file read failures, unsupported connection options.
- **debug:** Transaction begin, savepoints, explicit rollback, preparation, control-command outcomes.
- **warn/error:** Callback-triggered rollback, secondary rollback failures, late failures, incompatible nested modes, unexpected server rollback.
- **info:** Client shutdown, including auxiliary connections.
- **debug:** LISTEN registration, activation, removal, UNLISTEN, listener shutdown.
- **warn/info:** Dedicated listener loss, re-listen retries, restored subscriptions and notification gaps.
- **warn/error:** Listener callbacks, initial LISTEN failures, ignored UNLISTEN connection errors.
- **trace:** Sent notifications without payloads.
- **warn:** Deprecated `timeout`, replacing `console.log`.
- **debug:** Effective options, environment/URL provenance, startup settings, identity/path/decoding fallbacks.
- **Do not log:** Raw URLs, environment/options objects, credentials, or unexecuted unsafe fragments.

[src/large.ts](../src/large.ts)

- **debug:** Object creation, opening, closing, truncation, stream lifecycle.
- **warn:** Open objects retaining transactions beyond a threshold.
- **trace:** Read-stream backpressure.
- **error:** Read/write failures and transaction failures after returning the handle.
- **Do not log:** Binary object contents.

[src/pool.ts](../src/pool.ts)

- **info/debug:** Connection creation, accepted connections, removal, recovery, replacement.
- **warn/info:** Capacity exhaustion, queue growth, wait timeout, backlog recovery.
- **debug/trace:** Wait duration, protocol selection, scheduler routing.
- **warn/error:** Fail-fast rejection, reconnect backoff, exhausted connection budgets, unavailable COPY capacity.
- **debug/warn/error:** Type discovery, partial fallback, cooldown, retries, failed completion tasks.
- **debug/warn:** Lifetime retirement, idle reaping, leases, long-held leases, released connections retaining transactions.
- **error:** Lost leased connections and detached lifecycle failures.
- **info/warn:** Pool close/end, shutdown deadlines, rejected outstanding work, final shutdown outcome.
- **debug:** Shared statement allocation, eviction, cache clearing, queued cancellation.
- **Do not log routinely:** Every cache lookup or pool state update; prefer metrics.

[src/protocol.ts](../src/protocol.ts)

- **warn:** Large outgoing buffers and incoming frame allocations.
- **error:** Invalid frame lengths, missing protocol error handlers, NUL-containing startup parameters.
- **Do not log:** Authentication frames, cancellation secrets, Bind values, unrestricted server error fields.

[src/query.ts](../src/query.ts)

- **trace/debug:** Execution requests, ordinary completion, cancellation requests, iterator closure.
- **error:** Final query and cursor failures.
- **warn:** Slow queries and failed detached AbortSignal cancellation.
- **Do not log:** Inspected Query objects or duplicate diagnostic-build failures.
- **Completion caveats:** COPY handle resolution is not stream completion; missing call-site stacks need, at most, one debug event.

[src/result.ts](../src/result.ts)

- **Do not log:** Whole results, statement descriptors, or backend state containing cancellation secrets.

[src/socket.ts](../src/socket.ts)

- **debug:** Provider selection, transport connection, TLS context rebuilds, keepalive, socket errors and closure.
- **warn:** Disabled certificate verification.
- **debug/error:** TLS handshake start, negotiated properties, handshake failure.
- **Do not log:** Raw buffers or TLS key material.

[src/startup.ts](../src/startup.ts)

- **debug/info:** Candidate attempts, target-session rejection, standby-preference fallback, startup completion.
- **warn/error:** Connect timeout, startup closure/failure, exhausted candidates, server rejection.
- **debug/warn/error:** TLS negotiation, bypass, plaintext fallback, required-TLS refusal.
- **debug/error:** Authentication method, SCRAM selection, acceptance, provider failures, unsupported methods, binding failures.
- **warn:** Cleartext authentication over plaintext.
- **debug:** Interesting ParameterStatus values, backend pid, session-attribute probing.
- **info/warn/debug:** Startup notices replacing `console.log`; callback failures.
- **debug/warn:** Cancellation transport lifecycle and negotiation failure.
- **debug/warn:** Certificate-binding fallback and password-file availability, permissions, matching.
- **Do not log:** Startup packets, passwords, SCRAM material, cancellation secrets, duplicate authentication rejection.

[src/subscribe.ts](../src/subscribe.ts)

- **info:** Slot creation/reuse, replication start/stop, shutdown, restored subscriptions.
- **debug:** Subscriber registration/removal, relation metadata, ignored message types.
- **warn:** Connection loss, reconnect backoff, unexpected stream closure, callback failures.
- **error:** Stream/parser failures, subscriber failures, rejected background tasks, failing error handlers.
- **warn:** Persistent-slot replay, stalled acknowledgements, ignored shutdown failures.
- **trace:** Keepalives, transaction boundaries, acknowledgements, callback backpressure and recovery.
- **error:** Missing `onerror` fallback replacing `console.error`.
- **Do not log:** WAL payloads, rows, row-key filters, backend secrets, duplicate startup rejection.

[src/types.ts](../src/types.ts)

- **debug/trace:** Parser/serializer fallback, catalog mappings, named-type resolution.
- **error:** Missing configured types.
- **warn:** Undefined array elements.
- **Do not log:** Array, date, JSON, or other decoding inputs.

### Cross-cutting notes

- Bind client/pool role, connection identity, backend pid, endpoint, database, user, and actual TLS policy once. Add attempt, query, transaction, and stream identifiers where needed.
- Centralize sanitized outcome logging. Several annotations describe context enrichment or alternative emission points; emitting all of them independently would duplicate failures.
- Keep logging independent of diagnostics subscribers. Distinguish pool wait, pipeline wait, network/service time, and consumer delay; client timing cannot isolate server execution precisely.
- Use metrics for queue depth, latency, cache effectiveness, throughput, buffer sizes, and replication lag. Rate-limit recurring failures and log recovery.
- SQL text should require explicit opt-in and redaction before truncation. Error messages, identifiers, and callback exceptions can also contain sensitive data.
- Preserve notice callback/suppression semantics deliberately. The application should own logging configuration.
- Cancellation delivery, COPY handle resolution, transaction outcome, and replication acknowledgement are distinct events. Persistent replication can replay successful callbacks; temporary replication can lose changes during disconnection.

## The task given to Astra

Claude wrote this prompt for Astra and did the same task itself. Verbatim:

You are auditing a copy of ludios/postgres, a fork of porsager/postgres (a PostgreSQL client library for Node.js, Bun and Cloudflare Workers). This copy lives in a throwaway /tmp directory; nothing you do here will be committed anywhere.

Today the library has no logging at all: zero runtime dependencies, and the only output is four bare `console.*` calls (default `onnotice` in src/connection.ts and src/startup.ts, a logical-replication error fallback in src/subscribe.ts, and a `timeout` deprecation message in src/index.ts). We are considering adding real logging (probably via LogTape, which is silent unless the application configures it).

Your task: read all of `src/` and think hard, as an experienced SRE / on-call operator who runs applications built on this library, about every event that such an operator would want a log line for. Then annotate the source in place by adding comments, and nothing else.

Comment format, one per place, placed on its own line immediately above the statement it refers to:

	// XXX(astra): log <level> <what to say> [if <condition>] [with <context fields>]

Examples of the style:

	// XXX(astra): log info "connected" with connection id, host:port, database, user, backend pid, tls on/off, elapsed ms
	// XXX(astra): log warn "pool exhausted; query queued" if queue length just became > 0, with max, queue length
	// XXX(astra): log error "server terminated connection unexpectedly" with connection id, last query text (truncated), error code

Levels: trace, debug, info, warn, error. Choose the level the operator would want by default, and say which context fields matter (connection id, backend pid, host:port, database, user, query text truncated to N chars, duration, error code / sqlstate, counts, option values).

Cover at least these areas, but do not limit yourself to them:

- connection lifecycle: connect attempts, success, failure and reason, DNS/socket errors, reconnect and backoff, closed by server vs by us, unexpected EOF, the reason a connection was closed;
- TLS: whether TLS was negotiated, refused by server, downgraded to plaintext, verification mode in effect;
- authentication: method requested by server (md5, scram, cleartext, etc.), failure;
- startup: ParameterStatus values of interest (server_version, client_encoding, standard_conforming_strings, timezone, application_name), BackendKeyData (pid/secret) for cancellation;
- pool: connection count changes, max reached, queue growth and drain, how long a query waited for a connection, idle reaping, max_lifetime recycling, pool ended / end() called while queries are in flight;
- timeouts: connect_timeout, idle_timeout, max_lifetime, statement_timeout / query cancellation, and anything that is silently retried;
- queries: slow queries (over a configurable threshold), queries that fail (sqlstate, position, truncated text), prepared statement cache behavior (prepare, evict, "cached plan must not change result type" style retries), unsafe/simple-protocol fallbacks, parameter count limits, large result sets;
- cursors and COPY: start, end, abort, backpressure;
- transactions: begin, commit, rollback, savepoints, rollback caused by an error inside the transaction callback;
- LISTEN/NOTIFY: listen, unlisten, notifications received (trace), re-listen after reconnect, the dedicated listen connection dying;
- logical replication / subscribe: slot creation, publication, stream start/stop, reconnect, parse errors in the stream, errors with no subscriber onerror handler;
- notices: NoticeResponse with severity, code, message (default handler today is console.log);
- options: deprecated options used, values derived from the environment (PG* variables, sslmode from URL, fetch_types), unsupported combinations;
- anything currently swallowed: empty catch blocks, errors only surfaced through optional callbacks, `.catch(() => {})`, fire-and-forget promises, places where an error is turned into a silent retry.
- anything in src/cf.ts (Cloudflare Workers socket shim), src/socket.ts, src/large.ts, src/diagnostics.ts that an operator would want to see.

Also mark each existing `console.*` call with a comment saying what it should become.

Rules:

- Only add comments. Do not change, move, reformat or delete any code. Do not add a `Model-output:` header line; this is a scratch copy.
- Do not run the tests, do not install anything, do not commit.
- Keep each comment to one or two lines. Be concrete: say what the message should say and what fields it should carry, not just "log here".
- Use tabs for indentation, matching the surrounding line.
- If you believe a place is tempting to log but should NOT be logged (too noisy, or would leak secrets like passwords, SCRAM nonces, or query parameters), add a comment saying `// XXX(astra): do not log ... because ...` so the reader knows it was considered.

When finished, output a summary grouped by file: for each file, a bullet list of the places you annotated with the level and a few words each. Then a short section "Cross-cutting notes" with anything you think the human designer of the logging layer must know (e.g. which context should be bound once per connection, which events are better exposed as metrics than logs, which messages risk leaking secrets).
