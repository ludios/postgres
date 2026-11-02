import { expect, test } from "vitest";
import { postgres, sql, options } from "./setup.ts";

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
	expect(rows.map((x) => Object.entries(x))).toEqual(
		Array.from({ length: 40 }, () => [
			["1", 1],
			["a", 2],
			["n", null],
			["b", true],
			['we"ird', "q"],
			["}; throw 1; //", "y"],
			["f", 1.5],
			["d", new Date("2026-06-01T00:00:00Z")],
			["arr", [1, 2]],
			["j", { k: 1 }],
		]),
	);
});

test("Rows with a __proto__ column stay plain objects", async () => {
	const rows = await sql`select 'x' as "__proto__", 1 as a from generate_series(1, 40)`;
	expect(rows.map((x) => [Object.getPrototypeOf(x) === Object.prototype, x.a])).toEqual(
		Array.from({ length: 40 }, () => [true, 1]),
	);
});

test("Rows from .values() are arrays across many rows", async () => {
	const rows = await sql`select 1 as a, 'x' as a, null as b from generate_series(1, 40)`.values();
	expect(rows).toEqual(Array.from({ length: 40 }, () => [1, "x", null]));
});

test("Rows from .raw() are buffers across many rows", async () => {
	const rows = await sql`select 1 as a, null as b from generate_series(1, 40)`.raw();
	expect(rows).toEqual(Array.from({ length: 40 }, () => [Buffer.from("1"), null]));
});

test("Rows apply value and column transforms across many rows", async () => {
	await using sql = postgres({
		...options,
		transform: {
			column: { from: (x) => x.toUpperCase() },
			value: { from: (x, column) => (column.type === 23 && x !== null ? x * 10 : x) },
		},
	});
	const rows = await sql`select 1 as a, 'x' as b, null::int as c from generate_series(1, 40)`;
	expect(rows.map((x) => Object.entries(x))).toEqual(
		Array.from({ length: 40 }, () => [
			["A", 10],
			["B", "x"],
			["C", null],
		]),
	);
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
