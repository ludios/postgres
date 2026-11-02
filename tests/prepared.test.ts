import { expect, test } from "vitest";
import type { Sql, ISql, Row } from "../types/index.js";
import { postgres, sql, options, delay, defer } from "./setup.ts";

test("unsafe describe", async () => {
	const q = "insert into test values (1)";
	await sql`create table test(a int unique)`;
	await sql.unsafe(q).describe();
	const x = await sql.unsafe(q).describe();
	expect(x.string).toBe(q);
});

test("Automatically creates prepared statements", async () => {
	const sql = postgres(options);
	const result = await sql`select * from pg_prepared_statements`;
	expect(result.map((x) => x.name)).toContain(result.statement.name);
});

test("no_prepare: true disables prepared statements (deprecated)", async () => {
	const sql = postgres({ ...options, no_prepare: true });
	const result = await sql`select * from pg_prepared_statements`;
	expect([result.statement.name, result.map((x) => x.name)]).toEqual(["", []]);
});

test("prepare: false disables prepared statements", async () => {
	const sql = postgres({ ...options, prepare: false });
	const result = await sql`select * from pg_prepared_statements`;
	expect([result.statement.name, result.map((x) => x.name)]).toEqual(["", []]);
});

test("prepare: true enables prepared statements", async () => {
	const sql = postgres({ ...options, prepare: true });
	const result = await sql`select * from pg_prepared_statements`;
	expect(result.map((x) => x.name)).toContain(result.statement.name);
});

test('prepares unsafe query when "prepare" option is true', async () => {
	const sql = postgres({ ...options, prepare: true });
	const result = await sql.unsafe(
		"select * from pg_prepared_statements where name <> $1",
		["bla"],
		{ prepare: true },
	);
	expect(result.map((x) => x.name)).toContain(result.statement.name);
});

test("does not prepare unsafe query by default", async () => {
	const sql = postgres({ ...options, prepare: true });
	const result = await sql.unsafe("select * from pg_prepared_statements where name <> $1", ["bla"]);
	expect([result.statement.name, result.map((x) => x.name)]).toEqual(["", []]);
});

test("Recreate prepared statements on transformAssignedExpr error", async () => {
	const insert = () => sql`insert into test (name) values (${"1"}) returning name`;
	await sql`create table test (name text)`;
	await insert();
	await sql`alter table test alter column name type int using name::integer`;
	expect((await insert())[0].name).toBe(1);
});

test("Recreate prepared statements on RevalidateCachedQuery error", async () => {
	const select = () => sql`select name from test`;
	await sql`create table test (name text)`;
	await sql`insert into test values ('1')`;
	await select();
	await sql`alter table test alter column name type int using name::integer`;
	expect((await select())[0].name).toBe(1);
});

test("Does not re-serialize json parameters when retrying on RevalidateCachedQuery error", async () => {
	const update = () =>
		sql`update test set config = ${sql.json({ warmup: 2100000000, ticksLimit: 5000 })} returning *`;
	await sql`create table test (id int, config jsonb)`;
	await sql`insert into test values (1, '{}')`;
	await update();
	await sql`alter table test add column extra int`;
	await update();
	expect((await sql`select jsonb_typeof(config) as type from test`)[0].type).toBe("object");
});

test("Does not re-serialize json parameters when retrying on FetchPreparedStatement error", async () => {
	const insert = () => sql`insert into test (config) values (${sql.json({ warmup: 2100000000 })})`;
	await sql`create table test (config jsonb)`;
	await insert();
	await sql`deallocate all`;
	await insert();
	expect((await sql`select jsonb_typeof(config) as type from test`).map((x) => x.type)).toEqual([
		"object",
		"object",
	]);
});

test("Does not re-serialize boolean parameters when retrying on RevalidateCachedQuery error", async () => {
	const update = () => sql`update test set enabled = ${true} returning *`;
	await sql`create table test (id int, enabled bool)`;
	await sql`insert into test values (1, false)`;
	await update();
	await sql`alter table test add column extra int`;
	await update();
	expect((await sql`select enabled from test`)[0].enabled).toBe(true);
});

test("Does not re-serialize boolean parameters when retrying on FetchPreparedStatement error", async () => {
	const insert = () => sql`insert into test (enabled) values (${true})`;
	await sql`create table test (enabled bool)`;
	await insert();
	await sql`deallocate all`;
	await insert();
	expect((await sql`select enabled from test`).map((x) => x.enabled)).toEqual([true, true]);
});

test("Does not re-serialize bytea parameters when retrying on RevalidateCachedQuery error", async () => {
	const update = () => sql`update test set data = ${Buffer.from("hello")} returning *`;
	await sql`create table test (id int, data bytea)`;
	await sql`insert into test values (1, null)`;
	await update();
	await sql`alter table test add column extra int`;
	await update();
	expect((await sql`select data from test`)[0].data).toEqual(Buffer.from("hello"));
});

test("Does not re-serialize bytea parameters when retrying on FetchPreparedStatement error", async () => {
	const insert = () => sql`insert into test (data) values (${Buffer.from("hello")})`;
	await sql`create table test (data bytea)`;
	await insert();
	await sql`deallocate all`;
	await insert();
	expect((await sql`select data from test`).map((x) => x.data.toString())).toEqual([
		"hello",
		"hello",
	]);
});

test("Properly throws routine error on not prepared statements", async () => {
	await sql`create table x (x text[])`;
	await using _drop = defer(() => sql`drop table x`);
	const { routine } = await sql
		.unsafe(`
    insert into x(x) values (('a', 'b'))
  `)
		.catch((e) => e);
	expect(routine).toBe("transformAssignedExpr");
});

test("Properly throws routine error on not prepared statements using file", async () => {
	const { routine } = await sql
		.unsafe(
			`
    create table x (x text[]);
    insert into x(x) values (('a', 'b'));
  `,
			{ prepare: true },
		)
		.catch((e) => e);

	expect(routine).toBe("transformAssignedExpr");
});

test("Describe", async () => {
	const type = (await sql`select ${1}::int as x`.describe()).types[0];
	expect(type).toBe(23);
});

test("Describe a statement", async () => {
	await sql`create table tester (name text, age int)`;
	await using _drop = defer(() => sql`drop table tester`);
	const r = await sql`select name, age from tester where name like $1 and age > $2`.describe();
	expect([r.types, r.columns.map((c) => [c.name, c.type])]).toEqual([
		[25, 23],
		[
			["name", 25],
			["age", 23],
		],
	]);
});

test("Describe a statement without parameters", async () => {
	await sql`create table tester (name text, age int)`;
	await using _drop = defer(() => sql`drop table tester`);
	const r = await sql`select name, age from tester`.describe();
	expect([r.types.length, r.columns.length]).toEqual([0, 2]);
});

test("Describe a statement without columns", async () => {
	await sql`create table tester (name text, age int)`;
	await using _drop = defer(() => sql`drop table tester`);
	const r = await sql`insert into tester (name, age) values ($1, $2)`.describe();
	expect([r.types.length, r.columns.length]).toEqual([2, 0]);
});

test("Fails a stale prepared statement once when a query is piped behind it", async () => {
	await using sql = postgres(options);
	const piped = () => Promise.all([sql`select 1 as x`, sql`select 2 as x`]);
	await piped();
	await sql`deallocate all`;
	const error = await piped().catch((e) => e);
	expect([error.code, (await piped()).map(([{ x }]) => x)]).toEqual(["26000", [1, 2]]);
});

test("Holds the connection while retrying a prepared statement", async () => {
	let builds = 0,
		other: Promise<Row[]>;
	await using sql = postgres({
		...options,
		debug: (_, x) =>
			x === "select * from test where id = $1" && ++builds === 3 && (other = get(2).execute()),
	});
	const read = (id: number) => sql`select * from test where id = ${id}`;
	const get = (id: number) => sql`select id, name, null::int as extra from test where id = ${id}`;
	await sql`create table test (id int, name text)`;
	await sql`insert into test values (1, 'a'), (2, 'b')`;
	await read(1);
	await get(2);
	await sql`alter table test add column extra int`;
	const [x] = await read(1);
	const [y] = await other;
	expect([x.id, x.name, y.id, y.name]).toEqual([1, "a", 2, "b"]);
});

test("Answers two stale prepared statements piped together", async () => {
	await using sql = postgres(options);
	const read = (id: number) => sql`select * from test where id = ${id}`;
	await sql`create table test (id int, name text)`;
	await sql`insert into test values (1, 'a'), (2, 'b')`;
	await read(1);
	await sql`alter table test add column extra int`;
	const [error, [x]] = await Promise.all([read(1).catch((e) => e), read(2)]);
	const [y] = await sql`select 3 as id, 'c' as name`;
	const [z] = await read(1);
	expect([error.code, [x.id, x.name], [y.id, y.name], [z.id, z.name]]).toEqual([
		"0A000",
		[2, "b"],
		[3, "c"],
		[1, "a"],
	]);
});

test("A stale prepared statement retried with a transaction queued behind it stays outside the transaction", async () => {
	await using sql = postgres(options);
	const insert = (x: string) => sql`insert into test (name) values (${x}) returning *`;
	await sql`create table test (id serial primary key, name text)`;
	await insert("a");
	await sql`alter table test add column extra int`;
	await Promise.all([
		insert("b"),
		sql
			.begin(async (tx) => {
				await tx`select 1`;
				throw new Error("rollback");
			})
			.catch((): null => null),
	]);
	expect((await sql`select name from test order by id`).map((x) => x.name)).toEqual(["a", "b"]);
});

test("Does not give a stale prepared statement the answer of a statement piped behind it", async () => {
	await using sql = postgres(options);
	const select = () => sql`select * from test order by id`;
	const get = (id: number) => sql`select name from test where id = ${id}`;
	await sql`create table test (id int, name text)`;
	await sql`insert into test values (1, 'a'), (2, 'b')`;
	await select();
	await sql`alter table test add column extra int`;
	const [error, [x]] = await Promise.all([select().catch((e) => e), get(2)]);
	const [y] = await get(2);
	expect([error.code, x.name, y.name]).toEqual(["0A000", "b", "b"]);
});

test("Does not reorder writes on a reserved connection when retrying a stale prepared statement", async () => {
	await using sql = postgres(options);
	using reserved = await sql.reserve();
	await reserved`create table test (id int primary key, name text)`;
	await reserved`insert into test values (1, 'a')`;
	await reserved`delete from test`;
	await reserved`deallocate all`;
	const [error] = await Promise.all([
		reserved`insert into test values (1, 'a')`.catch((e) => e),
		reserved`update test set name = 'b' where id = 1`,
	]);
	// The pool has one connection, which the select below needs
	reserved.release();
	expect([error.code, await sql`select name from test`]).toEqual(["26000", []]);
});

test("Does not retry a cancelled stale prepared statement", async () => {
	await using sql = postgres(options);
	await sql`select 1 as x`;
	await sql`deallocate all`;
	void sql`select pg_sleep(0.5)`.execute();
	const query = sql`select 1 as x`.execute();
	setTimeout(() => query.cancel(), 100);
	expect((await query.catch((e) => e)).code).toBe("26000");
});

test("Stale prepared statements in a transaction returning an array of queries reject and release the connection", async () => {
	await using other = postgres(options);
	await sql`create table test (id int, a int)`;
	await sql`insert into test values (1, 1)`;
	await other`select * from test where id = ${1}`;
	await other`select id from test where id = ${1} and a > ${0}`;
	await sql`alter table test add column b int`;
	const error = await other
		.begin((tx) => [
			tx`select * from test where id = ${1}`,
			tx`select id from test where id = ${1} and a > ${0}`,
		])
		.catch((e) => e.code);
	const [row] = await other`select * from test where id = ${1}`;
	expect([error, "b" in row]).toEqual(["0A000", true]);
});

test("Stale prepared statement is not retried after the transaction it was pipelined in ends", async () => {
	await using other = postgres(options);
	await sql`create table test (id int, a int)`;
	await sql`insert into test values (1, 1)`;
	await other`update test set a = a + ${1} where id = 1 returning *`;
	await sql`alter table test add column b int`;
	using reserved = await other.reserve();
	const results = await Promise.all(
		[
			reserved`begin`,
			reserved`insert into test values (2, 2)`,
			reserved`update test set a = a + ${1} where id = 1 returning *`,
			reserved`commit`,
		].map((x) =>
			x.then(
				(result) => result.command,
				(e) => e.code,
			),
		),
	);
	const rows = await sql`select id, a from test order by id`;
	expect([results, rows]).toEqual([["BEGIN", "INSERT", "0A000", "ROLLBACK"], [{ id: 1, a: 2 }]]);
});

test("prepare: false describes every time, so a changed column type is seen at once, as in v3", async () => {
	await using sql = postgres({ ...options, prepare: false, max: 1 });
	const insert = (x: any) => sql`insert into test values (${x}) returning x::text as x`;
	await sql`create table test (x boolean)`;
	const [a] = await insert(true);
	await sql`alter table test alter column x type int using x::int`;
	const [b] = await insert(1);
	await sql`alter table test alter column x type json using to_json(x)`;
	const [c] = await insert({ a: 1 });
	expect([a.x, b.x, c.x]).toEqual(["true", "1", '{"a":1}']);
});

test("A prepared statement that a changed column type no longer fits is prepared again and the query re-run", async () => {
	await using sql = postgres({ ...options, max: 1 });
	const insert = (x: number | string) => sql`insert into test values (${x}) returning x::text as x`;
	await sql`create table test (x int)`;
	await insert(1);
	await sql`alter table test alter column x type uuid using null`;
	const id = "6f1c2c43-6f6b-4a40-9a39-2d8f4a1f3b11";
	const rows = [];
	for (let i = 0; i < 3; i++) {
		rows.push((await insert(id))[0].x);
	}
	expect(rows).toEqual([id, id, id]);
});

test("A value the learned types cannot write is written for a fresh description", async () => {
	await using sql = postgres({ ...options, max: 1 });
	const insert = (x: number | Buffer) => sql`insert into test values (${x}) returning x::text as x`;
	await sql`create table test (x bytea)`;
	await insert(Buffer.from("hi"));
	await sql`alter table test alter column x type int using null`;
	const [{ x }] = await insert(7);
	expect(x).toBe("7");
});

test("A prepared statement made on a new connection has the types the pool writes values for", async () => {
	await using sql = postgres({ ...options, max: 1 });
	const insert = (x: string) => sql`insert into test values (${x}) returning x::text as x`;
	await sql`create table test (x text)`;
	await insert("123");
	await sql.close();
	await sql`alter table test alter column x type json using null`;
	const [{ x }] = await insert("123");
	expect(x).toBe('"123"');
});

test("A query waiting on another query's description of the same statement does not get that query's error", async () => {
	await using sql = postgres({ ...options, max: 4 });
	await Promise.all([1, 2, 3].map(() => sql`select pg_sleep(0.02)`));
	const out: unknown[] = [];
	await sql
		.begin(async (tx) => {
			await tx`select 1/0`.catch(() => {});
			const a = tx`select ${1}::int as shared_describe_shape`.then(
				() => "ok",
				(e) => e.code,
			);
			for (let i = 0; i < 5; i++) {
				await Promise.resolve();
			}
			const b = sql`select ${2}::int as shared_describe_shape`.then(
				(x) => x[0].shared_describe_shape,
				(e) => e.code,
			);
			out.push(...(await Promise.all([a, b])));
		})
		.catch(() => {});
	expect(out).toEqual(["25P02", 2]);
});

test("An invalid value for a prepared statement keeps the statement and leaves nothing behind on the server", async () => {
	await using sql = postgres({ ...options, max: 4 });
	await sql`create table test (id uuid)`;
	const q = (id: string) => sql`select * from test where id = ${id}`,
		zero = "00000000-0000-0000-0000-000000000000";
	const counts = async () => {
		const reserved = await Promise.all([1, 2, 3, 4].map(() => sql.reserve()));
		const n = await Promise.all(
			reserved.map((r) =>
				r`select count(*)::int as n from pg_prepared_statements`.then((x) => x[0].n),
			),
		);
		reserved.forEach((r) => r.release());
		return Math.max(...n);
	};
	await Promise.all(Array.from({ length: 40 }, () => q(zero)));
	const before = await counts();
	const codes = new Set();
	for (let i = 0; i < 50; i++) {
		await Promise.all([q("not-a-uuid").catch((e) => codes.add(e.code)), q(zero), q(zero), q(zero)]);
	}
	const after = await counts();
	expect([[...codes], after <= before + 1]).toEqual([["22P02"], true]);
});

test("A connection that prepares a statement for the first time reads the columns it has now, not those another connection learned", async () => {
	await using sql = postgres({ ...options, max: 2 });
	await sql`create table test (id int, v int)`;
	await sql`insert into test values (1, 10)`;
	using reserved = await sql.reserve();
	const query = (sql: ISql) => sql`select * from test where id = ${1}`;
	const before = await query(reserved);
	await sql`alter table test alter column v type text using '0' || v::text`;
	await sql`alter table test add column w text default 'new'`;
	const after = await query(sql);
	expect([before, after]).toEqual([[{ id: 1, v: 10 }], [{ id: 1, v: "010", w: "new" }]]);
});

test("A connection that prepares a statement for the first time writes values for the parameter types it has now", async () => {
	await using sql = postgres({ ...options, max: 2 });
	await sql`create table test (id int, v boolean)`;
	using reserved = await sql.reserve();
	const insert = (sql: ISql, id: number, v: string) => sql`insert into test values (${id}, ${v})`;
	await insert(reserved, 1, "false");
	await sql`alter table test alter column v type text`;
	await insert(sql, 2, "yes");
	await insert(reserved, 3, "no");
	expect((await sql`select v from test order by id`).map((x) => x.v)).toEqual([
		"false",
		"yes",
		"no",
	]);
});

test("The same query in schemas of different shape gets the rows of its own schema on every connection", async () => {
	await using sql = postgres({ ...options, max: 2 });
	await sql.unsafe(`
    create schema tenant_a; create schema tenant_b;
    create table tenant_a.t (id int, val int); insert into tenant_a.t values (1, 42);
    create table tenant_b.t (id int, label text); insert into tenant_b.t values (1, 'hello')
  `);
	await using _drop = defer(() =>
		sql.unsafe("drop schema tenant_a cascade; drop schema tenant_b cascade"),
	);
	const tenant = (schema: string, hold: number) =>
		sql.begin(async (tx) => {
			await tx`select set_config('search_path', ${schema}, true)`;
			const [row] = await tx`select * from t where id = ${1}`;
			await delay(hold);
			return row;
		});
	const results = [];
	for (let i = 0; i < 5; i++) {
		results.push(await Promise.all([tenant("tenant_a", 20), tenant("tenant_b", 10)]));
	}
	expect(results).toEqual(
		Array.from({ length: 5 }, () => [
			{ id: 1, val: 42 },
			{ id: 1, label: "hello" },
		]),
	);
});

test("A late 26000 does not make the connection forget a statement prepared again behind it", async () => {
	await using sql = postgres({ ...options, max: 1 });
	const query = () => sql`select ${1}::int as x`;
	const code = (x: Promise<unknown>) =>
		x.then(
			() => "ok",
			(e) => e.code,
		);
	await query();
	const deallocated = sql.unsafe("deallocate all").execute();
	let third: Promise<string>;
	const first = query().catch((e) => {
		third = code(query());
		return e.code;
	});
	const sleep = sql.unsafe("select pg_sleep(0.1)").execute();
	const second = query().execute();
	const before = [
		await code(deallocated),
		await first,
		await code(sleep),
		await code(second),
		await third,
	];
	const after = [];
	for (let i = 0; i < 3; i++) {
		after.push(await code(query()));
	}
	expect([before, after]).toEqual([
		["ok", "26000", "ok", "26000", "ok"],
		["ok", "ok", "ok"],
	]);
});

test("Stale statements pipelined on the pool are all run again", async () => {
	await using sql = postgres({ ...options, max: 2 });
	await sql`create table test (id int, v int)`;
	await sql`insert into test values (1, 10)`;
	const query = () => sql`select v from test where id = ${1}`;
	await Promise.all([query(), query(), query(), query()]);
	await sql`alter table test alter column v type text`;
	const results = await Promise.all(
		[...Array(6)].map(() =>
			query().then(
				(x) => x[0].v,
				(e) => e.code,
			),
		),
	);
	expect(results).toEqual(Array(6).fill("10"));
});

test("A statement name the server already has on a connection is prepared under a new name (#960)", async () => {
	await using sql = postgres({ ...options, max: 2, prepare: true });
	using one = await sql.reserve();
	using two = await sql.reserve();
	const first = await one`select ${1}::int as x`;
	await two.unsafe('prepare "' + first.statement.name + '" as select $1::int as x');
	const [{ x }] = await two`select ${3}::int as x`;
	const [{ x: y }] = await two`select ${4}::int as x`;
	expect([x, y]).toEqual([3, 4]);
});

test("Statements past the connection and pool limits are closed and prepared again when used", async () => {
	await using sql = postgres({ ...options, max: 1, prepare: true });
	const run = (i: number) => sql.unsafe("select $1::int + " + i + " as x", [1], { prepare: true });
	for (let i = 0; i < 2100; i += 100) {
		await Promise.all(Array.from({ length: 100 }, (_, j) => run(i + j)));
	}
	const [{ n }] = await sql`select count(*)::int as n from pg_prepared_statements`,
		[{ x }] = await run(0);
	expect([n <= 1001, x]).toEqual([true, 1]);
}, 30_000);

/**
 * Runs a query that returns a row of 1 MB, through a statement that `pool` prepares for it, and
 * forgets the rows.
 *
 * @param pool - the `sql` of the pool to run the query on
 * @param refs - gets a WeakRef to the rows, which tells whether something still keeps them
 */
async function prepare_and_forget(pool: Sql, refs: WeakRef<Row[]>[]) {
	const rows = await pool`select repeat('x', ${1e6}) as x`;
	refs.push(new WeakRef(rows));
}

test("A cached prepared statement does not keep the rows of the query that prepared it (#1287)", async ({
	skip,
}) => {
	const v8 = await import("v8"),
		vm = await import("vm");
	let gc;
	try {
		v8.setFlagsFromString("--expose-gc");
		gc = vm.runInNewContext("gc");
	} catch {
		skip("this runtime cannot expose gc()");
	}

	// idle_timeout: null, so that the connection stays open, with the statement in its cache
	await using pool = postgres({ ...options, max: 1, idle_timeout: null });
	const refs: WeakRef<Row[]>[] = [];
	await prepare_and_forget(pool, refs);
	for (let i = 0; i < 5; i++) {
		await delay(10);
		gc();
	}

	const [{ n }] =
		await pool`select count(*)::int as n from pg_prepared_statements where statement like 'select repeat%'`;
	expect([refs[0].deref() === undefined, n]).toEqual([true, options.prepare === false ? 0 : 1]);
});
