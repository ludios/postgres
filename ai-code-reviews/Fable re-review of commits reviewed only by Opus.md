# Fable 5.1 re-review of the commits that only Opus reviewed

Triaged on 2026-11-03. Line numbers are at `33b7849` on `prime`.

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

Of the 192 findings, about 137 had already been raised by an Opus or Codex review of the same commits; most of those were fixed later, and the rest were left alone on purpose. Of the 55 that no earlier review raised, most were fixed later anyway, are obsolete, or are not bugs. 38 are new and still applied at `1c11dce`: 9 were fixed at once, 14 needed a decision (7 of them are done since, 6 are open, and 1 was not worth it), and 15 are not worth a change.

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

## Done after the triage

On 2026-11-03, after reading the triage, you asked for the tooling and docs findings, the small optional ones, and the two seen while triaging:

| Commit | Finding |
|---|---|
| `760fd66` | `.oxfmtrc.json` ignored `*.yml` but not `*.yaml`. (`687d347..33aa4bd`) |
| `d27d188` | Nothing ran oxfmt: now `pnpm format:check` does, before committing and in CI, with oxfmt as a devDependency. (`6ab6b0c..2aa20f6`) |
| `300605e` | `.oxlintrc.json` turned off `typescript/no-useless-default-assignment` and `typescript/no-unnecessary-boolean-literal-compare` because of `strict: false`, but `strict` has been `true` since `46b97db`; they are on, and their 6 errors fixed. (seen while triaging) |
| `9856ec2` | The v4.0.0 "Testing" section of CHANGELOG.md described upstream's runners: Node 20, `tests/cf/run.sh`, Bun and Deno in CI, `COVERAGE_MIN`. (`687d347..33aa4bd`, and earlier reviews) |
| `c3067fa` | `with_env()` now throws if its function returns a promise, which would run on after the variables are restored. (`7b630db..c07989a`) |
| `ed5d427` | The three listen-and-notify tests that differed only in the channel's name are one `test.each`. (`46fa394..7f7c8a1`) |
| `1ccb0cd` | The `.oxlintrc.json` comment "what does from now on is an error" is gone. (`46fa394..7f7c8a1`) |
| `cb10f9f` | A query's `cancel()` resolves without a cancel request once the connection closes, for a query not yet at the head; the comment said only "settled", and the public docstring said only when it rejects. (`63cd67b..e0a73e5`) |
| `e5e2356` | A test that `idle_timeout` closes a connection that a cancel request holds for good, the case that `2fff2f3` was for. It fails if no idle timer starts during the hold. (`41cf3d4..0b98c6f`) |

`review-commits` reviewed these nine commits as one batch, `760fd66` to `e5e2356`. These commits act on that review:

| Commit | Finding |
|---|---|
| `598f0ce` | A custom type given by name made every `sql.listen()` reject with TYPE_NOT_FOUND, because the LISTEN pool, made with `fetch_types: false`, carried the custom types. It now carries none. |
| `ea3a6ac` | Once it had written the CancelRequest, `cancel()` took any close of its connection as the server's. A socket from `options.socket` is handed over before it connects, so a refused connection made `cancel()` resolve as if the request had been handled. |
| `5628ce0` | A failed cancel request for a query sent behind another was reported twice (and, on CONNECT_TIMEOUT, abandoned the connection twice), because two holds followed it. |
| `bfd5009` | The docs of a query's `cancel()` in `cb10f9f` left out that a request may already be on its way when the connection closes, and `Query.cancel()`'s docstring still said only when it rejects. |
| `2c0bdc1` | The options that two test files make by hand now set `onread` and `channel_binding`, as `parse_options()` does. |
| `dd59f54` | `with_env()` refuses any thenable, not only a native promise, and handles the refused one's rejection. |
| `ab0d2b3` | The idle_timeout test of a held connection moved from tracing.test.ts to queries.test.ts; `is_cancel_request()` in tests/setup.ts replaced two copies of the CancelRequest check, with a check of the chunk's length; the test's query sleeps 10 s instead of 2. |
| `33b7849` | `pnpm format` fixes what `pnpm format:check` reports, with the pinned oxfmt. |

Left alone from that review: moving the TYPE_NOT_FOUND check into `parse_options()`, which would check only the options that a user gives; `parse_options()` passing hand-made options with `shared` through without filling in defaults; and a helper for the fixture that the two proxy tests of a held cancel request share.

## Open

Deferred: on 2026-11-03 you chose to keep these here for now. Each changes how options are read.

- **A url with both `ssl=` and `sslmode=` silently drops `sslmode`** ([src/index.ts:1127](../src/index.ts#L1127), `read_option`). For example, `?ssl=prefer&sslmode=verify-full` connects with `prefer`, which checks no certificate. libpq reads `ssl=true` as `sslmode=require`, and refuses any other value of `ssl` as an invalid parameter. Fix: throw when the url has both. (`07bee56..62b07fb`)
- **The `PGSSL` check throws even where `PGSSL` was never read** ([src/index.ts:1211](../src/index.ts#L1211)). With a leftover `PGSSL=1`, `postgres(url, { ssl: { ca } })` throws, and the advice in the error message, "set PGSSLMODE", would not help, because the option outranks `PGSSLMODE`. Fix: throw only when `options.ssl` would otherwise come from the environment. (`b19f553..78492df`)
- **`min` greater than `max` is accepted, and the pool uses `max` instead** ([src/index.ts:1072](../src/index.ts#L1072), [src/pool.ts:682](../src/pool.ts#L682)). Throwing could break a setup where `PGMAX` comes from the environment and is lower than a `min` set in code. Either throw, or say in the README that `min` is capped at `max`. (`63cd67b..e0a73e5`)
- **The options object takes `'true'`, `'false'` and `'disable'` as text for an option that is on or off**, so `{ prepare: 'false' }` turns prepare off ([src/index.ts:879](../src/index.ts#L879)). [CHANGELOG.md:34](../CHANGELOG.md#L34) gives the text forms only for the url and the environment, so it reads as if this throws. v3 took any text in the options object as on. Either document it, or throw for text in the options object. (`7d93138..7b630db`)

Explained to you on 2026-11-03, awaiting a decision. Each changes a public type.

- **`tx.CLOSE` and `tx.END` are undefined.** Only the pool's `sql` has them ([src/index.ts:124](../src/index.ts#L124), [types/index.d.ts:855](../types/index.d.ts#L855)), so a JavaScript cursor callback inside a transaction that returns `tx.CLOSE` keeps fetching. No test closes a cursor that runs in a transaction, through CLOSE or `break`. Adding CLOSE and END to the transaction's and the reserved connection's `sql` adds to a public type. (`e74c077..be63c0a`)
- **`PostgresType` requires `from`, `serialize` and `parse`** ([types/index.d.ts:123](../types/index.d.ts#L123)), but src treats them as optional, and four tests cast to `any` to leave one out. Making them optional is a change to a public type. (`e74c077..be63c0a`)

Not put to you, as it affects only diagnostics during a forced shutdown:

- **When `sql.end({ timeout })` destroys a connection in a transaction, the lease's `CONNECTION_CLOSED` drops the in-flight query's `query`, `parameters`, `args` and the caller's stack** ([src/pool.ts:1349](../src/pool.ts#L1349)). It affects only diagnostics, during a forced shutdown. (`81ba8c0..fdf3f06`)

## Checked and left alone

- **`sql("a", ["b", "c"])` throws `x.replace is not a function`.** Fable and the triage called this a regression from `61f6025`, which turned `[first].concat(rest)` into `[first, ...rest]`. It is not one: `concat` spreads only `rest` itself, not the array inside it, and the call throws the same way at `61f6025^`. TypeScript rejects the call: with a string first, the type of the rest is `readonly string[]`. (`e74c077..be63c0a`)
- Not worth a change: the `string | null` types of `host`, `database` and `user`, which match what the code does; `Queue.take()`'s filter, which never drops anything; the helpers that `util.inspect` shows as `value`; `configurable: true` on the getters that throw CASING_TRANSFORM_REMOVED; `await` inside `expect()`; a lease's error with a cursor paused in its callback; the comment "settle_error adds x's query"; `helper_pool` never being ended; `orderly` with a FATAL after Terminate; a first chunk shorter than 8 bytes in the tracing proxy; `exclusive` repeating `cancelling > 0`; `x.error === fatal` when both are null; the test encoders that resemble those in `tests/bench_decoders.ts`; the pools of the `connect_timeout` tests that are never ended; and a missing "run `pnpm install` first" in AGENTS.md.
