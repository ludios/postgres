import { expect, test } from "vitest";
import { postgres, sql, options } from "./setup.ts";

const same = (xs) =>
	xs.every(
		(x) =>
			JSON.stringify(x) === JSON.stringify(xs[0]) &&
			Object.keys(x).join() === Object.keys(xs[0]).join(),
	);

test("Rows keep the same shape and values across many rows", async () => {
	const rows = await sql`
    select
      1 as "1",
      'x' as a,
      null::int as n,
      true as b,
      2 as a,
      'q' as "we""ird",
      'y' as "}; throw 1; //",
      1.5::float8 as f,
      '2026-06-01T00:00:00Z'::timestamptz as d,
      '{1,2}'::int[] as arr,
      '{"k":1}'::json as j
    from generate_series(1, 40)
  `;
	expect([
		rows.length,
		same(rows),
		rows[39].a,
		rows[39].n,
		rows[39].d instanceof Date,
		rows[39]["1"],
		rows[39].arr,
		rows[39].j.k,
	]).toEqual([40, true, 2, null, true, 1, [1, 2], 1]);
});

test("Rows with a __proto__ column stay plain objects", async () => {
	const rows = await sql`select 'x' as "__proto__", 1 as a from generate_series(1, 40)`;
	expect([
		rows.every((x) => Object.getPrototypeOf(x) === Object.prototype),
		rows.every((x) => x.a === 1),
	]).toEqual([true, true]);
});

test("Rows from .values() are arrays across many rows", async () => {
	const rows = await sql`select 1 as a, 'x' as a, null as b from generate_series(1, 40)`.values();
	expect([
		rows.every((x) => Array.isArray(x) && JSON.stringify(x) === '[1,"x",null]'),
		rows[39],
	]).toEqual([true, [1, "x", null]]);
});

test("Rows from .raw() are buffers across many rows", async () => {
	const rows = await sql`select 1 as a, null as b from generate_series(1, 40)`.raw();
	expect(rows.every((x) => Buffer.isBuffer(x[0]) && x[0].toString() === "1" && x[1] === null)).toBe(
		true,
	);
});

test("Rows apply value and column transforms across many rows", async () => {
	const sql = postgres({
		...options,
		transform: {
			column: { from: (x) => x.toUpperCase() },
			value: { from: (x, column) => (column.type === 23 && x !== null ? x * 10 : x) },
		},
	});
	const rows = await sql`select 1 as a, 'x' as b, null::int as c from generate_series(1, 40)`;
	expect(
		rows.every(
			(x) => x.A === 10 && x.B === "x" && x.C === null && Object.keys(x).join() === "A,B,C",
		),
	).toBe(true);
	await sql.end();
});

test("Rows reach forEach across many rows", async () => {
	let n = 0;
	await sql`select i, 'x' as s from generate_series(1, 40) as i`.forEach(
		(x) => (n += x.i + x.s.length),
	);
	expect(n).toBe(860);
});

test("A column named __proto__ is an own property and does not become the prototype of the row", async () => {
	const results = [];
	for (const n of [1, 40]) {
		const rows =
				await sql`select 'alice' as name, '{"isAdmin": true}'::json as "__proto__" from generate_series(1, ${n})`,
			row = rows[rows.length - 1],
			own = Object.getOwnPropertyDescriptor(row, "__proto__");
		results.push([
			typeof row.isAdmin,
			Object.getPrototypeOf(row) === Object.prototype,
			Object.keys(row),
			own.value.isAdmin,
		]);
	}
	expect(results).toEqual(
		Array.from({ length: 2 }, () => ["undefined", true, ["name", "__proto__"], true]),
	);
});
