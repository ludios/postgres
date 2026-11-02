import { expect, test } from "vitest";
import { postgres, sql, options, delay, rel } from "./setup.ts";

test("Escapes", async () => {
	expect(Object.keys((await sql`select 1 as ${sql('hej"hej')}`)[0])[0]).toBe('hej"hej');
});

test("sql file", async () => {
	expect((await sql.file(rel("select.sql")))[0].x).toBe(1);
});

test("sql file has forEach", async () => {
	let result;
	await sql.file(rel("select.sql"), { cache: false }).forEach(({ x }) => (result = x));

	expect(result).toBe(1);
});

test("sql file cached", async () => {
	await sql.file(rel("select.sql"));
	await delay(20);

	expect((await sql.file(rel("select.sql")))[0].x).toBe(1);
});

test("Parameters in file", async () => {
	const result = await sql.file(rel("select-param.sql"), ["hello"]);
	expect(result[0].x).toBe("hello");
});

test("unsafe", async () => {
	await sql`create table test (x int)`;
	expect((await sql.unsafe("insert into test values ($1) returning *", [1]))[0].x).toBe(1);
	await sql`drop table test`;
});

test("unsafe simple", async () => {
	expect((await sql.unsafe("select 1 as x"))[0].x).toBe(1);
});

test("unsafe simple includes columns", async () => {
	expect((await sql.unsafe("select 1 as x").values()).columns[0].name).toBe("x");
});

test("simple query using unsafe with multiple statements", async () => {
	expect((await sql.unsafe("select 1 as x;select 2 as x")).map((x) => x[0].x).join()).toBe("1,2");
});

test("simple query using simple() with multiple statements", async () => {
	expect((await sql`select 1 as x;select 2 as x`.simple()).map((x) => x[0].x).join()).toBe("1,2");
});

test("big query body", async () => {
	await sql`create table test (x int)`;
	expect(
		(await sql`insert into test ${sql([...Array(50000).keys()].map((x) => ({ x })))}`).count,
	).toBe(50000);
	await sql`drop table test`;
});

test("let postgres do implicit cast of unknown types", async () => {
	await sql`create table test (x timestamp with time zone)`;
	const [{ x }] = await sql`insert into test values (${new Date().toISOString()}) returning *`;
	expect(x instanceof Date).toBe(true);
	await sql`drop table test`;
});

test("only allows one statement", async () => {
	expect(await sql`select 1; select 2`.catch((e) => e.code)).toBe("42601");
});

test("dynamic table name", async () => {
	await sql`create table test(a int)`;
	expect((await sql`select * from ${sql("test")}`).count).toBe(0);
	await sql`drop table test`;
});

test("dynamic schema name", async () => {
	await sql`create table test(a int)`;
	expect((await sql`select * from ${sql("public")}.test`).count).toBe(0);
	await sql`drop table test`;
});

test("dynamic schema and table name", async () => {
	await sql`create table test(a int)`;
	expect((await sql`select * from ${sql("public.test")}`).count).toBe(0);
	await sql`drop table test`;
});

test("dynamic column name", async () => {
	expect(Object.keys((await sql`select 1 as ${sql("!not_valid")}`)[0])[0]).toBe("!not_valid");
});

test("dynamic select as", async () => {
	expect((await sql`select ${sql({ a: 1, b: 2 })}`)[0].b).toBe("2");
});

test("dynamic select as pluck", async () => {
	expect((await sql`select ${sql({ a: 1, b: 2 }, "a")}`)[0].b).toBe(undefined);
});

test("dynamic insert", async () => {
	await sql`create table test (a int, b text)`;
	const x = { a: 42, b: "the answer" };

	expect((await sql`insert into test ${sql(x)} returning *`)[0].b).toBe("the answer");
	await sql`drop table test`;
});

test("dynamic insert pluck", async () => {
	await sql`create table test (a int, b text)`;
	const x = { a: 42, b: "the answer" };

	expect((await sql`insert into test ${sql(x, "a")} returning *`)[0].b).toBe(null);
	await sql`drop table test`;
});

test("dynamic in with empty array", async () => {
	await sql`create table test (a int)`;
	await sql`insert into test values (1)`;
	expect((await sql`select * from test where null in ${sql([])}`).count).toBe(0);
	await sql`drop table test`;
});

test("dynamic in after insert", async () => {
	await sql`create table test (a int, b text)`;
	const [{ x }] = await sql`
    with x as (
      insert into test values (1, 'hej')
      returning *
    )
    select 1 in ${sql([1, 2, 3])} as x from x
  `;
	expect(x).toBe(true);
	await sql`drop table test`;
});

test("array insert", async () => {
	await sql`create table test (a int, b int)`;
	expect((await sql`insert into test (a, b) values ${sql([1, 2])} returning *`)[0].b).toBe(2);
	await sql`drop table test`;
});

test("where parameters in()", async () => {
	await sql`create table test (x text)`;
	await sql`insert into test values ('a')`;
	expect((await sql`select * from test where x in ${sql(["a", "b", "c"])}`)[0].x).toBe("a");
	await sql`drop table test`;
});

test("where parameters in() values before", async () => {
	expect(
		(
			await sql`
    with rows as (
      select * from (values (1), (2), (3), (4)) as x(a)
    )
    select * from rows where a in ${sql([3, 4])}
  `
		).count,
	).toBe(2);
});

test("dynamic multi row insert", async () => {
	await sql`create table test (a int, b text)`;
	const x = { a: 42, b: "the answer" };

	expect((await sql`insert into test ${sql([x, x])} returning *`)[1].b).toBe("the answer");
	await sql`drop table test`;
});

test("dynamic update", async () => {
	await sql`create table test (a int, b text)`;
	await sql`insert into test (a, b) values (17, 'wrong')`;

	expect((await sql`update test set ${sql({ a: 42, b: "the answer" })} returning *`)[0].b).toBe(
		"the answer",
	);
	await sql`drop table test`;
});

test("dynamic update pluck", async () => {
	await sql`create table test (a int, b text)`;
	await sql`insert into test (a, b) values (17, 'wrong')`;

	expect(
		(await sql`update test set ${sql({ a: 42, b: "the answer" }, "a")} returning *`)[0].b,
	).toBe("wrong");
	await sql`drop table test`;
});

test("dynamic select array", async () => {
	await sql`create table test (a int, b text)`;
	await sql`insert into test (a, b) values (42, 'yay')`;
	expect((await sql`select ${sql(["a", "b"])} from test`)[0].b).toBe("yay");
	await sql`drop table test`;
});

test("dynamic returning array", async () => {
	await sql`create table test (a int, b text)`;
	expect(
		(await sql`insert into test (a, b) values (42, 'yay') returning ${sql(["a", "b"])}`)[0].b,
	).toBe("yay");
	await sql`drop table test`;
});

test("dynamic select args", async () => {
	await sql`create table test (a int, b text)`;
	await sql`insert into test (a, b) values (42, 'yay')`;
	expect((await sql`select ${sql("a", "b")} from test`)[0].b).toBe("yay");
	await sql`drop table test`;
});

test("dynamic values single row", async () => {
	const [{ b }] = await sql`
    select * from (values ${sql(["a", "b", "c"])}) as x(a, b, c)
  `;

	expect(b).toBe("b");
});

test("dynamic values multi row", async () => {
	const [, { b }] = await sql`
    select * from (values ${sql([
			["a", "b", "c"],
			["a", "b", "c"],
		])}) as x(a, b, c)
  `;

	expect(b).toBe("b");
});

test("Multiple queries", async () => {
	const sql = postgres(options);

	expect(
		(await Promise.all([sql`select 1`, sql`select 2`, sql`select 3`, sql`select 4`])).length,
	).toBe(4);
});

test("Multiple statements", async () => {
	expect(
		await sql
			.unsafe(`
    select 1 as x;
    select 2 as a;
  `)
			.then(([, [x]]) => x.a),
	).toBe(2);
});

test("Insert empty array", async () => {
	await sql`create table tester (ints int[])`;
	try {
		expect(
			Array.isArray((await sql`insert into tester (ints) values (${[]}) returning *`)[0].ints),
		).toBe(true);
	} finally {
		await sql`drop table tester`;
	}
});

test("Insert array in sql()", async () => {
	await sql`create table tester (ints int[])`;
	try {
		expect(
			Array.isArray((await sql`insert into tester ${sql({ ints: [] })} returning *`)[0].ints),
		).toBe(true);
	} finally {
		await sql`drop table tester`;
	}
});

test("Escaping supports schemas and tables", async () => {
	await sql`create schema a`;
	await sql`create table a.b (c int)`;
	await sql`insert into a.b (c) values (1)`;
	try {
		expect((await sql`select ${sql("a.b.c")} from a.b`)[0].c).toBe(1);
	} finally {
		await sql`drop table a.b`;
		await sql`drop schema a`;
	}
});

test("Raw method returns values unparsed as Buffer", async () => {
	const [[x]] = await sql`select 1`.raw();
	expect(x instanceof Uint8Array).toBe(true);
});

test("Fragments", async () => {
	expect(
		(
			await sql`
    ${sql`select`} 1 as x
  `
		)[0].x,
	).toBe(1);
});

test("Supports fragments as dynamic parameters", async () => {
	await sql`create table test (a int, b bool)`;
	await sql`insert into test values(1, true)`;
	await sql`insert into test ${sql({
		a: 2,
		b: sql`exists(select 1 from test where b = ${true})`,
	})}`;

	expect((await sql`select * from test`.raw()).join("")).toBe("1,t2,t");
	await sql`drop table test`;
});

test("Supports nested fragments with parameters", async () => {
	await sql`create table test ${sql`(${sql("a")} ${sql`int`})`}`;
	await sql`insert into test values(1)`;
	expect((await sql`select a from test`)[0].a).toBe(1);
	await sql`drop table test`;
});

test("Supports multiple nested fragments with parameters", async () => {
	const [{ b }] =
		await sql`select * ${sql`from ${sql`(values (2, ${1}::int)) as x(${sql(["a", "b"])})`}`}`;
	expect(b).toBe(1);
});

test("Supports arrays of fragments", async () => {
	const [{ x }] = await sql`
    ${[sql`select`, sql`1`, sql`as`, sql`x`]}
  `;

	expect(x).toBe(1);
});

test("Last keyword used even with duplicate keywords", async () => {
	await sql`create table test (x int)`;
	await sql`insert into test values(1)`;
	const [{ x }] = await sql`
    select
      1 in (1) as x
    from test
    where x in ${sql([1, 2])}
  `;

	expect(x).toBe(true);
	await sql`drop table test`;
});

test("Insert array with null", async () => {
	await sql`create table test (x int[])`;
	await sql`insert into test ${sql({ x: [1, null, 3] })}`;
	expect((await sql`select x from test`)[0].x[0]).toBe(1);
	await sql`drop table test`;
});

test("Named arguments in a function call (#1040)", async () => {
	const [{ x }] = await sql`select make_interval(${sql({ days: 1, hours: 2 })})::text as x`;
	expect(x).toBe("1 day 02:00:00");
});
