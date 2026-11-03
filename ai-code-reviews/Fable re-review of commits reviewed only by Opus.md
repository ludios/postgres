# Fable 5.1 re-review of the commits that only Opus reviewed

Triaged on 2026-11-03. Line numbers are at `f7ad955` on `prime`.

## Why

From about 2026-10-11 until 2026-11-03 04:30 UTC, Opus 5.5 wrote every review saved under `~/.ai-code-reviews/claude-mythos-5-1/` and `claude-fable-5-1/`, whatever the directory said. `/code-review` runs in a subagent, and `~/.claude/settings.json` sets `CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5-5`, which overrides `claude --model`. clank-right 6d5e5fb fixed `review-commits` with `--settings`. The subagent transcripts (`message.model` in `~/.claude/projects/<clone>/<session>/subagents/*.jsonl`) confirm the model of every review below.

In this repo, the 74 reviews under `claude-mythos-5-1/` from Nov 2–3 were affected. Each has a twin with the same name under `claude-opus-5-5/`, so these commits had two Opus reviews (plus Codex) and no Fable or Mythos review.

## What Fable reviewed

The 74 reviews covered 297 commits on `prime` (counting the 27 commits that a rebase replaced by the commits on `prime` with the same patch). These were merged into 23 ranges of contiguous commits on `prime`, of at most 25 commits each. 17 commits that no earlier review covered sit in gaps of 1 or 2 commits inside these ranges, so Fable reviewed 314 commits in all. Fable 5.1 reviewed each range at xhigh, with `/code-review xhigh commits BASE..LAST`, in a clone with LAST checked out. Each review is saved as `~/.ai-code-reviews/claude-fable-5-1/BASE..LAST`, named with full hashes.

| Range | Commits | Findings |
|---|---|---|
| `6e4c55c..e1b3211` | 11 | 9 |
| `687d347..33aa4bd` | 6 | 8 |
| `bac22c9..5614d84` | 17 | 11 |
| `95fe423..e8527b8` | 20 | 11 |
| `9b99ddf..732d08b` | 3 | 7 |
| `2aa282c..b499a6d` | 4 | 5 |
| `7c7e939..04910db` | 22 | 8 |
| `6ab6b0c..2aa20f6` | 2 | 2 |
| `81ba8c0..fdf3f06` | 18 | 6 |
| `60eaa6d..e37116d` | 6 | 6 |
| `63cd67b..e0a73e5` | 25 | 12 |
| `e0a73e5..41fbf48` | 23 | 12 |
| `3f235dd..3854990` | 13 | 9 |
| `7d93138..7b630db` | 25 | 9 |
| `7b630db..c07989a` | 8 | 9 |
| `41cf3d4..0b98c6f` | 4 | 7 |
| `07bee56..62b07fb` | 11 | 8 |
| `b19f553..78492df` | 25 | 9 |
| `78492df..83eae5a` | 9 | 9 |
| `46fa394..7f7c8a1` | 16 | 9 |
| `e74c077..be63c0a` | 24 | 12 |
| `2fd0e5e..7849fb7` | 2 | 5 |
| `f953d64..2043dde` | 20 | 9 |

Not covered: the 18 commits from `a99af30` to `1ee62b0`, which have no saved review from Codex or Claude, and the commits after `1ee62b0`.

## Outcome

Of the 192 findings, about 137 had already been raised by an Opus or Codex review of the same commits; most of those were fixed later, and the rest were left alone on purpose. Of the 55 that no earlier review raised, most were fixed later anyway, are obsolete, or are not bugs. 38 are new and still applied at `1c11dce`: 9 are fixed below, 14 need a decision, and 15 are not worth a change.

## Fixed

| Commit | Finding | Range |
|---|---|---|
| `7021f79` | A cancel request that times out while its TCP connection is still in progress left that socket open. The socket kept the process alive until the OS gave up (about two minutes on Linux), even after `sql.end()` had resolved. A new test failed before the fix. | `7d93138..7b630db` |
| `e1d77a0` | `pnpm lint --quiet` in AGENTS.md hid the only warning left, an unused `onTestFinished` import from `cf1109e`. The import is gone, and AGENTS.md now asks for plain `pnpm lint`, which must report nothing. | `46fa394..7f7c8a1` |
| `deba62a` | Four docstrings: `idle()` promised an `idle` that a close during a cancel hold prevents; `Pooled` said its fields are undefined until set; `unsafe_transaction()` named only one of the queries that get the error; `exclusive` said "is sent, and queues". | `41cf3d4..0b98c6f`, `78492df..83eae5a`, and `Pooled` seen while triaging |
| `858a788` | `inferred()`, `same()` and `normal()` had no docstrings, and `inferred()` reads as the opposite of what it returns. | `78492df..83eae5a` |
| `e7a6d3c` | The README's `sslrootcert=system` sentence left out the `ssl` option among the places that give a mode. | `b19f553..78492df` |
| `8a48b58` | The `notice` test expects one NOTICE, but in watch mode a `users` table left from the last run makes it two. Both notice tests now drop the table. | `7d93138..7b630db` |
| `a11e3f4` | The `options` docstring in `tests/setup.ts` could attach "which no other test file uses" to the module. | `60eaa6d..e37116d` |

`review-commits` reviewed `7021f79` alone, and the six commits after it, `e1d77a0` to `a11e3f4`, as one batch. These commits act on those reviews:

| Commit | Finding |
|---|---|
| `beaf088` | The two connect_timeout tests connected to 10.255.255.1, expecting it never to answer; without a route there, they fail at once. They now share `stub_connect()`, which hands out a `net.Socket` that never connects, and which destroys its sockets when the test ends. |
| `018f24e` | A cancel request's connection that closed before the CancelRequest was written, such as while waiting for the answer to SSLRequest, went unnoticed. With connect_timeout off, `cancel()` never settled, and its hold blocked the connection for good. |
| `7ae5c47` | `normal()` deleted a tab or newline in a transaction mode instead of making it a space, so a nested `sql.begin` with the same mode, written over two lines, threw NESTED_TRANSACTION_MODE. |
| `46223de` | Three of the docstrings corrected in `deba62a` were still inexact. |
| `d4b5458` | The notice tests now create `test`, which tests/setup.ts drops before each test, instead of dropping `users` at the end, which a failed create or an interrupted run defeated. |
| `f7ad955` | `pnpm lint` now fails on a warning too (`--deny-warnings`), in CI as well. |

Left alone from those reviews: with connect_timeout off, nothing bounds a cancel request whose connection never connects, and the pool's `end()` does not destroy it; a socket from an `options.socket` factory is not destroyed at the timeout, in `cancel()` as in `attempt()`; `attempt()` and `cancel()` both keep the same "socket or raw socket" state, which a cancellable `Socket()` could replace; a CONNECT_TIMEOUT before the TCP connection is up means that the CancelRequest was not sent, yet `hold()` still abandons the connection; and `cancel()` resolves when its connection closes with an error after the CancelRequest was written.

## Decisions for you

These change public behaviour, public types or the workflow.

1. **A url with both `ssl=` and `sslmode=` silently drops `sslmode`** ([src/index.ts:1122](../src/index.ts#L1122), `read_option`). For example, `?ssl=prefer&sslmode=verify-full` connects with `prefer`, which checks no certificate. libpq reads `ssl=true` as `sslmode=require`, and refuses any other value of `ssl` as an invalid parameter. Fix: throw when the url has both. (`07bee56..62b07fb`)
2. **The `PGSSL` check throws even where `PGSSL` was never read** ([src/index.ts:1206](../src/index.ts#L1206)). With a leftover `PGSSL=1`, `postgres(url, { ssl: { ca } })` throws, and the advice in the error message, "set PGSSLMODE", would not help, because the option outranks `PGSSLMODE`. Fix: throw only when `options.ssl` would otherwise come from the environment. (`b19f553..78492df`)
3. **`min` greater than `max` is accepted, and the pool uses `max` instead** ([src/index.ts:1067](../src/index.ts#L1067), [src/pool.ts:679](../src/pool.ts#L679)). Throwing could break a setup where `PGMAX` comes from the environment and is lower than a `min` set in code. Either throw, or say in the README that `min` is capped at `max`. (`63cd67b..e0a73e5`)
4. **The options object takes `'true'`, `'false'` and `'disable'` as text for an option that is on or off**, so `{ prepare: 'false' }` turns prepare off ([src/index.ts:874](../src/index.ts#L874)). [CHANGELOG.md:34](../CHANGELOG.md#L34) gives the text forms only for the url and the environment, so it reads as if this throws. v3 took any text in the options object as on. Either document it, or throw for text in the options object. (`7d93138..7b630db`)
5. **`tx.CLOSE` and `tx.END` are undefined.** Only the pool's `sql` has them ([src/index.ts:124](../src/index.ts#L124), [types/index.d.ts:854](../types/index.d.ts#L854)), so a JavaScript cursor callback inside a transaction that returns `tx.CLOSE` keeps fetching. No test closes a cursor that runs in a transaction, through CLOSE or `break`. Adding CLOSE and END to the transaction's and the reserved connection's `sql` adds to a public type. (`e74c077..be63c0a`)
6. **`PostgresType` requires `from`, `serialize` and `parse`** ([types/index.d.ts:123](../types/index.d.ts#L123)), but src treats them as optional, and four tests cast to `any` to leave one out. Making them optional is a change to a public type. (`e74c077..be63c0a`)
7. **Nothing runs oxfmt:** neither "Before committing" in AGENTS.md nor CI. HEAD passes `oxfmt --check .`, but drift has needed fix-up commits before (`5e28a77`). (`6ab6b0c..2aa20f6`)
8. **When `sql.end({ timeout })` destroys a connection in a transaction, the lease's `CONNECTION_CLOSED` drops the in-flight query's `query`, `parameters`, `args` and the caller's stack** ([src/pool.ts:1327](../src/pool.ts#L1327)). It affects only diagnostics, during a forced shutdown. (`81ba8c0..fdf3f06`)

## Small and optional

Each is a few lines; none fixes a bug.

- `cancel()` resolves for a query that a close fails before it reached the head; the comment says only "settled", and [types/index.d.ts:624](../types/index.d.ts#L624) mentions only rejecting. (`63cd67b..e0a73e5`)
- No test that `idle_timeout` closes a connection that a cancel request holds forever, the case that `2fff2f3` was for. About 25 lines. (`41cf3d4..0b98c6f`)
- [.oxfmtrc.json:2](../.oxfmtrc.json#L2) ignores `*.yml` but not `*.yaml`, so oxfmt would reformat a future `pnpm-workspace.yaml`. (`687d347..33aa4bd`)
- [tests/helpers.ts:73](../tests/helpers.ts#L73): `with_env()` could assert that `f` returned no promise; every current caller is synchronous. (`7b630db..c07989a`)
- [tests/listen.test.ts:73](../tests/listen.test.ts#L73), 129 and 141: three listen-and-notify tests differ only in the channel name (`test.each`). (`46fa394..7f7c8a1`)
- [.oxlintrc.json:21](../.oxlintrc.json#L21): "what does from now on is an error" is history and can be read more than one way. (`46fa394..7f7c8a1`)

## Checked and left alone

- **`sql("a", ["b", "c"])` throws `x.replace is not a function`.** Fable and the triage called this a regression from `61f6025`, which turned `[first].concat(rest)` into `[first, ...rest]`. It is not one: `concat` spreads only `rest` itself, not the array inside it, and the call throws the same way at `61f6025^`. TypeScript rejects the call: with a string first, the type of the rest is `readonly string[]`. (`e74c077..be63c0a`)
- Not worth a change: the `string | null` types of `host`, `database` and `user`, which match what the code does; `Queue.take()`'s filter, which never drops anything; the helpers that `util.inspect` shows as `value`; `configurable: true` on the getters that throw CASING_TRANSFORM_REMOVED; `await` inside `expect()`; a lease's error with a cursor paused in its callback; the comment "settle_error adds x's query"; `helper_pool` never being ended; `orderly` with a FATAL after Terminate; a first chunk shorter than 8 bytes in the tracing proxy; `exclusive` repeating `cancelling > 0`; `x.error === fatal` when both are null; the test encoders that resemble those in `tests/bench_decoders.ts`; the pools of the `connect_timeout` tests that are never ended; and a missing "run `pnpm install` first" in AGENTS.md.

## Seen while triaging, not from Fable

- [.oxlintrc.json:111](../.oxlintrc.json#L111): `typescript/no-useless-default-assignment` and `typescript/no-unnecessary-boolean-literal-compare` are off because "`strict: false` in tsconfig.json" turns off strictNullChecks, but `strict` has been `true` since `46b97db`. Turned on, they report 6 errors (src/socket.ts, src/pool.ts, src/startup.ts, src/index.ts, and 2 in src/build.ts).
- [CHANGELOG.md:132](../CHANGELOG.md#L132): the v4.0.0 "Testing" section still describes upstream's runners (Node 20, `tests/cf/run.sh`, Bun and Deno in CI, `COVERAGE_MIN`). Earlier reviews raised this several times, and it is a known open item from the vitest conversion.
