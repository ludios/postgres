import { expect, test } from "vitest";
import * as fc from "fast-check";
import { compile, own } from "../../src/connection.ts";
import * as p from "../../src/protocol.ts";
import type { Column } from "../../src/protocol.ts";

/** A column name: any text, with the names that Object.prototype has and that the row's source must quote */
const name = fc.oneof(
	fc.string({ unit: "binary" }),
	fc.constantFrom(
		"constructor",
		"toString",
		"hasOwnProperty",
		"",
		"0",
		"length",
		'a"b',
		"a\\b",
		" ",
	),
);

/** A column: read as text, through a parser, or through a binary decoder */
const column: fc.Arbitrary<Column> = fc
	.tuple(name, fc.constantFrom("text", "parser", "decode"))
	.map(([n, kind]) => ({
		name: n,
		table: 0,
		number: 0,
		type: 25,
		parser: kind === "parser" ? (x: string) => ["parsed", x] : null,
		decode:
			kind === "decode"
				? (x: Buffer, start: number, end: number) => ["decoded", x.toString("hex", start, end)]
				: null,
	}));

/** A column's value in a DataRow: its bytes, or null */
const value = fc.option(fc.uint8Array({ maxLength: 30 }));

/**
 * A transform of each value, as `transform.value.from` is
 * @param x - the value as read
 * @param c - its column
 * @returns what the compiled and the plain reader must both give for the value
 */
const from = (x: unknown, c?: { name: string }) => ["from", x, c?.name];

/**
 * @param columns - the columns of a row
 * @param values - the row's values, one per column
 * @returns a DataRow of them, as the server sends it
 */
function data_row(columns: Column[], values: (Uint8Array | null)[]) {
	const parts = values.map((x) => {
		if (x === null) {
			return Buffer.from([255, 255, 255, 255]);
		}
		const length = Buffer.alloc(4);
		length.writeInt32BE(x.length);
		return Buffer.concat([length, x]);
	});
	const head = Buffer.alloc(7);
	head[0] = 68;
	head.writeInt32BE(
		parts.reduce((n, x) => n + x.length, 6),
		1,
	);
	head.writeUInt16BE(columns.length, 5);
	return Buffer.concat([head, ...parts]);
}

/**
 * Reads a row the plain way, as DataRow() does before a reader is compiled.
 * @param x - a DataRow
 * @param columns - its columns
 * @param array - whether to give the row as an array of its values, else as an object
 * @param transform - the transform of each value, if any
 * @returns the row
 */
function plain_read(x: Buffer, columns: Column[], array: boolean, transform: typeof from | null) {
	const row: any = array ? new Array(columns.length) : {};
	let i = 7;
	columns.forEach((c, j) => {
		const length = x.readInt32BE(i);
		i += 4;
		let v: unknown = null;
		if (length !== -1) {
			v = c.decode
				? c.decode(x, i, i + length)
				: c.parser
					? c.parser(p.text(x, i, i + length))
					: p.text(x, i, i + length);
			i += length;
		}
		if (transform) {
			v = transform(v, c);
		}
		if (array) {
			row[j] = v;
		} else if (c.name === "__proto__") {
			own(row, c.name, v);
		} else {
			row[c.name] = v;
		}
	});
	return row;
}

test("A compiled row reader reads what the plain reader reads, for any column names, kinds and values", async () => {
	fc.assert(
		fc.property(
			fc
				.array(column, { maxLength: 12 })
				.chain((columns) =>
					fc.tuple(
						fc.constant(columns),
						fc.array(value, { minLength: columns.length, maxLength: columns.length }),
					),
				),
			fc.boolean(),
			fc.boolean(),
			([columns, values], array, transforming) => {
				const x = data_row(columns, values),
					transform = transforming ? from : null,
					row = compile(columns, array, transform)(x, 7);
				// Not toStrictEqual(): it compares the rows' `constructor` properties by reference, and a
				// column named constructor makes those two values that are only equal
				expect(row).toEqual(plain_read(x, columns, array, transform));
			},
		),
		{ numRuns: 1000 },
	);
});
