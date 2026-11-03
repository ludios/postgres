// Round trips through the server of random values: what the serializers write, the server reads,
// and what it sends back, the parsers and decoders read back to the value that went in.
import { expect, test } from "vitest";
import * as fc from "fast-check";
import { sql } from "./setup.ts";

/** Text that a text column can hold: well-formed (it goes through utf8), and without NUL */
const text = fc.string({ unit: "binary" }).filter((x) => x.isWellFormed() && !x.includes("\0"));

/** How many values each property sends through the server */
const runs = { numRuns: 100 };

test("Any text comes back from the server as it went", async () => {
	await fc.assert(
		fc.asyncProperty(text, async (x) => {
			const [row] = await sql`select ${x}::text as x`;
			expect(row.x).toBe(x);
		}),
		runs,
	);
});

/** An array of texts and nulls, or a two-dimensional one whose rows are of one length of at least 1 */
const text_array = fc.oneof(
	fc.array(fc.option(text)),
	fc.integer({ min: 1, max: 4 }).chain((n) =>
		fc.array(fc.array(fc.option(text), { minLength: n, maxLength: n }), {
			minLength: 1,
			maxLength: 4,
		}),
	),
);

test("Any texts and nulls come back from the server in a text[] as they went", async () => {
	await fc.assert(
		fc.asyncProperty(text_array, async (xs) => {
			const [row] = await sql`select ${xs}::text[] as x`;
			expect(row.x).toEqual(xs);
		}),
		runs,
	);
});

test("Any int2[], int4[] and bool[] come back as they went, in text and, once prepared, in binary", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(fc.option(fc.integer({ min: -32768, max: 32767 }))),
			fc.array(fc.option(fc.integer())),
			fc.array(fc.option(fc.boolean())),
			async (a, b, c) => {
				const [row] = await sql`select ${a}::int2[] as a, ${b}::int4[] as b, ${c}::bool[] as c`;
				expect([row.a, row.b, row.c]).toEqual([a, b, c]);
			},
		),
		runs,
	);
});

test("Any bytes come back from the server in a bytea as they went", async () => {
	await fc.assert(
		fc.asyncProperty(fc.uint8Array({ maxLength: 200 }), async (x) => {
			const [row] = await sql`select ${x}::bytea as x`;
			expect(row.x).toEqual(Buffer.from(x));
		}),
		runs,
	);
});

// The serializer writes a Date as toISOString() does, which the server reads only for the years 1
// to 9999: it rejects the extended years of the other Dates (+010000-…, 0000-…, -000500-…)
const instants = fc.date({
	min: new Date("0001-01-01T00:00:00.000Z"),
	max: new Date("9999-12-31T23:59:59.999Z"),
	noInvalidDate: true,
});

test("Any instant of the years 1 to 9999 comes back from the server in a timestamptz as it went, and in a date as its UTC day", async () => {
	await fc.assert(
		fc.asyncProperty(instants, async (d) => {
			const midnight = new Date(d);
			midnight.setUTCHours(0, 0, 0, 0);
			const [row] = await sql`select ${d}::timestamptz as t, ${d}::date as d`;
			expect([row.t, row.d]).toEqual([d, midnight]);
		}),
		runs,
	);
});

test("Any finite double and any int4 come back from the server as they went", async () => {
	// -0 goes as "0", so it comes back as 0
	const doubles = fc
		.double({ noNaN: true, noDefaultInfinity: true })
		.filter((x) => !Object.is(x, -0));
	await fc.assert(
		fc.asyncProperty(doubles, fc.integer(), async (x, n) => {
			const [row] = await sql`select ${x}::float8 as x, ${n}::int4 as n`;
			expect([row.x, row.n]).toEqual([x, n]);
		}),
		runs,
	);
});

test("Any JSON value comes back from the server in a json as its text round trips", async () => {
	const values = fc.jsonValue().filter((x) => !JSON.stringify(x).includes("\\u0000"));
	await fc.assert(
		fc.asyncProperty(values, async (x) => {
			const [row] = await sql`select ${sql.json(x)}::json as x`;
			expect(row.x).toEqual(JSON.parse(JSON.stringify(x)));
		}),
		runs,
	);
});

/** An identifier: text of up to the 63 bytes the server keeps, and without the '.' that splits a qualified name */
const identifier = text.filter((x) => x !== "" && !x.includes(".") && Buffer.byteLength(x) <= 63);

test("A column named by any identifier comes back under that name", async () => {
	await fc.assert(
		fc.asyncProperty(identifier, async (name) => {
			const [row] = await sql`select 1 as ${sql(name)}`;
			expect(Object.keys(row)).toEqual([name]);
		}),
		runs,
	);
});
