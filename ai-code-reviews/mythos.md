# Bugs found while reading `src/` for a logging audit

Reviewer: Claude Mythos 5.1, on 2026-11-02, at commit `33aa4bd` on `prime`.

This is not a full review. The four items below turned up while reading every file in `src/` to mark where an operator would want a log line. 1, 2 and 4 are confirmed against the working tree with the scripts under [How this was tested](#how-this-was-tested); 3 is from reading only.

## 1. A non-numeric value for a numeric option becomes `NaN` silently; `backoff=abc` is a hot reconnect loop

`parseOptions` coerces the eight options listed in `ints` with `+value` whenever the value is a string ([src/index.ts:543](../src/index.ts#L543)). A value that is not a number becomes `NaN`, from any of the three sources, and nothing reports it:

```js
postgres('postgres://u@localhost/db?connect_timeout=abc').options.connect_timeout   // NaN
process.env.PGCONNECT_TIMEOUT = '30s'; postgres({ ... }).options.connect_timeout     // NaN
postgres({ ..., connect_timeout: 'abc' }).options.connect_timeout                    // NaN
```

`NaN` is falsy, so every `option && ...` guard reads it as "disabled", and every comparison with it is false:

- `connect_timeout`: no timer is armed in `attempt()` ([src/startup.ts:92-94](../src/startup.ts#L92-L94)), and `expired` in `attempted()` ([src/pool.ts:475](../src/pool.ts#L475)) is never true. A connect that hangs (black-holed host, stalled TLS or auth) hangs for as long as the OS allows, or forever.
- `idle_timeout`, `max_lifetime`, `queue_timeout`, `keep_alive`: disabled.
- `max_pipeline`: `c.inflight < NaN` is false in `pick()`, so queries are never pipelined.
- `backoff`: `nextAttempt = now() + 1000 * NaN` is `NaN` ([src/pool.ts:470-472](../src/pool.ts#L470-L472)). In `grow()`, `wait > 0` is false, so the next attempt starts at once, and `failingFast()`'s `now() < nextAttempt` is false too. Against a server that accepts the TCP connection and closes it (a transient `CONNECTION_CLOSED`, so the pool keeps retrying while a query waits), this measured **12,873 connection attempts in 500 ms**, versus 4 with the default backoff.

`max` is not in `ints` at all, so `?max=1` stays the string `'1'`; [opus.md](opus.md) already covers that.

Suggested fix: in the `ints` branch, throw when `Number.isNaN(+value)`, naming the option and where the value came from (option, URL parameter, or `PG*` variable). Add `max` to the list.

## 2. A pgoutput change for an unknown relation id throws inside the replication stream's `data` handler

`parse()` in [src/subscribe.ts](../src/subscribe.ts#L351) looks the relation up with `relations[x.readUInt32BE(1)]` for insert, delete, update and truncate ([lines 351, 358, 368, 383](../src/subscribe.ts#L351)) and dereferences the result without a check. If no `Relation` message was seen for that id, `relation.columns` throws a `TypeError` from `data()`, which is a `'data'` listener on the CopyBoth duplex that `connection.ts` pushes into. Where the throw lands depends on whether the stream had buffered data (measured on a plain `Readable`):

- Stream drained: `push()` throws synchronously, up into `frame()`'s `catch` in [src/connection.ts:663-666](../src/connection.ts#L663-L666), which calls `fail(sent[0], error)`, which calls `sync()`, which writes a `Sync` message in the middle of COPY BOTH. The walsender rejects any message other than CopyData, CopyDone, CopyFail and Terminate with a FATAL protocol violation (`ProcessRepliesIfAny` in `walsender.c`; not reproduced here), so the connection closes and `Subscribe` restarts it, silently, into the same situation.
- Data buffered (for example a subscriber returned a promise, so `run()` paused the stream): the listener runs on a later tick, and the throw is an **uncaught exception**, which exits the process.

Reachability: a conforming PostgreSQL sends a `Relation` message before the first change for each relation in a walsender session, and `relations` is created per `Stream`, which is per connection, so this needs a non-conforming server or proxy, or a dropped message. Low likelihood, process-crash consequence, and in the common case it is not even reported.

Suggested fix: when `relation` is undefined, build an error (`Errors.generic('UNKNOWN_RELATION', ...)` with the id and message type) and hand it to `report()` or `stream.destroy(error)` instead of dereferencing.

## 3. If the rollback sent after a failed query itself fails, its error replaces the original one

In `scope()` ([src/index.ts:266-273](../src/index.ts#L266-L273)) the `catch` block sends `rollback` (or `rollback to <savepoint>`) with `await control(...)`, unless the connection is already known to be closed, and only then throws the original error. If that rollback rejects, because the connection closed between the `lease.connection.closed` check and the rollback completing, the rejection propagates out of the `catch`, and the caller gets `CONNECTION_CLOSED` instead of the error that ended the transaction (a constraint violation, say).

From reading only; the race was not reproduced. Minor: the transaction is gone either way, but the cause is lost.

Suggested fix: `await control(...).catch(() => {})` there, or attach the rollback error as `cause` on the original.

## 4. A server error while fetching types is treated as "types loaded"

`loadTypes()` ([src/pool.ts:439-447](../src/pool.ts#L439-L447)) runs the `pg_catalog.pg_type` queries on the first connection. If they fail with a `PostgresError`, it sets `typesLoaded = true` and nothing is reported. From then on, arrays of custom types and domains are returned unparsed, as text, for the lifetime of the pool:

```
as app (no SELECT on pg_type):  [{"x":"{a,b}"}]
as superuser:                   [{"x":["a","b"]}]
```

That may be deliberate, to keep working against servers whose catalog differs, but `fetch_types: false` already exists for the deliberate case, and a user who hits it by accident (a restricted role, or a proxy in front of something that is not PostgreSQL) has no way to find out why their arrays are strings. The `TYPE_NOT_FOUND` branch next to it, by contrast, rejects every query.

Suggested fix: at least report it (a warning, once); or treat it like `TYPE_NOT_FOUND`.

## How this was tested

Node.js 26, no PostgreSQL needed.

Bug 1, `NaN` from the three sources and the backoff loop (the server accepts and destroys every socket):

```js
import net from 'net'
import postgres from './src/index.ts'
let attempts = 0
const server = net.createServer(s => { attempts++; s.destroy() }).listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const sql = postgres({ host: '127.0.0.1', port, user: 'u', database: 'db', backoff: 'abc' })
  sql`select 1`.catch(() => {})
  await new Promise(r => setTimeout(r, 500))
  console.log(attempts)                     // 12873; 4 with the default backoff
  await sql.end({ timeout: 0 }); server.close()
})
```

Bug 2, where a throwing `'data'` listener lands:

```js
const { Readable } = require('stream')
process.on('uncaughtException', e => console.log('uncaught:', e.message))
const s = new Readable({ read() {} })
s.on('data', () => { throw new Error('drained') })
setImmediate(() => {
  try { s.push(Buffer.from('x')) } catch (e) { console.log('sync:', e.message) }   // sync: drained
  const t = new Readable({ read() {} })
  t.on('data', () => { throw new Error('buffered') })
  t.pause(); t.push(Buffer.from('a')); t.push(Buffer.from('b')); t.resume()        // uncaught: buffered
})
```

Bug 4, against a scratch cluster from `pg_tmp -t` (PostgreSQL 18):

```sh
psql "$url" -c "create role app login password 'x'; create type mood as enum ('a','b');
  create table m (x mood[]); insert into m values ('{a,b}'); grant select on m to app;
  revoke select on pg_catalog.pg_type from public;"
```

```js
import postgres from './src/index.ts'
const sql = postgres({ host: '127.0.0.1', port, user: 'app', password: 'x', database: 'test' })
console.log(JSON.stringify(await sql`select x from m`))   // [{"x":"{a,b}"}], no error, no warning
```
