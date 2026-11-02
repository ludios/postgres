import { expect, test } from "vitest";
import { postgres, options, camel_case, snake_case } from "./setup.ts";

test("Transform undefined", async () => {
	const sql = postgres({ ...options, transform: { undefined: null } });
	expect((await sql`select ${undefined} as x`)[0].x).toBe(null);
});

test("Transform undefined in array", async () => {
	const sql = postgres({ ...options, transform: { undefined: null } });
	expect((await sql`select * from (values ${sql([undefined, undefined])}) as x(x, y)`)[0].y).toBe(
		null,
	);
});

test("transform column", async () => {
	const sql = postgres({
		...options,
		transform: { column: (x) => x.split("").reverse().join("") },
	});

	await sql`create table test (hello_world int)`;
	await sql`insert into test values (1)`;
	expect(Object.keys((await sql`select * from test`)[0])[0]).toBe("dlrow_olleh");
	await sql`drop table test`;
});

test("Transform row", async () => {
	const sql = postgres({
		...options,
		transform: { row: () => 1 },
	});

	expect((await sql`select 'wat'`)[0]).toBe(1);
});

test("Transform row forEach", async () => {
	let result;
	const sql = postgres({
		...options,
		transform: { row: () => 1 },
	});

	await sql`select 1`.forEach((x) => (result = x));

	expect(result).toBe(1);
});

test("Transform value", async () => {
	const sql = postgres({
		...options,
		transform: { value: () => 1 },
	});

	expect((await sql`select 'wat' as x`)[0].x).toBe(1);
});

test("transform.column.to renames the columns given to helpers", async () => {
	const sql = postgres({
		...options,
		transform: { column: { to: snake_case } },
	});
	await sql`create table test (a_test int, b_test text)`;
	await sql`insert into test ${sql([{ aTest: 1, bTest: 1 }])}`;
	await sql`update test set ${sql({ aTest: 2, bTest: 2 })}`;
	expect((await sql`select ${sql("aTest", "bTest")} from test`)[0].a_test).toBe(2);
	await sql`drop table test`;
});

test("transform.column.from renames the columns of results", async () => {
	const sql = postgres({
		...options,
		transform: { column: { from: camel_case } },
	});
	await sql`create table test (a_test int, b_test text)`;
	await sql`insert into test ${sql([{ a_test: 1, b_test: 1 }])}`;
	await sql`update test set ${sql({ a_test: 2, b_test: 2 })}`;
	expect((await sql`select a_test, b_test from test`)[0].aTest).toBe(2);
	await sql`drop table test`;
});

test("transform.column.to and transform.column.from together rename both ways", async () => {
	const sql = postgres({
		...options,
		transform: { column: { to: snake_case, from: camel_case } },
	});
	await sql`create table test (a_test int, b_test text)`;
	await sql`insert into test ${sql([{ aTest: 1, bTest: 1 }])}`;
	await sql`update test set ${sql({ aTest: 2, bTest: 2 })}`;
	expect((await sql`select ${sql("aTest", "bTest")} from test`)[0].aTest).toBe(2);
	await sql`drop table test`;
});

test("Insert array with undefined transform", async () => {
	const sql = postgres({ ...options, transform: { undefined: null } });
	await sql`create table test (x int[])`;
	await sql`insert into test ${sql({ x: [1, undefined, 3] })}`;
	expect((await sql`select x from test`)[0].x[0]).toBe(1);
	await sql`drop table test`;
});

test("transform.row applies to .values() rows too, as in v3", async () => {
	const sql = postgres({
		...options,
		transform: { row: { from: (row) => ((row.transformed = true), row) } },
	});
	const [row] = await sql`select 1 as a`.values();
	expect([row[0], row.transformed]).toEqual([1, true]);
	await sql.end();
});
