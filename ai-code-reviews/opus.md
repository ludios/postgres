# Review of the postgres.js v4.0.0 rewrite

Reviewer: Claude Opus 5.5, on 2026-10-30, at commit `570be76` (4.0.0). The rewrite itself is commit `06cf284`.

## Summary

v4 is an ambitious rewrite and mostly solid. The unit tests pass, and so does the 2000-seed fault-injection simulation (`tests/simulate.js`). The integration suite passed 515 of 544 against a scratch PostgreSQL 18 cluster. The 29 failures all look like setup problems: hardcoded port 5432 (the cluster ran on 55432), and proxy tests whose 127.0.0.1 connections were rejected by the cluster's `pg_hba` rules.

The new behaviour I exercised worked as documented:

- re-preparing a statement after a column type change, both on the pool and inside `sql.begin`
- aborting a transaction when a query in it cannot be built
- several cursors open at once in one transaction
- `queue_timeout`
- `.signal()` cancelling a running query

Even so, I found four new bugs, each confirmed against a v3.4.9 checkout, and two claims in the docs that contradict the code.

## Model output or human?

It's very probably mostly model-written, directed and released by the maintainer. I can't prove it. The evidence:

- **Scale and shape.** One commit (`06cf284`) of +15.8k/−21.6k lines across 128 files, with 73 `Fixes #` lines. It was released 11 days later. The changelog says "the open issues and pull requests were triaged into 33 correctness bugs, each with a regression test". Sweeping a whole issue tracker like that is a typical agent workflow.
- **Test infrastructure.** A deterministic simulator with a fake clock and fault injection, a soak test, a coverage runner with no dependencies, a Cloudflare Workers harness, and a JSON list of tests expected to fail behind a pooler. The test count went from 258 to 544, and the median test name grew from 42 to 62 characters, with names like "A socket error without a close rejects the query in flight instead of hanging (#1246, #1089)". That is a lot to build alone in a few months.
- **Prose.** The changelog and README are uniform and plain, with a constant "v3 did X, v4 does Y" framing. The summaries also confidently contradict the code in places (see [Documentation errors](#documentation-errors)), which is a common failure of model-written release notes.
- **Against that.** The code copies the maintainer's own style exactly: comma-first declarations, no semicolons, `&&` used for control flow, and zero comments in `src/`. The design direction is clearly his too. Old branches predate this work: `remove-js-type-inference` (2023), `concurrent-cursors` (2022), `connection-stats` and `query-stats` (2023).

## New bugs

All four work in v3.4.9 and fail in v4.0.0.

### 1. Queries share one mutated error object when a connection drops

When a connection closes, every query queued on it is rejected with the same `closed` error object ([src/connection.js:522-532](../src/connection.js#L522-L532)). `queryError` adds `query`, `parameters`, `args`, `types` and the call-site stack to the error it is given, unless the error already has a `query` property, in which case it returns it as is ([src/errors.js:407-421](../src/errors.js#L407-L421)).

So the first query to be rejected gets the object decorated with its own details, and every later query gets that same object. The other places that reject a batch of queries with one error behave the same way:

- `finishing()` and `destroy()` in [src/pool.js](../src/pool.js#L630-L659), on `sql.end()`
- `lease.send` and `place()` after a reserved connection has closed

v3 created a separate error per query with `Object.create(err, { query, parameters, ... })`. In v4 the stack and parameters of one query show up on another query's error, which can put one request's parameter values into another request's logs.

Reproduction, with `max: 1` and three pipelined queries:

```js
const a = sql`select pg_sleep(2), ${ 'secret-a' }::text as a`.catch(e => e)
const b = sql`select ${ 'secret-b' }::text as b`.catch(e => e)
const c = sql`select ${ 'secret-c' }::text as c`.catch(e => e)
// meanwhile, from another connection: select pg_terminate_backend(<pid>)
```

Output:

```
v4 b === c: true
v4 c.query: "select $1::text as b" c.parameters: ["secret-b"]
```

Suggested fix: build a new error per query in `queryError`, as v3 did, or copy the error at each place that rejects several queries with one error. `copy()` in `pool.js` already does that copying for the `failingFast` path.

### 2. A SQL comment between a clause and a helper breaks the helper

v4 works out which clause a helper is in by scanning the query text backwards from the helper (`context()`, [src/build.js:145-192](../src/build.js#L145-L192)). The scanner handles quotes and parentheses but not `--` or `/* */` comments. Words inside a comment are treated as SQL, so stop words like `the`, `not`, `from` and `table`, or parentheses, send it to the wrong builder. Each of these fails with `TypeError: x.replace is not a function`:

```js
sql`insert into notes -- see the docs (section 3)
  ${ sql({ a: 1, b: 'x' }) }`

sql`insert into notes -- one row per user
  ${ sql({ a: 2, b: 'y' }) }`

sql`update notes set -- only changed fields, not the key
  ${ sql({ b: 'z' }) } where a = 1`

sql`select * from notes where a in /* ids from the (cached) list */ ${ sql([1, 2]) }`
```

For `insert into`, any comment breaks it: `insert_into()` only accepts exactly one word, or `t as x`, between `into` and the helper. v3 found the keyword with regular expressions and handled all four cases.

### 3. A table or column named `constructor` or `__proto__` next to a helper crashes

`context()` looks each word up with `clauses[word]` ([src/build.js:180](../src/build.js#L180)), and `clauses` is a plain object. That lookup finds `Object.prototype.constructor` and `Object.prototype.__proto__`:

```js
await sql`insert into constructor ${ sql({ a: 1 }) }`
// TypeError: builders[kind] is not a function
```

Suggested fix: `Object.hasOwn(clauses, word)`, or create `clauses` with `Object.create(null)`.

### 4. Epoch-millisecond numbers no longer work as timestamp parameters

With the new default `infer: false`, a parameter that the server types as `timestamp`, `timestamptz` or `date` goes through `shaped(x => x instanceof Date, serializeDate)` ([src/types.js:44-50](../src/types.js#L44-L50)). Anything that isn't a `Date` is sent as plain text:

```js
await sql`select ${ Date.UTC(2024, 0, 2, 3, 4, 5) }::timestamptz as x`
// v3: 2024-01-02T03:04:05.000Z
// v4: 22008 date/time field value out of range: "1704164645000"
```

v3 serialized these with `new Date(x).toISOString()`. The README's upgrade guide says "Nothing changes for `timestamptz` columns, … for strings and numbers", so this change is undocumented. `infer: true` restores the v3 behaviour.

## Documentation errors

- **NUL characters.** The changelog's Security section says a NUL "in any protocol string, also in query text and identifiers, now rejects with `NUL_CHARACTER`". Only startup parameters are checked (`unbroken()`, [src/protocol.js:173](../src/protocol.js#L173)). A NUL in query text is sent to the server, which rejects the message. The project's own test, "A NUL character in query text is rejected by the server and leaves the connection usable", says so.
- **Numbers and timestamps.** The README's "nothing changes for … numbers" is wrong for timestamp and date parameters (bug 4).

## Bugs that are also in v3

These are not regressions.

- **Destroying a COPY TO stream hangs the connection.** If you destroy the readable from `copy ... to stdout` partway through, the socket stays paused and the next query on that connection never resolves.
- **`?max=1` in a connection URL is a string.** `max` is missing from the list of numeric options in `parseOptions` ([src/index.js:425](../src/index.js#L425)), so `options.max` becomes `'1'`. The `options.max === 1` / `!== 1` checks then fail, and a manual `begin` is rolled back with `UNSAFE_TRANSACTION`. A `PGMAX` environment variable has the same problem. Since v4 now treats `max: 1` differently in several places (it allows a manual `BEGIN`, turns off the scheduler and keeps queries in order), this matters more than it did in v3.

## Design risks

- **Text heuristics decide behaviour.**
  - Any query whose text matches `/\bbegin\b/i` or `start transaction` runs alone on its connection ([src/pool.js:7-9](../src/pool.js#L7-L9), `opens()`). That includes `do $$ begin ... end $$`, function definitions, a column named `begin`, and the string `'begin'`. This only costs throughput, but it is a silent slowdown.
  - Where a helper lands depends on the hand-written backwards SQL scanner (bugs 2 and 3). It doesn't handle comments, dollar quoting or `E''` strings.
- **The `infer: false` default** is a real breaking change for anyone using `timestamp` or `date` columns outside UTC. The README documents it well, apart from bug 4.
- **Concentrated complexity.** Most of the difficult logic sits in `src/connection.js`:
  - pipelining
  - holding back a COMMIT until open cursors finish
  - statement shape versioning across connections
  - retrying after `26000`, `42P05` and plan-change errors
  - sending a deliberately invalid query to abort a transaction when a query can't be built

  It all arrived as one diff that is too big to review, so the simulator is doing most of the reviewing.
- **Errors at Bind time cost an extra round trip.** An invalid parameter value, such as `'abc'` for an `int`, fails before `BindComplete`. That counts as retryable, so the query is parsed and described again before the original error is returned. The result is correct, but it is slower on the error path. With several queries in flight on the connection, the retry also goes to the back of the queue.

## How this was tested

- **Integration suite:** `node tests/index.js` against two scratch PostgreSQL 18.6 clusters created with `tests/setup.sh` on ports 55432 and 55433, on Node.js 26.13.
- **Unit and simulation suites:** `node tests/unit` and `node tests/simulate.js`.
- **Repro scripts:** in `/tmp/pgv4/repro/` (outside the repository). Each runs against `src/` (v4) or an extracted copy of `v3.4.9` (`/tmp/pgv4/v3/src`), selected by a `v3` or `v4` argument.
