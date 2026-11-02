<!-- clank-right
languages   = ["javascript"]
conventions = "ours"
-->

# This fork

This is a fork of [porsager/postgres](https://github.com/porsager/postgres) (remote `origin`); ours is ludios/postgres (remote `gh`). Work happens on `prime`.

We're reworking all of it to follow the code conventions above and to test with `vitest`. Most of the existing code is still in upstream's style (2-space indents, no semicolons, camelCase, `.eslintrc.json`): don't imitate it in new code, and convert the code you rework.

Renaming anything public (see `types/index.d.ts`) breaks users of the library; ask first.

The tests not yet moved to vitest use upstream's harness in `tests/test.js`: `t(name, fn)`, where `fn` returns `[expected, got]` and the test passes if `expected === got`.

# Before committing

These need no PostgreSQL server:

	node tests/unit
	node tests/simulate.js

The integration tests (`node tests/index.js`) need a PostgreSQL server set up the way `.github/workflows/test.yml` does it (SSL on, `wal_level = logical`, `tests/pg_hba.conf`); there's no local recipe for that yet.
