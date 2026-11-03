# Wording review of the log lines

On 2026-11-03, before the log lines of src/log.ts and its callers were written, Claude Fable 5.1 drafted them as the catalog below and asked GPT-6 Astra (through `codex exec`, reasoning effort xhigh) and Claude Opus 5.5 to review the wording, the levels, the events missing for a restart, a reached connection limit, a slow server, and a full disk or a stuck server, and the noise. Both reviews follow the catalog, verbatim. The lines that shipped take from both; the differences from the catalog are in the commit that added them.

---

# Log lines for ludios/postgres: draft for wording review

## Context

- ludios/postgres is a fork of porsager/postgres, a PostgreSQL client for Node.js, Bun and
  Cloudflare Workers. TypeScript sources are in `src/` of the repository at
  /home/at/code/js/postgres (read it; do not modify it). The files that matter: pool.ts (the
  pool: connection attempts, retries with backoff, the queue of waiting queries, leases for
  transactions and reserve()), startup.ts (one connection attempt: socket, TLS negotiation,
  authentication, ParameterStatus), connection.ts (one open connection: the wire protocol,
  prepared statements, queries, COPY, notices, notifications, close), index.ts (options,
  transactions, LISTEN), subscribe.ts (logical replication), cf.ts (Cloudflare Workers socket).
- Logging is being added with LogTape (`@logtape/logtape`). A library logs to categories; the
  application chooses sinks and levels; unconfigured, nothing is printed. Levels: trace, debug,
  info, warning, error.
- Message templates: `logger.warn("connecting to {target} failed: {reason}", { target, reason })`.
  Placeholders are the record's properties: text sinks render them inline; JSON sinks keep them
  structured. So every value worth seeing must appear in the template.
- Style wanted by the maintainer: compact yet unambiguous, like exastash's lines (Rust `tracing`):
  `warn!(file_id, storage, "fetching bytes {fetched}..{end} failed, retrying in {delay:?}: {error:#}")`,
  `info!(cell_id, files_per_cell, files_in_cell, "marking fofs cell as full")`,
  `warn!(file_id, "refusing to open a file whose content failed its b3sum check")`,
  `info!("got SIGTERM, unmounting")`. Lower-case start, no trailing period, the error last after a
  colon. The repository's rule for English: "All new English must be maximally unambiguous, even
  if it becomes slightly longer. Think as a reader, and read the text every possible way."
- The operator conditions that matter most: PostgreSQL restarting; the server's connection limit
  reached (`53300 sorry, too many clients already`); PostgreSQL very slow; PostgreSQL's disk full
  or the server stuck (queries never answered).

## Conventions in the templates

- `{target}`: `user@host:port/database`, e.g. `app@db1:5432/shop`; over a Unix-domain socket
  `app@/run/postgresql/.s.PGSQL.5432/shop`. The internal pools that sql.listen() and
  sql.subscribe() open append ` (LISTEN)` or ` (replication)`. For a pool with several hosts, the
  pool-level lines show `app@db1:5432,db2:5432/shop`; connection-level lines show the one host.
- `{id}`: the connection's number; unique in the process (connection 1, 2, 3, ...).
- `{reason}`: a compact description of an error. A PostgreSQL error:
  `28P01 password authentication failed for user "app"`. A Node socket error:
  `connect ECONNREFUSED 127.0.0.1:5432`. This library's own errors: `CONNECT_TIMEOUT (db1:5432)`,
  `UNEXPECTED_MESSAGE: A DataRow came while nothing was in flight`. The Error object itself is
  also attached as the property `error` for structured sinks.
- `{text}`: the SQL text with whitespace collapsed, cut to 200 characters. Parameter values are
  never logged.
- Numbers are plain: milliseconds as integers, seconds with one decimal.

## The lines

Format: id. LEVEL category: when. Then the template, then an example as a text sink shows it.

### Pool: opening connections, retrying, the queue (category postgres.pool)

P1. WARNING pool: a connection attempt failed (all hosts tried once) and the pool will retry
after the backoff. Every failed attempt logs; the default backoff spaces attempts up to 20 s apart.
    `connecting to {target} failed, retrying in {delay} s ({retries} failed in a row): {reason}`
    > connecting to app@db1:5432/shop failed, retrying in 2.7 s (3 failed in a row): 53300 sorry, too many clients already
    > connecting to app@db1:5432/shop failed, retrying in 0.4 s (1 failed in a row): connect ECONNREFUSED 127.0.0.1:5432
    > connecting to app@db1:5432/shop failed, retrying in 0.9 s (2 failed in a row): 57P03 the database system is starting up

P1b. WARNING pool: same, but the pool is ending, so there is no retry.
    `connecting to {target} failed while the pool was ending: {reason}`

P2. INFO pool: a connection opened and it is the pool's only one (the first, or the first after
all were closed), or attempts had been failing. Other connections log the same at DEBUG.
    `connected to {target} in {ms} ms: connection {id}, backend pid {pid}, tls {tls}, auth {auth}`
    with a prefix when attempts had failed:
    `connected to {target} after {retries} failed attempts in {ms} ms: connection {id}, backend pid {pid}, tls {tls}, auth {auth}`
    {tls} is `verified`, `unverified` (ssl require/prefer/allow: encrypted, certificate not
    checked) or `off`; {auth} is `trust`, `cleartext`, `md5`, `scram-sha-256`, `scram-sha-256-plus`.
    > connected to app@db1:5432/shop in 41 ms: connection 1, backend pid 48213, tls verified, auth scram-sha-256-plus

P3. WARNING pool: the pool has been saturated for at least 1 s: every one of `max` connections is
busy (or still opening) and queries wait for one. Repeats every 10 s while it lasts. "waiting"
counts queries and also sql.begin()/sql.reserve() calls that wait for a connection.
    `pool for {target} saturated for {secs} s: all {max} connections busy, {waiting} waiting for one, the oldest for {oldest} s`
    > pool for app@db1:5432/shop saturated for 31.0 s: all 10 connections busy, 57 waiting for one, the oldest for 29.8 s

P4. INFO pool: the saturation ended (P3 had been logged at least once).
    `pool for {target} drained after {secs} s saturated`
    `pool for {target} drained after {secs} s saturated; {timed_out} waits timed out`
    > pool for app@db1:5432/shop drained after 44.2 s saturated; 12 waits timed out

P5. WARNING pool: a query (or begin/reserve) waited queue_timeout seconds for a connection and
was rejected with QUEUE_TIMEOUT. Logged for the first one of a saturation episode; the rest are
counted in P4.
    `a query waited {queue_timeout} s for a connection to {target} and was rejected (QUEUE_TIMEOUT); further such rejections are counted, not logged`

P6. WARNING pool: a query has been in flight (written to the server, no answer yet) for 10 s or
more; a watchdog checks every 10 s; repeats every 60 s for the same query. Not for COPY streams
and cursors. This is the line that shows a stuck server when the pool is not saturated.
    `query on connection {id} to {target} unanswered for {secs} s: {text}`
    > query on connection 4 to app@db1:5432/shop unanswered for 70.1 s: update orders set state = $1 where id = $2

P7. WARNING pool: fetching the array and domain types from pg_type failed with a server error;
the pool goes on; arrays of custom types and domains over them are returned as text.
    `fetching types from {target} failed; arrays of custom types stay unparsed: {reason}`

P8. WARNING pool: a custom type given by name does not exist on the server; queries fail with
TYPE_NOT_FOUND; the pool looks again on the next query after 1 s.
    `{reason}; queries to {target} fail until it exists, checked again after 1 s`
    > TYPE_NOT_FOUND: The type my_enum does not exist; queries to app@db1:5432/shop fail until it exists, checked again after 1 s

P9. INFO pool: sql.end() called.
    `pool for {target} ending: {connections} connections open, {inflight} queries in flight, {waiting} waiting for a connection`

P10. WARNING pool: sql.end({ timeout }) elapsed with work unfinished, so connections are
destroyed. DEBUG when nothing was in flight or waiting (then it is just the fast way to end).
    `pool for {target} did not end within {timeout} s; destroying {connections} connections with {inflight} queries in flight and {waiting} waiting`

P11. WARNING pool: the pool ended (or every connection attempt failed) while queries waited for a
connection; they are rejected with CONNECTION_ENDED.
    `pool for {target} ended with {waiting} waiting for a connection; rejected them (CONNECTION_ENDED)`

P12. DEBUG pool: the pool has ended.
    `pool for {target} ended`

P13. WARNING pool: a lease (transaction or reserve()) was released while its connection was still
in a transaction block (status T or E), so the connection is closed instead of reused.
    `connection {id} to {target} released by its {kind} with a transaction block open (status {status}); closing it`

P14. DEBUG pool: a server parameter's value became known or changed (ParameterStatus), e.g.
server_version, TimeZone, in_hot_standby after a failover.
    `{target} reports {name} = {value}`

P15. DEBUG pool (startup.ts): with several hosts, one host's attempt failed; the pool's P1 line
follows with the last host's error.
    `connecting to {host}:{port} failed: {reason}`

P16. INFO pool (startup.ts): a host answered but does not match target_session_attrs, so it is
closed and the next host tried.
    `{host}:{port} is {actual} but target_session_attrs is {wanted}; trying the next host`
    {actual}: `a standby`, `the primary`, `read-only`, `read-write`.

P17. WARNING pool (startup.ts and cf.ts): the server refused TLS and ssl is prefer or allow, so
the connection goes on unencrypted.
    `{host}:{port} refused TLS; connecting without encryption, as ssl "{mode}" allows`

P18. WARNING pool (startup.ts): the server asked for the password in cleartext over an unencrypted
connection. Once per pool.
    `{host}:{port} asks for the password in cleartext over an unencrypted connection`

P19. WARNING pool (startup.ts): the password file (PGPASSFILE or ~/.pgpass) is ignored because
other users can read it (libpq warns the same). Once per pool.
    `ignoring password file {file}: its mode {mode} lets other users read it; set it to 0600`

### Connection: close, protocol, handlers (category postgres.connection)

K1. DEBUG connection: a connection closed in an orderly way (Terminate sent, nothing in flight),
with the pool's reason: `idle for {idle_timeout} s`, `max_lifetime of {life} s reached`,
`pool ending`, `pool closed`, `released with a transaction block open`.
    `connection {id} to {target} closed: {why}`
    > connection 3 to app@db1:5432/shop closed: idle for 30 s

K2. WARNING or ERROR connection: the connection was lost: the server closed it, the socket
failed, or the socket closed without a word. ERROR when queries were in flight or the connection
was leased (work was lost), else WARNING. Variants by cause:
    server FATAL (e.g. restart, idle_session_timeout, idle_in_transaction_session_timeout):
    `server closed connection {id} to {target}: {reason}{impact}`
    > server closed connection 3 to app@db1:5432/shop: 57P01 terminating connection due to administrator command
    socket error:
    `connection {id} to {target} lost: {reason}{impact}`
    > connection 3 to app@db1:5432/shop lost: read ECONNRESET; 2 queries failed, transaction lost
    socket closed with no error (e.g. kill -9 of the server, a NAT dropped the connection):
    `connection {id} to {target} lost: the socket closed without an error{impact}`
    {impact} is empty, or `; {n} queries failed`, `; the transaction on it failed`,
    `; the reserved connection's queries fail`, combined: `; 2 queries failed and the transaction on it failed`.

K3. ERROR connection: this library closed the connection because of an unexpected message or a
broken frame (a protocol error, or a bug of this library).
    `closed connection {id} to {target} after a protocol error: {reason}{impact}`

K4. WARNING connection: the cancel request for a query timed out (connect_timeout), so the
connection is closed, because the request could still arrive and cancel a later query. K3's
line follows with the close.
    `cancel request for connection {id} to {target} timed out after {connect_timeout} s; closing the connection, because the request could still cancel a later query`

K5. WARNING connection: a cancel request could not be sent (other than K4).
    `cancel request for connection {id} to {target} failed, the query runs on: {reason}`

K6. WARNING connection: a user's handler threw; the error is swallowed so that the connection
goes on. {handler}: onnotify, onnotice, onparameter.
    `{handler} threw: {reason}`

K7. WARNING connection: a query outside sql.begin()/sql.reserve() left a transaction block open
on a pooled connection; the connection rolls it back and fails the queries with
UNSAFE_TRANSACTION.
    `a query left a transaction block open on pooled connection {id} to {target}; rolling it back (use sql.begin or sql.reserve for transactions)`

K8. WARNING connection: Parse failed with 42P05 (prepared statement already exists): something
shares server connections (a pooler in transaction mode?); the library retries under a new name.
    `prepared statement {name} already exists on connection {id} to {target}; retrying under another name (is a connection pooler sharing server connections?)`

K9. WARNING connection: 26000 (prepared statement does not exist) for a statement this
connection had prepared: DISCARD ALL or a pooler; prepared again.
    `prepared statement {name} is gone from connection {id} to {target} (DISCARD ALL, or a connection pooler?); preparing it again`

K10. DEBUG connection: a cached statement's shape changed (e.g. cached plan must not change
result type after a column was added); the query is retried once.
    `retrying a query on connection {id} after {reason}: re-describing statement {name}`

K11. DEBUG connection: a NOTIFY arrived (payload length only).
    `notification on channel {channel} from backend pid {pid} on connection {id} ({bytes} bytes of payload)`

K12. INFO connection: compiling row readers with new Function failed (a Content Security Policy
forbids it); rows are read by the generic reader from now on (slower). Once per process.
    `cannot compile row readers ({reason}); reading rows with the generic reader`

### Query: durations (category postgres.query)

Q1. DEBUG query: a query completed. {ms} from the write to the server's ReadyForQuery; {wait}
from the call to the write (time in the pool's queue, or behind other queries on the connection).
    `query on connection {id} took {ms} ms after {wait} ms waiting: {command} {count}: {text}`
    > query on connection 2 took 3 ms after 0 ms waiting: SELECT 1: select * from users where id = $1

Q2. DEBUG query: a query failed.
    `query on connection {id} failed after {ms} ms: {reason}: {text}`

Q3. WARNING query: a query took 1 s or more (completed or failed; not cursors). Same templates as
Q1/Q2 but prefixed `slow query`:
    `slow query on connection {id} took {ms} ms after {wait} ms waiting: {command} {count}: {text}`
    `slow query on connection {id} failed after {ms} ms: {reason}: {text}`

### Notices from the server (category postgres.notice)

N1. level by the notice's severity (WARNING → warning; NOTICE, INFO, LOG → info; DEBUG1..5 →
debug): a NoticeResponse, when the application gave no onnotice handler (the handler replaces
this line, as console.log did; onnotice: false silences both).
    `{severity} {code} on connection {id} to {target}: {message}` + `; detail: {detail}` + `; hint: {hint}` when present
    > NOTICE 00000 on connection 2 to app@db1:5432/shop: relation "events" already exists, skipping
    During startup (no connection id yet): `{severity} {code} from {host}:{port} during startup: {message}`

### LISTEN (category postgres.listen)

L1. DEBUG listen: LISTEN succeeded for a channel.
    `listening on channel {channel}`

L2. WARNING listen: the LISTEN connection closed; LISTEN is sent again for every channel on a new
connection. The connection's own K2 line says why it closed.
    `sending LISTEN again for {n} channels after their connection closed; notifications sent meanwhile are missed`

L3. INFO listen: a re-sent LISTEN succeeded.
    `listening on channel {channel} again`

L4. WARNING listen: a re-sent LISTEN failed; retried after the backoff.
    `LISTEN {channel} failed, retrying in {delay} s ({retries} failed in a row): {reason}`

L5. WARNING listen: a listener's onlisten callback threw while being told that the channel is
listening again.
    `onlisten of channel {channel} threw: {reason}`

L6. DEBUG listen: the last listener of a channel left; UNLISTEN sent.
    `unlistened channel {channel}`

### Logical replication (category postgres.subscribe)

B1. INFO subscribe: `created temporary replication slot {slot}` / `created replication slot {slot}` /
    `using existing replication slot {slot}`

B2. INFO subscribe: `replication started from slot {slot} for publications {publications} (backend pid {pid})`

B3. WARNING subscribe: the stream ended (connection lost, or a subscriber failed on a persistent
slot) and will be restarted.
    `restarting replication from slot {slot} in {delay} ms ({retries} restarts in a row)`

B4. WARNING/ERROR subscribe: a subscriber's callback threw or rejected. With a persistent slot the
stream is restarted so that the transaction is delivered again; with a temporary slot the change
is not delivered again. ERROR when the subscriber has no onerror handler (then this line is the
only report), WARNING when it has one (the handler gets the error too).
    `subscriber of {event} failed; restarting the stream to deliver the transaction again: {reason}`
    `subscriber of {event} failed; the change is not delivered again: {reason}`
    `subscriber of {event} failed and has no onerror handler; ...: {reason}`

B5. WARNING/ERROR subscribe: the replication stream failed (parse error, connection error); ERROR
when no subscriber has an onerror handler.
    `replication from slot {slot} failed: {reason}`
    `replication from slot {slot} failed and no subscriber has an onerror handler: {reason}`

B6. DEBUG subscribe: `replication from slot {slot} stopped` (sql.end()).

### Options (category postgres.pool, at postgres() time)

O1. WARNING: `the option timeout is deprecated and sets idle_timeout; set idle_timeout instead`
    (replaces today's console.warn).

### Transactions (category postgres.connection)

T1. WARNING: a transaction callback failed and the ROLLBACK sent for it failed too; the caller
gets the rollback's error, so the first error would otherwise be lost.
    `rollback on connection {id} to {target} failed: {reason}; the error that caused the rollback: {original}`

## Deliberately not logged

Per-query lines above debug (except slow ones), parameter values, NOTIFY payloads, passwords and
SCRAM material, cancel secrets, every pool state change (stats are exposed as `sql.stats`), COPY
chunks, transaction begin/commit at any level (the application knows), queries that the
application's own error handling sees (constraint violations etc.) above debug.

## What I want from you

1. For each line id: better wording if you see one. Same information, compact, unambiguous; keep
   the placeholders (you may add or drop one with a reason). Flag any line that a reader could
   read two ways.
2. Levels you would change, and why, in one sentence each.
3. Events missing for the four operator conditions (restart, connection limit, very slow, disk
   full/stuck), with the function in src/ where they would go.
4. Lines that would be noise in production, and how to tame them (edge-trigger, rate limit, level).

Answer as a Markdown list keyed by the line ids, then a short section for 3 and 4. Do not propose
a different logging framework or a redesign of the pool. Do not modify any file.

---

# Astra's review

Levels remain as proposed unless a change is stated. “Request” below includes queries and calls to `sql.begin()` or `sql.reserve()`.

- **P1** — `connecting to {target} failed ({retries} consecutive failed attempts); retrying in {delay} s: {reason}`  
  “3 failed in a row” leaves the thing being counted implicit. More importantly, only promise a retry when one is scheduled: `Pool.attempted()` can reject every waiting request, after which `Pool.grow()` schedules nothing. That case needs wording such as `connecting to {target} failed ({retries} consecutive failed attempts); further attempts require waiting work and a backoff of {delay} s: {reason}`. Also, `startup.open()` can make two passes for `prefer-standby`, so “all hosts tried once” does not describe every attempt.

- **P1b** — `connecting to {target} failed during pool shutdown: {reason}`  
  The original is clear; this is slightly shorter. Use DEBUG when shutdown caused the failure and no request was affected, because an intentional cancellation is not an operational failure.

- **P2** — Keep the ordinary template. For recovery: `connected to {target} after {retries} failed attempts; this attempt took {ms} ms: connection {id}, backend pid {pid}, tls {tls}, auth {auth}`.  
  The original recovery template leaves `{ms}` ambiguous between the successful attempt and the whole failure period; define whether “attempt” includes unsuccessful hosts. Replace the authentication value `trust` with `no challenge`: receiving AuthenticationOk without a challenge does not identify the server’s authentication policy. [PostgreSQL authentication flow](https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-START-UP). Derive `{tls}` from the actual transport and verification policy; the mode alone is insufficient, particularly for Workers and custom sockets. Use DEBUG for ordinary reopening after idle retirement, because those reopenings are routine rather than recovery from a failure.

- **P3** — `pool for {target} saturated for {secs} s (max {max} connections): {waiting} requests waiting for a connection, oldest wait {oldest} s`  
  “All connections busy” incorrectly implies that all connections are established and executing queries; some can be opening, loading types, reserved but idle, or held for cancellation. “Waiting” also needs a noun. Measure `{oldest}` from the oldest currently waiting request, independently of the saturation duration.

- **P4** — `pool for {target} no longer saturated after {secs} s; {timed_out} requests timed out waiting for a connection`  
  Omit the final clause when its count is zero. “Drained” can mean that the queue is empty, all connections are idle, or shutdown completed; none follows merely from saturation ending. If the queue disappeared through rejection or shutdown, report that outcome instead of implying recovery.

- **P5** — `request for a connection to {target} rejected after reaching queue_timeout of {queue_timeout} s (QUEUE_TIMEOUT); further queue timeouts in this episode will be counted in summaries`  
  “A query” is incorrect for `begin()` and `reserve()`, and “further such rejections” does not identify the suppression scope. Describing the configured threshold avoids claiming that the timer fired at precisely that elapsed time. Emit summaries during prolonged failure and when the episode ends, including episodes too short to produce P3.

- **P6** — `query on connection {id} to {target} still incomplete {secs} s after being sent: {text}`  
  “Unanswered” is false if rows or other responses have arrived but ReadyForQuery has not. A pipelined query may also be waiting behind another query after being sent. If the intended event is specifically an absence of responses, track that separately and say `no query response received for {secs} s`.

- **P7** — `loading type metadata from {target} failed; continuing with incomplete type mappings: {reason}`  
  The original understates the affected types. `Types.load()` runs both `fetched()` and `names()`, and the metadata includes domain mappings as well as custom arrays; the shared rejection handler cannot attribute every failure to array discovery.

- **P8** — `pooled requests to {target} rejected because required types are unresolved; retrying the lookup on the next request after a 1.0 s cooldown: {reason}`  
  “Until it exists” is too strong: an unqualified type can exist but be outside the lookup’s visibility, and several types can be missing. “Checked again after 1 s” incorrectly suggests a timer; `Pool.retype()` retries only when another request arrives. This also moves the error to the end.

- **P9** — `ending pool for {target}: {connections} connections open, {leased} leased, {opening} opening; {inflight} operations pending on connections, {waiting} requests waiting for a connection`  
  Add `{leased}` and `{opening}` because either can explain an unfinished shutdown when query counts are zero. If using `connection.inflight`, call the count “operations pending”: that getter includes unsent exchanges, internal exchanges, and local settlement work. Use DEBUG for ordinary shutdown initiation, because it is routine lifecycle information.

- **P10** — `pool for {target} did not finish shutting down within {timeout} s; destroying {connections} connections ({leased} leased), with {inflight} operations pending and {waiting} requests waiting for a connection`  
  Add `{leased}` for the same reason as P9. Keep WARNING when a lease remains, even if both query counts are zero: destroying a reserved connection or transaction can still interrupt application work. For the DEBUG case, use neutral wording such as `pool shutdown timeout reached` rather than implying an unexpected failure.

- **P11** — `pool for {target} is ending; rejecting {waiting} requests waiting for a connection (CONNECTION_ENDED)`  
  The proposed trigger conflates two different paths. `Pool.finishing()` rejects with CONNECTION_ENDED during shutdown; `Pool.attempted()` rejects with the actual connection-attempt error and does **not** end the pool. Those failures need a separate event, described below.

- **P12** — Keep `pool for {target} ended`.

- **P13** — `connection {id} to {target} still has a transaction block open after its {kind} lease was released (status {status}); closing it`  
  This accommodates the delayed check in `Pool.onready()` after outstanding work finishes. Render `{kind}` clearly as `transaction` or `reserve()`, and document `T` as an open transaction and `E` as a failed transaction block.

- **P14** — `connection {id} to {target} reports {name} = {value}`  
  Add `{id}` because these are session parameters, and different connections can report different values. The existing `Pool.onparameter()` merges and deduplicates values across the pool; logging only there would conceal some per-connection observations.

- **P15** — `connecting to {target} failed: {reason}`  
  Replace `{host}:{port}` with the single-host `{target}` so the line identifies the database and internal pool purpose as well. Use that same substitution for P16–P18; it also supports Unix-socket paths. A host failure is not necessarily followed by P1: a later host can succeed.

- **P16** — `{target} is {actual}; skipping it because target_session_attrs is {wanted}`  
  “Trying the next host” is false on the final host and can be misleading during the second `prefer-standby` pass. For that mode, explicitly say `trying standby hosts first` rather than suggesting that a primary is permanently disallowed. Use DEBUG for ordinary host-selection mismatches, because skipping a reachable but unsuitable host is expected selection behavior.

- **P17** — `{target} refused TLS; continuing without encryption because ssl is "{mode}"`  
  “Connecting” is slightly misleading after the socket has already connected. Emit this only for an actual TLS refusal response; an invalid response is a different event. Keep WARNING for the first occurrence per endpoint and policy, then suppress identical repetitions.

- **P18** — `{target} requested a cleartext password on an unencrypted connection`  
  This accurately reports the request without claiming that the password was sent; `channel_binding: "require"` can reject it first. Distinguish Unix-socket transport when rendering the target so readers do not infer transmission over an external network.

- **P19** — `ignoring password file {file}: mode {mode} grants permissions to group or others; set permissions to 0600`  
  `pgpass()` rejects any group/other permission bit, including write or execute permission alone, so “lets other users read it” does not describe the actual check. Render `{mode}` in octal. Do not use this line for the separate “not a regular file” condition.

- **K1** — Keep the template. Replace the reason `pool closed` with `sql.close() requested closure`, because `Pool.close()` retires connections without permanently ending the pool. The other reasons are clear.

- **K2** — Put impact before the final error: `server closed connection {id} to {target}{impact}: {reason}` or `connection {id} to {target} lost{impact}: {reason}`. For an unexplained close: `connection {id} to {target} lost{impact}: socket closed without reporting an error`.  
  Prefer impact phrases such as `; {n} queries rejected`, `; sql.begin() failed`, and `; reserved connection is unusable`. **“Transaction failed” must not imply that PostgreSQL rolled it back:** `Connection.onclose()` explicitly handles cases where COMMIT may already have succeeded. Report an unknown transaction outcome when warranted. Also, an intentional `destroy()` belongs to the initiating shutdown event, not an unexpected-loss warning.

- **K3** — `closed connection {id} to {target} after a protocol error{impact}: {reason}`  
  Keep ERROR, with K2’s careful impact wording. Emit only when closure actually occurs: `Connection.frame()` can route an exception to the current exchange without closing the connection. Do not classify a cancellation timeout as a protocol error.

- **K4** — `cancel request for connection {id} to {target} timed out after {connect_timeout} s; closing the query connection to prevent a late cancel from affecting another query`  
  Explicitly distinguishing the query connection from the cancellation connection removes an ambiguity. K3 should **not** follow: this is a deliberate protective closure after a timeout. Include any resulting work loss here, or in a correctly classified closure record.

- **K5** — `cancel request for connection {id} to {target} failed; the query may still be running: {reason}`  
  “The query runs on” promises knowledge that the client lacks; it may already have finished or failed independently.

- **K6** — `{handler} handler threw on connection {id} to {target}: {reason}`  
  Add connection context so failures from several pools are distinguishable. Provide a startup variant without `{id}`. This describes synchronous exceptions caught by `guard()` or startup’s notice handler; it does not cover rejected promises, and `Pool.opened()` currently calls `onparameter` without that guard.

- **K7** — `query on pooled connection {id} to {target} left a transaction block open; rolling it back and rejecting affected queries (UNSAFE_TRANSACTION); use sql.begin() or sql.reserve()`  
  The original omits the query rejection. Keep the trigger narrower than “outside begin/reserve”: the current check deliberately excludes `max: 1`. “Rolling it back” means initiating rollback, not confirming that rollback succeeded.

- **K8** — `prepared statement {name} already exists on connection {id} to {target}; changing its name and retrying the query`  
  Drop the pooler question from the message: a name collision establishes the symptom, not its cause. Emit the retry wording only after `retryable()` permits it; otherwise the query is rejected. Capture the original `{name}` before appending `_`. Use DEBUG for automatic retries and WARNING for repeated collisions, because a recovered collision does not itself require operator action.

- **K9** — `prepared statement {name} no longer exists on connection {id} to {target}; retrying the query with a fresh statement`  
  Drop the speculative DISCARD ALL/pooler parenthesis and document those explanations separately. As with K8, `again_or_fail()` does not always retry. Use DEBUG for automatic recovery and WARNING for persistent invalidation, because occasional statement-cache invalidation can be expected.

- **K10** — `re-describing statement {name} on connection {id} before deciding whether to retry the query: {reason}`  
  The original claims both a shape change and an execution retry too early. `described()` can discover an unchanged shape and return the original error without executing the query again.

- **K11** — `received notification on channel {channel} from backend pid {pid} on connection {id} ({bytes} payload bytes)`  
  This is slightly more direct. Measure UTF-8 bytes, not JavaScript string length. Use TRACE because one record per notification is traffic tracing and can overwhelm otherwise useful DEBUG output.

- **K12** — `row-reader compilation failed; using the generic reader for these rows and disabling further compilation: {reason}`  
  Existing compiled readers remain usable, so “rows are read by the generic reader from now on” is too broad. The source catches any compilation failure; do not identify CSP as the cause unless the error establishes that.

- **Q1** — `query on connection {id} completed {ms} ms after send, with {wait} ms before send; command {command}, count {count}: {text}`  
  This separates the two intervals and avoids suggesting that `{ms}` measures server execution alone. Start `{wait}` when execution is requested, not when the lazy Query object is constructed. `Connection.write()` initially writes into the client’s output buffer, so define “send” consistently rather than implying confirmed server receipt. Preserve unknown counts instead of printing them as zero.

- **Q2** — `query on connection {id} failed {ms} ms after send, with {wait} ms before send; sql {text}: {reason}`  
  Add `{wait}` so failed queries have the same timing context as successful ones, and move the error last. Failures before sending need a separate variant without an invented connection ID or post-send duration. Also, the attached `error` must not expose query parameters: `query_error()` attaches `parameters` and `args`, and they become enumerable with `debug`. Omitting parameters from the template alone does not meet the catalog’s promise.

- **Q3** — Use Q1/Q2’s revised templates with `slow query` as the prefix.  
  Define whether the threshold applies to time after sending or total observed latency; the two answer different questions. Exclude ordinary COPY-stream lifetime as well as cursor lifetime, since both can intentionally span long periods. Keep WARNING for qualifying slow operations, with aggregation as described below.

- **N1** — `server notice {severity} {code} on connection {id} to {target}: {message}`, retaining the optional detail and hint clauses. Startup: `server notice {severity} {code} from {target} during startup: {message}`.  
  This preserves the server’s severity while giving the line a lowercase start. Keep the proposed severity mapping and handler behavior. Server messages and details can themselves contain values, so an absolute “parameter values are never logged” guarantee requires more than omitting the bound-parameter array.

- **L1** — `listening on channel {channel} at {target}`  
  Add `{target}` here and throughout L2–L6 because channel names are scoped to a database.

- **L2** — `LISTEN connection to {target} closed; restoring LISTEN for {n} channels; notifications may be missed until each channel is listening again`  
  For the lowercase convention, begin with `listen connection` or `connection for LISTEN`. The original does not identify the target and leaves “meanwhile” undefined. Count only channels that actually require restoration, and suppress this event for intentional shutdown.

- **L3** — `listening on channel {channel} at {target} again`  
  Clear as a per-channel recovery message. For many channels, keep individual successes at DEBUG and emit one INFO summary when all affected channels recover.

- **L4** — `listening on channel {channel} at {target} failed ({retries} consecutive failed attempts); retrying in {delay} s: {reason}`  
  “Failed attempts” supplies the missing noun. Log only after the retry timer is scheduled; `relisten()` deliberately skips scheduling when the channel has gone away or shutdown has started.

- **L5** — `onlisten callback for channel {channel} at {target} threw after listening resumed: {reason}`  
  This identifies the callback and distinguishes restoration from the initial `onlisten` call, whose exception is returned to the caller.

- **L6** — `stopped listening on channel {channel} at {target}`  
  Emit after successful UNLISTEN, not merely after removing the last local listener. `retire()` can skip UNLISTEN or swallow a connection error; those paths do not establish that the server processed the command.

- **B1** — `created temporary replication slot {slot} on {target}` / `created replication slot {slot} on {target}` / `using existing replication slot {slot} on {target}`.  
  Add `{target}` throughout B1–B6 because slot names alone do not identify the server. Use DEBUG for routine temporary-slot creation and existing-slot reuse, because B2 already provides the useful stream-start event; retain INFO for creating a persistent slot.

- **B2** — `replication stream started from slot {slot} on {target} for publications {publications} (backend pid {pid})`  
  “Stream started” avoids suggesting that subscribers have caught up or processed anything yet. Keep INFO.

- **B3** — `restarting replication from slot {slot} on {target} in {delay} ms (attempt {retries})`  
  “Restarts in a row” sounds like completed restarts; the counter also includes failed initialization attempts. Log the actual scheduled delay: `restart()` uses **0 ms for the first restart**, despite calculating a different `delay` variable. The counter resets after initialization succeeds, not after a period of healthy streaming.

- **B4** — Persistent slot: `subscriber for {event} on {target} failed; restarting replication from slot {slot} to retry the unacknowledged transaction: {reason}`. Temporary slot: `subscriber for {event} on {target} failed; continuing without retrying this callback: {reason}`.  
  “The change is not delivered again” confuses this callback with delivery to other subscribers; some may already have handled the change. Persistent-slot replay can also repeat callbacks that succeeded. Keep the optional `no onerror handler` information, but use ERROR for an unretried temporary-slot callback failure regardless of handler presence, and WARNING for an automatic persistent-slot retry, because severity should reflect delivery consequences.

- **B5** — `replication for slot {slot} on {target} failed: {reason}`, optionally inserting `; no subscriber has an onerror handler` before the colon.  
  “For slot” also fits initialization failures reported by `restart()`, before a stream exists. Use WARNING for recoverable interruptions and ERROR for broken replication protocol or failures that prevent recovery, because registering an error handler does not change the operational impact. A log in `report()` alone does not cover every parse exception: `Stream.data()` calls `parse()` without a local catch.

- **B6** — `replication from slot {slot} on {target} stopped`  
  Keep DEBUG, but emit at completion of the intended shutdown operation. `Stream.stop()` also runs during failures and restarts, so logging every invocation there would misidentify the trigger.

- **O1** — `option timeout is deprecated; its value overrides idle_timeout; use idle_timeout instead`  
  `parse_options()` assigns `o.idle_timeout = o.timeout`, even when both were supplied. “Sets idle_timeout” obscures that precedence.

- **T1** — `rollback on connection {id} to {target} failed while handling an earlier error ({original}): {reason}`  
  This labels both errors and leaves the rollback error last. Add a `rollback to savepoint` variant: `transaction().scope()` handles both operations, and a failed savepoint rollback is not the same event as a failed whole-transaction rollback.

Missing events for the four operator conditions:

- **Disk full and other server resource failures, even when queries fail quickly.** Add an ERROR event at [`Connection.ErrorResponse()`](/home/at/code/js/postgres/src/connection.ts:1617), before waiting for ReadyForQuery, for a narrow set including `53100` (disk full), `53200` (out of memory), and `58030` (I/O error). Example: `server resource failure on connection {id} to {target}: {reason}`. These otherwise remain at DEBUG under Q2 when the connection survives and the query fails quickly. Deduplicate FATAL errors already reported by K2. [PostgreSQL SQLSTATE definitions](https://www.postgresql.org/docs/current/errcodes-appendix.html).

- **Requests rejected because connections cannot be established.** In [`Pool.attempted()`](/home/at/code/js/postgres/src/pool.ts:803), report the number of queued requests rejected with the actual error; count subsequent immediate rejections in `place()` and `acquire()` while `failing_fast()` applies. This makes restart and connection-limit incidents show their application impact without falsely saying that the pool ended. Include the failure episode’s duration and rejection totals when [`recovered()`](/home/at/code/js/postgres/src/pool.ts:697) clears it.

- **A connection attempt or initialization that remains unfinished.** Track a long attempt in [`startup.attempt()`](/home/at/code/js/postgres/src/startup.ts:132), distinguishing socket connection, TLS, authentication, and session-attribute probing; identify type loading in [`Pool.load_types()`](/home/at/code/js/postgres/src/pool.ts:728). This covers a silent server before any user query can be sent, including when `connect_timeout` is disabled. A warning should name the stage being awaited without claiming that PostgreSQL is executing anything.

- **Long waits without the proposed saturation condition.** Observe waiting age through [`Pool.wait()`](/home/at/code/js/postgres/src/pool.ts:368) and `drain()`, even when fewer than `max` connections exist. For waits caused by held leases, use the state maintained by `grant()` and `onready()` to report leased, loading, and opening counts. A pool can be unable to serve work without all connections executing queries.

- **Stalls in the work excluded from P6.** Use [`Connection.write()`](/home/at/code/js/postgres/src/connection.ts:498), `ReadyForQuery()`, `writable()`, `CopyData()`, and `resume()` to distinguish waiting for server completion from waiting for application input or consumption. Include internal rollback exchanges. For replication, [`Stream.run()` and `drain()`](/home/at/code/js/postgres/src/subscribe.ts:275) can identify a subscriber promise that never settles; report that as waiting for a subscriber, not a stuck server. During shutdown, [`index.end()`](/home/at/code/js/postgres/src/index.ts:442) can remain in its initial await before P9 or the main pool’s shutdown timeout starts.

- **Replication continuity lost after a restart.** Add a temporary-slot variant to B3 at [`Subscribe`’s `onclose` callback](/home/at/code/js/postgres/src/subscribe.ts:80), explaining that the old temporary slot was lost and changes during the interruption may be missed. B1/B2 currently describe successful reconnection without revealing that gap.

Production noise and how to control it:

- **P1, P15, L4, B3, B5:** emit the first failure immediately, then summarize repeated failures periodically with counts; emit a changed cause immediately. Backoff alone is insufficient, especially with custom zero backoff or many channels. Preserve one recovery summary.
- **P2, P9, P12, K1, B1:** keep ordinary connection churn and lifecycle bookkeeping at DEBUG; reserve INFO for useful startup and incident-recovery milestones.
- **P3–P5:** retain the delayed saturation warning, but include timeout counts in periodic summaries rather than waiting indefinitely for P4. Finish summaries explicitly on shutdown or rejection.
- **P6 and Q3:** report the oldest outstanding query per connection, with the number behind it, instead of warning separately for every pipelined follower. Aggregate repeated slow completions by statement, with count and maximum duration. Emit either Q1/Q2 or Q3 for a completion, rather than both.
- **K2–K4, L2, B3–B5:** report the underlying connection failure once; higher-level records should add consequences such as missed notifications, replay, or lost temporary-slot continuity. In particular, remove the K4→K3 duplication.
- **P8, P17–P19, K6–K9, L5, B4:** rate-limit repeated identical conditions per relevant endpoint, handler, channel, or statement, and retain suppressed counts. Do not suppress a materially different cause.
- **L3:** use one INFO recovery summary for a large channel set, with individual channel success at DEBUG.
- **K11:** TRACE is sufficient. Keep N1’s application-controlled suppression rather than silently discarding distinct server warnings.

---

# Opus 5.5's review

# Review of the proposed log lines

I read /tmp/log-catalog.md, then the code behind each line: src/pool.ts (all), src/startup.ts (all), src/connection.ts (close, cancel, ErrorResponse, ReadyForQuery, failed(), notices, guard), src/index.ts (transactions, Listen, options, backoff), src/subscribe.ts, src/cf.ts, and src/types.ts (load). Section 5 lists behavior bugs that I found while checking the lines.

## 0. Conventions

- **`{target}` over a Unix-domain socket can be read two ways.** `app@/run/postgresql/.s.PGSQL.5432/shop` looks like a path that ends in a file named `shop`. Put the socket path in brackets, as URLs do for IPv6: `app@[/run/postgresql/.s.PGSQL.5432]/shop`. IPv6 hosts need the brackets too: `app@::1:5432/shop` is ambiguous, `app@[::1]:5432/shop` is not.
- **Delays shown with one decimal hide the default backoff.** The default `backoff()` (index.ts) waits 15–30 ms after the first failure, 45–90 ms after the second, and 135–270 ms after the third. With one decimal, those print as "0.0 s", "0.1 s" and "0.2 s". Give the three retry delays (P1, L4, B3) as integer milliseconds, `{delay_ms} ms`. B3 already does this.
- **"in a row" also counts attempts made in parallel.** `retries` (pool.ts) counts every failed attempt since the last success, and grow() can start up to `max` attempts at once. So "10 failed in a row" can mean 10 simultaneous attempts. That is acceptable; explain it in the docs, not in the line.
- **Keep the free-text error last, and put add-ons before the colon.** K2 and K3 append `{impact}` after `{reason}`. PostgreSQL messages can contain `;`, so the reader cannot tell where the server's text ends. When a line has two free texts (an error and SQL), label the second one: `; sql: {text}`.
- **A line about one connection names that connection's host.** P2 and P14 are about one connection. With several hosts, they must show the host that the connection went to, not the pool's list of hosts.
- **Level rule (section 2 uses it):**
  - ERROR: the line is the only report of an error (because the error was swallowed or replaced), the pool stays degraded for the rest of its life, or the library has a bug.
  - WARNING: something failed, and either the callers get the error or the library recovers by itself.
  - INFO: an event for the operator's timeline.
  - DEBUG: a routine event of one connection.

## 1. Wording, by line

- **P1.** Rewrite. The draft has two problems:
  - "retrying in {delay} s" promises a retry that may never come. While attempts fail, grow() starts the next attempt only if something waits (`if (opening || !waiting.length || retry_timer || …) return`).
  - The reader cannot tell whether queries wait or fail. attempted() rejects every waiting job at once with this error, except in three cases: the code is 53300 or CONNECTION_CLOSED and connect_timeout has not run out since the first failure; an unleased connection is open; or another attempt is in progress. After that, failing_fast() also fails new queries until the delay has passed.

  `connecting to {target} failed ({retries} in a row){rejected}; next attempt {when}: {reason}`
  - {rejected} is empty, or `; rejected {n} waiting queries with this error`.
  - {when} is `in {delay_ms} ms ({waiting} waiting)` when queries wait, or `when a query comes, {delay_ms} ms from now at the earliest` when nothing waits.
  > connecting to app@db1:5432/shop failed (3 in a row); next attempt in 210 ms (57 waiting): 53300 sorry, too many clients already
  > connecting to app@db1:5432/shop failed (2 in a row); rejected 14 waiting queries with this error; next attempt when a query comes, 70 ms from now at the earliest: 57P03 the database system is starting up
- **P1b.** `connecting to {target} failed while the pool was ending; not retrying{rejected}: {reason}`. The change states the outcome.
- **P2.** Keep the first template, but `{target}` must name the host that the connection went to. Rewrite the recovery variant, because "after 3 failed attempts in 41 ms" can be read as "3 attempts within 41 ms":
  `connected to {target} in {ms} ms, after {retries} failed attempts spanning {down} s: connection {id}, backend pid {pid}, tls {tls}, auth {auth}`, where {down} = now − `failing_since`. Optional: add `, server {server_version}` to the INFO variants.
- **P3.** Rewrite. "all {max} connections busy" is false in several states where queries wait:
  - while attempts fail: grow() then opens one connection at a time, so 0 of 10 may be open;
  - while connections wait for the types to load;
  - while pick() holds jobs back for connections that are still opening (`best.inflight >= ceil(waiting / (opening + 1))`);
  - while a lease or an exclusive job waits for a connection with nothing in flight.

  Report the counts rather than a conclusion:
  `queue for a connection to {target} non-empty for {secs} s: {waiting} waiting, the oldest for {oldest} s; {open} of {max} connections open ({leased} leased), {opening} opening`

  The counts separate "pool too small, or server slow" (10 of 10 open) from "cannot connect" (0 of 10 open, with P1 lines nearby). Keep the word "saturated" only if the condition becomes `connections + opening == max`.
- **P4.** `queue for a connection to {target} empty again after {secs} s{timed_out}`, where {timed_out} is `; {n} waits ended with QUEUE_TIMEOUT`. "drained" can be read as "the pool closed its connections". Three rules:
  - The episode starts at the first wait, not when P3 first logs. Otherwise, with a queue_timeout under 1 s, P5 logs before any episode exists, and nothing counts the later timeouts.
  - P4 logs whenever P3 or P5 logged.
  - If the episode ends because the pool ended (P11), skip P4.
- **P5.** `{kind} waited {queue_timeout} s for a connection to {target} and failed with QUEUE_TIMEOUT; until the queue empties, further QUEUE_TIMEOUTs are only counted`. {kind} is `a query`, `sql.begin()` or `sql.reserve()`. The draft says "a query" for leases too.
- **P6.** `query on connection {id} to {target} unanswered for {secs} s, {queued} queued behind it: {text}`.
  - Measure from when the query became the head of the connection's `sent` (connection.ts keeps `head_since`), not from its write.
  - Log only the head, and count the queries behind it. With the default max_pipeline of 100, every query pipelined behind a stuck head is also "unanswered". Logging each of them gives up to 100 lines per connection per minute.
  - "unanswered" must mean "no message from the server since the query became the head". A query that has streamed rows for 70 s is not unanswered. If the measure is the run time instead, say `running for {secs} s`.
- **P7.** `fetching types from {target} failed and will not be retried; this pool may return values of domains and of custom types as text: {reason}`. load() runs both fetched() (arrays and domains) and names() (the custom types named in the options). A server error in either one sets `types_loaded = true` for the rest of the pool's life. The draft's "stay unparsed" does not say for how long, and "arrays of custom types" names only part of what is affected.
- **P8.** `custom type {missing} not found on {target}; queries and new transactions fail with TYPE_NOT_FOUND until it exists (looked up again by the first query after 1 s)`. Plural: `custom types {missing} not found …until they exist`. The draft has two problems:
  - It starts with `{reason}`, which begins with "TYPE_NOT_FOUND: The type …": not lower case, and not at the end.
  - "checked again after 1 s" reads as a timer, but retype() looks again only when a query comes.
- **P9.** Keep, and add `, timeout {timeout} s` or `, no timeout`. For the level, see section 2.
- **P10.** `pool for {target} did not end within {timeout} s; destroying {connections} connections, failing {inflight} queries in flight and {waiting} waiting for a connection`. In the draft, "with {inflight} queries in flight and {waiting} waiting" can be read as {waiting} connections waiting.
- **P11.** `pool for {target} is ending with no connection left; rejected the {waiting} queries waiting for one ({code})`. "ended with N waiting" can be read as "ended because N were waiting". {code} is CONNECTION_ENDED when finishing() rejects them, or the connection error's code when attempted() rejects them during the end.
- **P12.** Keep.
- **P13.** `{kind} released connection {id} to {target} inside {state}; closing the connection instead of reusing it`.
  - {kind} is `sql.begin()` or `sql.reserve()`.
  - {state} is `an open transaction (status T)` or `a failed transaction (status E)`.

  The draft's "released by its transaction with a transaction block open" repeats "transaction", and "its reserve" is awkward.
- **P14.** Keep the words, but log the line for a connection (`connection {id} to {target} reports {name} = {value}`). Today opened() calls onparameter() without the connection. With several hosts, the pool's one `options.parameters` flips between the hosts' values (for example, in_hot_standby), and each flip would make a line that names no host.
- **P15.** `connecting to {host}:{port} failed; trying the next host: {reason}`. Log it only when another host remains, because P1 already carries the last host's error.
- **P16.** `{host}:{port} is {actual}, but target_session_attrs is {wanted}; skipping it`.
  - "trying the next host" is false after the last host of the last pass. Then the attempt fails, and P1 follows.
  - With prefer-standby, the first pass skips a primary that the second pass then accepts. Either show {wanted} as `standby (first pass of prefer-standby)`, or log nothing in that pass.
  - For {actual}, write "a primary", not "the primary".
- **P17.** `{host}:{port} refused TLS; continuing unencrypted, since ssl is "{mode}"`. For mode allow, the draft reads `as ssl "allow" allows`. Log it once per pool per host. startup.ts cancel() also runs negotiate(), so cancel requests must not log the line again.
- **P18.** `{host}:{port} asked for the password in cleartext over an unencrypted connection; sending it`.
  - The draft does not say what the library does. Auth() sends the password unless channel_binding is "require".
  - Do not log this over a Unix-domain socket. Nothing there crosses a network, and libpq does not warn either.
  - Consider also warning when TLS does not verify the certificate (ssl require). There, a man in the middle can read the password.
- **P19.** `ignoring password file {file}: its mode {mode} gives group or others access; it should be 0600 or stricter`. pgpass() tests `mode & 0o077`, which is any permission bit of the group or of others. So "lets other users read it" is wrong for modes such as 0620 or 0601. Print {mode} as 4 octal digits.
- **K1.** Keep. Two values of {why} change:
  - "pool closed" → `sql.close() called`. "pool closed" reads like the pool's own end.
  - "released with a transaction block open" → `released inside a transaction`, to match P13.
- **K2.** Move {impact} before the colon, add the idle time, and say who closed the connection:
  - `server closed connection {id} to {target}{impact}: {reason}`
  - `connection {id} to {target} lost{impact}: {reason}`
  - `connection {id} to {target} lost{impact}: the socket closed, and neither the server nor the OS gave a reason`

  {impact} is ` after {idle} s idle` when nothing was in flight and the connection had no lease. Otherwise it is one or both of `{n} queries in flight failed` and `held by sql.begin()` (or `held by sql.reserve()`), in parentheses, joined by "; ".
  > connection 3 to app@db1:5432/shop lost after 350.2 s idle: read ECONNRESET
  > server closed connection 3 to app@db1:5432/shop (2 queries in flight failed; held by sql.begin()): 57P01 terminating connection due to administrator command

  A NAT or load-balancer timeout shows up as the same idle time on every drop. Reasons for the other changes:
  - "the socket closed without an error" can be read as "closed cleanly".
  - The definition ("the transaction on it failed") and the example ("transaction lost") disagree.
  - "the reserved connection's queries fail" reads as a prediction about all future queries.

  Do not log K2 for a connection that the pool destroyed itself (destroy() after sql.end()'s timeout, or `signal.aborted`). P10 already reports those. Log them at DEBUG as K1 with `destroyed: sql.end() timeout`.
- **K3.** `closed connection {id} to {target}{impact}: {reason}`.
  - abandon() is called for more than protocol errors. It is also called for a cancel request's CONNECT_TIMEOUT (K4), and for "Bug: an exchange of the connection's own wrote nothing". So "after a protocol error" is sometimes wrong. {reason} carries the code (UNEXPECTED_MESSAGE, CONNECT_TIMEOUT).
  - No line covers this case: when a query is in flight, frame()'s catch fails only that query for an UNEXPECTED_MESSAGE (`fail(item, …)`), and the connection stays open. Log that at ERROR too. Filter on the code, because the same catch also receives errors that the user's parsers and transforms throw.
- **K4.** `cancel request for connection {id} to {target} timed out after {connect_timeout} s; closing the connection, since the request could still arrive and cancel a later query`. The change is small. The close that follows is K3's generic line, not a protocol error.
- **K5.** `cancel request for connection {id} to {target} failed; the query may still be running: {reason}`. The draft's "the query runs on: {reason}" reads as "the query runs on ECONNREFUSED".
- **K6.** `{handler} threw on connection {id} to {target}; ignored: {reason}`.
  - Users of sql.listen() never set onnotify. When their listener throws, the error reaches guard() through Listen's internal onnotify (index.ts), so the line would name onnotify. Log in that onnotify instead, for each listener: `listener of channel {channel} threw; ignored: {reason}` (category postgres.listen).
  - startup.ts notice() also swallows the errors of onnotice.
- **K7.** `a query left a transaction open on pooled connection {id} to {target}; rolling back, and failing the query and {behind} queries pipelined behind it with UNSAFE_TRANSACTION (use sql.begin() or sql.reserve()): {text}`.
  - Add {text}: without it, the operator cannot find the query at fault.
  - In the draft, the "it" of "rolling it back" becomes ambiguous once the line names more objects.
- **K8.** `prepared statement {name} already exists on connection {id} to {target} (a connection pooler sharing server connections? then set prepare: false); {action}`. {action} is `retrying under a new name` or `the query fails`. failed() retries only when retryable() is true (not in a transaction, a cursor, a stream, …). Otherwise the query fails, while the draft would still say "retrying".
- **K9.** `prepared statement {name} is gone from connection {id} to {target} (DISCARD ALL, or a connection pooler?); {action}`. {action} is `preparing it again and retrying the query` or `the query fails`, for the same reason as K8.
- **K10.** `statement {name} on connection {id} to {target} must be described again; retrying the query: {reason}`. The draft puts {reason} in the middle ("after {reason}: re-describing").
- **K11.** Keep. For the level, see section 2.
- **K12.** `cannot compile row readers, so reading rows with the slower generic reader: {reason}`. This puts the error last.
- **Q1.** `query on connection {id} took {ms} ms after {wait} ms waiting, {count} rows: {text}`.
  - Drop {command}. "SELECT 1: select * from users" reads as if "SELECT 1" were the SQL, and the text already shows the command.
  - Omit `, {count} rows` when the command tag has no count.
  - Measure {ms} from when the query became the head of the connection's `sent`, as timed() does for the scheduler. Measure {wait} from the call to that moment. Otherwise every query pipelined behind a slow one gets the slow one's time.
- **Q2.** `query on connection {id} failed after {ms} ms: {reason}; sql: {text}`. The line has two free texts, and error messages contain colons, so the SQL needs a label. Add a variant for a query that never got a connection (QUEUE_TIMEOUT, a fast failure, CONNECTION_ENDED): `query failed after waiting {wait} ms for a connection to {target}: {reason}; sql: {text}`.
- **Q3.**
  - `slow query on connection {id} to {target} took {ms} ms after {wait} ms waiting, {count} rows: {text}`
  - `slow query on connection {id} to {target} failed after {ms} ms: {reason}; sql: {text}`

  Add {target}: in an app with several pools, a WARNING must say which pool. Define "slow" on {ms} alone, because waiting is P3's subject.
- **N1.** Keep. For the startup variant, use the one-host target like the other lines: `{severity} {code} from {target} during startup: {message}`.
- **L1.** Keep.
- **L2.** `LISTEN connection {id} to {target} closed; sending LISTEN again for {n} channels; notifications sent until the new LISTENs succeed are lost`. "meanwhile" has no clear start or end. Listen's onclose receives the connection id from the pool (`options.onclose(c.id)`).
- **L3.** Log each channel at DEBUG. Once every channel listens again, log one line: `listening again on all {n} channels, {secs} s after their connection closed`. {secs} is the window in which notifications were lost.
- **L4.** `LISTEN {channel} failed ({retries} in a row); next attempt in {delay_ms} ms: {reason}`. This matches P1.
- **L5.** `onlisten of channel {channel} threw; ignored: {reason}`.
- **L6.** `stopped listening on channel {channel}: its last listener left`. "unlistened" is jargon. If you prefer the SQL word: `sent UNLISTEN {channel}: no listeners left`.
- **B1.** Keep.
- **B2.** Keep.
- **B3.**
  - Persistent slot: keep, with `{delay}` renamed `{delay_ms}`.
  - Temporary slot: `restarting replication on a new temporary slot {slot} in {delay_ms} ms ({retries} restarts in a row); changes committed before it exists are not delivered`.

  The temporary slot was dropped with its connection. init() creates a new one, which starts at the current WAL position, so the operator must learn about the gap.
- **B4.**
  - `subscriber of {event} failed on the transaction at LSN {lsn}; restarting the stream to deliver it again: {reason}`
  - `subscriber of {event} failed; not delivering the change again: {reason}`
  - ERROR form: `subscriber of {event} failed (no onerror handler); …`

  The LSN shows that each restart delivers the same transaction again (see side finding 3).
- **B5.** Keep. ERROR form: `replication from slot {slot} failed (no subscriber has an onerror handler): {reason}`. The parentheses keep the predicate short.
- **B6.** Keep.
- **O1.** `option "timeout" is deprecated and sets idle_timeout; set idle_timeout instead`. Without the quotes, "the option timeout" can be read as "the timeout of options". Unlike console.warn, this record is not shown if postgres() runs before the app configures LogTape, which is common for pools created when a module is imported.
- **T1.** `{rollback} on connection {id} to {target} failed, so the caller gets its error ({reason}) instead of the one that caused the rollback: {original}`. {rollback} is `ROLLBACK`, or `ROLLBACK TO SAVEPOINT s1`, because scope() rolls back savepoints the same way. The new wording says why the line exists.

## 2. Levels

- **P2:** INFO → DEBUG for "the first connection after all were closed" when they all closed in an orderly way (idle_timeout, max_lifetime). That is routine with bursty traffic, or with one pool per request on Workers. Keep INFO for the pool's first connection and for the first after failed attempts.
- **P7:** WARNING → ERROR. For the rest of its life, the pool returns these values as text, and no caller is told.
- **P9:** INFO → DEBUG. sql.end() is the app's own action, which the catalog's rule for begin and commit already leaves out. P10 and P11 report the problems.
- **P14:** DEBUG → INFO for changes of in_hot_standby and default_transaction_read_only after their first value, on a single-host pool. Such a change means a promotion or a demotion.
- **P16:** INFO → DEBUG. In a steady multi-host setup, every new connection may skip a host.
- **P17:** WARNING once per pool per host, and DEBUG for the repeats.
- **K2:** ERROR → WARNING in every case. The callers get the errors, and a PostgreSQL restart should not produce one ERROR per connection. For 57P05 (idle_session_timeout) on an idle connection with no lease, use INFO.
- **K6, L5, T1:** WARNING → ERROR. The line is the only report of the error, which is the rule that B4 and B5 already follow.
- **K8, K9:** WARNING once per pool, then DEBUG.
- **K11:** DEBUG → TRACE. It makes one line per NOTIFY.
- **L3:** per-channel INFO → DEBUG, plus one INFO line once every channel listens again.
- **L4:** WARNING → DEBUG when the reason is a connection error, because the LISTEN pool's P1 already logs it. Keep WARNING when the server refused the LISTEN.
- **P1 (optional):** ERROR for errors that retrying cannot fix: 3D000, 28000, SSL_NOT_SUPPORTED, CHANNEL_BINDING_REQUIRED, AUTH_TYPE_NOT_IMPLEMENTED, SASL_*. Keep 28P01 at WARNING, because a password rotation can fix it.

## 3. Missing events

**PostgreSQL restarting**
- **pool.ts attempted():** it rejects every waiting job with the connection error (`stuck() && opening === 0 && failure`). Only the {rejected} count in P1 would show this.
- **pool.ts attempted():** 57P03 ("starting up", "shutting down", "not yet accepting connections") is not in `transient`. So during a restart, waiting queries fail at once instead of waiting. P1's new wording makes this visible. Whether 57P03 should be transient is a decision, not a log line.
- **pool.ts place() and acquire():** failing_fast() rejects new queries without making an attempt. Count them, and print the count in P2's recovery variant: `; {n} queries failed fast meanwhile`.
- **pool.ts onclose():** a connection that closes while it loads the types calls attempted(), which counts as a failed attempt. No P1 line comes from that path, so the counter jumps without a line. Log P1 there too.
- **pool.ts onparameter(), called through connection.ts ParameterStatus():** a connection's in_hot_standby can turn on while target_session_attrs is primary or read-write. Then the connection no longer fits, and nothing closes it today. WARNING: `connection {id} to {target} is now a standby, but target_session_attrs is {wanted}`.
- **startup.ts open():** with several hosts, when one host fails while another serves, only P15 at DEBUG shows it. Log a WARNING once per host per episode, and INFO when that host answers again.

**Connection limit (53300)**
- **pool.ts attempted():** after connect_timeout has passed since the first failure, `expired` turns a 53300 or CONNECTION_CLOSED from "wait" to "fail". Log a WARNING once at that moment: `connecting to {target} has failed for {secs} s (connect_timeout); queries waiting for a connection now fail with: {reason}`.
- P3's `{open} of {max}` shows a pool that cannot grow to `max`.

**PostgreSQL very slow**
- **pool.ts opened(), with the start time taken in connect():** a slow connection attempt. Log a WARNING when it took 1 s or more (or connect_timeout / 2 or more). For most connections, P2 shows {ms} only at DEBUG.
- **pool.ts load_types():** every query of a new pool waits for the type fetch. Log `fetched types from {target} in {ms} ms` at DEBUG, and at WARNING when it took 1 s or more.
- Q3, P3 and P6 cover the rest.

**Disk full, or the server stuck**
- **connection.ts ErrorResponse() or failed():** SQLSTATEs from queries that mean the server lacks a resource. Today these show only in Q2, at DEBUG. This would be the client's only view of a full disk.
  - Class 53: 53100 disk_full, 53200 out_of_memory, 53400 configuration_limit_exceeded.
  - Class 58: 58030 io_error.
  - XX000, XX001, XX002.
  - 25006 (read-only transaction), which a write gets after a failover.

  Log these at WARNING, at most once per code per pool per minute, with a count.
- **pool.ts end() and finishing():** sql.end() without a timeout waits forever for the queries that a stuck server never answers. While the pool is ending, log a WARNING every 10 s: `pool for {target} still ending after {secs} s: {inflight} queries in flight, {waiting} waiting`.
- **subscribe.ts Stream tick() and drain():** with a persistent slot, `acked` may stop advancing, either because the subscribers have not finished a transaction or because `queue` paused the stream. Meanwhile the server keeps WAL for the slot. After N minutes, log a WARNING: `replication slot {slot} not confirmed for {secs} s; the server keeps WAL for it`. Log the same from restart() while the stream stays down.
- **connection.ts flush() and ondrain() (optional):** a socket that has waited 10 s or more for a drain means that the server stopped reading. Log at DEBUG or WARNING.

## 4. Noise in production, and how to tame it

- **P1:** attempts made in parallel fail together, so up to `max` lines come at once at startup. During an outage, the LISTEN and replication pools repeat the main pool's lines. After 3 lines with the same reason in one episode, log one line per minute with a count. Log at once when the reason changes.
- **P2:** per-request pools (Workers) and churn from idle_timeout. See the DEBUG change in section 2.
- **P5:** many short episodes. Log it at most once per minute per pool, and count the rest.
- **P6:** queries pipelined behind a stuck one: log only the head, with {queued}. Workloads with legitimate long queries (migrations, reports, CREATE INDEX) also trigger it. Either log the first report (at 10 s) at INFO and switch to WARNING from 60 s, or make the threshold an option.
- **P8:** up to one line per second while the type is missing. Log the first one, the repeats at DEBUG, and one INFO line once the type is found.
- **P14:** on a multi-host pool, the values flip between hosts. Log per connection, or only on single-host pools.
- **P16, P17:** these fire for every connection. See section 2.
- **K2:**
  - Idle connections dropped by idle_session_timeout (57P05) or by a NAT: see the INFO change and the idle time.
  - After P10's destroy: suppress the line.
- **K8, K9:** behind a connection pooler in transaction mode, these come many times per minute. Log them once per pool.
- **K11:** TRACE.
- **Q3:** every run of a slow statement makes a line. Log at most once per minute per statement text, with a count, and measure from the head (see Q1).
- **L3, L4:** these fire once per channel. Aggregate them.
- **B1–B4 in the subscriber loop (side finding 3):** each cycle logs B4, B3, B1, B2, and P2 at INFO (the only connection of the replication pool), as fast as connections can open. Log B4 only when the LSN changes; log a failure on the same LSN at DEBUG.
- **N1:** RAISE NOTICE inside a loop. This is the app's choice: it can set onnotice: false, or set a level for postgres.notice.

## 5. Side findings: behavior bugs, not wording

1. **index.ts, Listen.connection(), onnotify:** `[...listening.listeners].forEach((l) => l.fn(payload))` has no try for each listener. So a listener that throws stops the listeners after it from getting that notification, and guard() in connection.ts then swallows the error silently. The comment in relisten() says the opposite: "As for a listener's fn in onnotify: one listener's error must not stop the calls of the others".
2. **pool.ts opened():** `Object.entries(ready.parameters).forEach(([k, v]) => onparameter(k, v))` calls options.onparameter without a guard. If the handler throws, opened() throws inside `.then(opened, failed)`, and four things follow:
   - the rejection is unhandled, which ends the process under Node's default `--unhandled-rejections=throw`;
   - the socket stays open;
   - the connection is never added to the pool;
   - `opening` has already been decremented.

   pool.ts onclose() also calls options.onclose without a guard, in the middle of its bookkeeping.
3. **subscribe.ts restart():** `retries` returns to 0 after each init() that succeeds, and the first restart waits 0 ms. So with a persistent slot, a subscriber that always fails on a transaction makes the stream restart at once, forever, each time on a new connection. B3's "{retries} restarts in a row" never goes above 1.
4. **startup.ts open():** when no host fits target_session_attrs, open() throws CONNECTION_DESTROYED. P1 would then show "CONNECTION_DESTROYED (db2:5432)", which reads as if the pool had destroyed the connection. A code of its own, or a message such as "no host is a primary", would make P1 readable.
5. **connection.ts unsafe_transaction():** the message says "Only use sql.begin, sql.reserved or max: 1", but the method is sql.reserve. README.md repeats the typo.
