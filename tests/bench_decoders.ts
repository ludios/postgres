// Times the decoders that read a column's values straight from the bytes against the built-in
// text parsers that they stand in for, on values as PostgreSQL sends them:
//
//	node tests/bench_decoders.ts
//
// For each type it prints the nanoseconds per value of the text path (the bytes made into a
// string, which the parser parses, as for a column without a decoder) and of the decoder, the
// fastest of several rounds. int8[] has no decoder of the binary format, as one turned out slower
// than its text path; its rows time one that makes the text of each element from the binary.
import { Types } from "../src/types.ts";

const types = Types({ infer: false }),
	values = 2000,
	repeats = 200,
	rounds = 7;

/** A type to time: its values as text, and as the bytes that its decoder reads */
type Case = {
	name: string;
	oid: number;
	texts: string[];
	/** The bytes of each value in the format that the decoder reads: the text, or binary */
	bytes: Buffer[];
	/** The decoder: a decoder of the text, or of the binary format */
	decode: (x: Buffer, start: number, end: number) => unknown;
};

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/**
 * @param i - which value this is
 * @returns a pseudo-random integer from 0 up to 2^32, the same for the same `i` on every run
 */
function noise(i: number) {
	let x = (i + 1) * 2654435761;
	x ^= x >>> 15;
	x = Math.imul(x, 2246822519);
	return (x ^ (x >>> 13)) >>> 0;
}

/**
 * @param i - which value this is
 * @returns the text of a timestamp from 1970 to 2069 with microseconds, as PostgreSQL sends it
 *   with DateStyle ISO
 */
function timestamp_text(i: number) {
	const t = new Date((noise(i) % 3_155_760_000) * 1000 + (noise(i + 1) % 1000)),
		micros = pad(t.getUTCMilliseconds(), 3) + pad(noise(i + 2) % 1000, 3);
	return (
		t.toISOString().slice(0, 10) +
		" " +
		t.toISOString().slice(11, 19) +
		"." +
		micros.replace(/0+$/, "")
	);
}

/**
 * @param n - an integer
 * @returns `n` as a signed 32-bit big-endian integer
 */
function int32_bytes(n: number) {
	const x = Buffer.alloc(4);
	x.writeInt32BE(n);
	return x;
}

/**
 * @param xs - the elements of an array of one dimension
 * @param element - the type of the elements
 * @param write - `(element) => Buffer` gives the binary format of an element
 * @returns the array in PostgreSQL's binary format
 */
function binary_array<T>(xs: T[], element: number, write: (x: T) => Buffer) {
	return Buffer.concat([
		int32_bytes(1),
		int32_bytes(0),
		int32_bytes(element),
		int32_bytes(xs.length),
		int32_bytes(1),
		...xs.flatMap((x) => [int32_bytes(write(x).length), write(x)]),
	]);
}

/**
 * @param name - what the output calls the type
 * @param oid - the type
 * @param text - `(i) => string` gives the text of the i-th value
 * @returns a case whose decoder reads the bytes of the text
 */
function text_case(name: string, oid: number, text: (i: number) => string): Case {
	const texts = Array.from({ length: values }, (_, i) => text(i));
	return {
		name,
		oid,
		texts,
		bytes: texts.map((x) => Buffer.from(x, "latin1")),
		decode: types.decoder(oid, types.parser(oid))!,
	};
}

/**
 * A decoder of int8[] of one dimension in the binary format, which gives the text of each element,
 * as the text parser does. The pool has none, as it is slower than the text path.
 *
 * @param x - the bytes
 * @param start - where the array starts in `x`
 * @returns the elements' text, or null for a NULL element
 */
function int8_array(x: Buffer, start: number) {
	const xs = new Array(x.readInt32BE(start + 12));
	for (let k = 0, at = start + 20; k < xs.length; k++) {
		const length = x.readInt32BE(at),
			high = length === -1 ? 0 : x.readInt32BE(at + 4);
		// A double holds the integer exactly when it is in [-2^53, 2^53), where `high` is in
		// [-2^21, 2^21)
		xs[k] =
			length === -1
				? null
				: high >= -2097152 && high < 2097152
					? String(high * 4294967296 + x.readUInt32BE(at + 8))
					: x.readBigInt64BE(at + 4).toString();
		at += 4 + Math.max(length, 0);
	}
	return xs;
}

/**
 * @param name - what the output calls the array type
 * @param oid - the array type
 * @param element - the type of the elements
 * @param random - `(i) => element` gives a pseudo-random element for `i`
 * @param write - `(element) => Buffer` gives the binary format of an element
 * @returns a case of arrays of 10 elements, whose decoder reads the binary format
 */
function array_case<T>(
	name: string,
	oid: number,
	element: number,
	random: (i: number) => T,
	write: (x: T) => Buffer,
): Case {
	const arrays = Array.from({ length: values }, (_, i) =>
		Array.from({ length: 10 }, (__, k) => random(i * 10 + k)),
	);
	return {
		name,
		oid,
		texts: arrays.map(
			(xs) =>
				"{" + xs.map((x) => (typeof x === "boolean" ? (x ? "t" : "f") : String(x))).join(",") + "}",
		),
		bytes: arrays.map((xs) => binary_array(xs, element, write)),
		decode: oid === 1016 ? int8_array : types.binary(oid, types.parser(oid))!,
	};
}

/**
 * @param n - how many bytes
 * @param write - `(x) => void` writes `x` into a Buffer of `n` bytes
 * @returns a function that gives the Buffer that `write` wrote
 */
function fixed<T>(n: number, write: (b: Buffer, x: T) => void) {
	return (x: T) => {
		const b = Buffer.alloc(n);
		write(b, x);
		return b;
	};
}

/** @returns the types to time */
function cases(): Case[] {
	const bytea = Array.from({ length: values }, (_, i) =>
		Buffer.from(Array.from({ length: 32 }, (__, k) => noise(i * 32 + k) & 255)),
	);
	return [
		text_case("timestamptz", 1184, (i) => timestamp_text(i) + "+00"),
		text_case("timestamptz +05:30", 1184, (i) => timestamp_text(i) + "+05:30"),
		text_case("timestamp", 1114, timestamp_text),
		text_case("date", 1082, (i) => timestamp_text(i).slice(0, 10)),
		{
			name: "bytea (32 bytes)",
			oid: 17,
			texts: bytea.map((x) => "\\x" + x.toString("hex")),
			bytes: bytea,
			decode: types.binary(17, types.parser(17))!,
		},
		array_case(
			"int2[10]",
			1005,
			21,
			(i) => (noise(i) % 65536) - 32768,
			fixed(2, (b, x: number) => b.writeInt16BE(x)),
		),
		array_case("int4[10]", 1007, 23, (i) => noise(i) | 0, int32_bytes),
		array_case(
			"int8[10] ids",
			1016,
			20,
			(i) => BigInt(noise(i) % 100_000_000) * 1000n,
			fixed(8, (b, x: bigint) => b.writeBigInt64BE(x)),
		),
		array_case(
			"int8[10] any",
			1016,
			20,
			(i) => BigInt.asIntN(64, (BigInt(noise(i)) << 32n) | BigInt(noise(i + 1))),
			fixed(8, (b, x: bigint) => b.writeBigInt64BE(x)),
		),
		array_case(
			"bool[10]",
			1000,
			16,
			(i) => (noise(i) & 1) === 1,
			fixed(1, (b, x: boolean) => b.writeUInt8(x ? 1 : 0)),
		),
	];
}

/**
 * @param read - reads value `j`, and gives a number derived from it, so that the work can't be
 *   left out
 * @returns the fastest time per value, in nanoseconds, over `rounds` rounds of `repeats` passes
 *   over the values
 */
function time(read: (j: number) => number) {
	let best = Infinity,
		sink = 0;
	for (let r = 0; r < rounds; r++) {
		const start = process.hrtime.bigint();
		for (let k = 0; k < repeats; k++) {
			for (let j = 0; j < values; j++) {
				sink += read(j);
			}
		}
		best = Math.min(best, Number(process.hrtime.bigint() - start) / (repeats * values));
	}
	if (Number.isNaN(sink)) {
		throw new Error("unreachable: a NaN sink");
	}
	return best;
}

/**
 * @param x - a decoded value
 * @returns a number derived from `x`
 */
function digest(x: unknown) {
	return x instanceof Date
		? x.getTime() & 1
		: Array.isArray(x) || Buffer.isBuffer(x)
			? x.length
			: 0;
}

function main() {
	process.stdout.write(
		"type".padEnd(20) +
			"text ns".padStart(10) +
			"decoder ns".padStart(12) +
			"speedup".padStart(10) +
			"\n",
	);
	for (const c of cases()) {
		const parse = types.parser(c.oid),
			text_bytes = c.texts.map((x) => Buffer.from(x, "latin1"));
		// The decoder must give what the parser gives, or the times compare different work
		c.texts.forEach((x, j) => {
			const a = JSON.stringify(parse(x)),
				b = JSON.stringify(c.decode(c.bytes[j], 0, c.bytes[j].length));
			if (a !== b) {
				throw new Error(
					c.name + ": the decoder gives " + b + " for " + x + ", but the parser " + a,
				);
			}
		});
		const text_ns = time((j) =>
				digest(parse(text_bytes[j].toString("utf8", 0, text_bytes[j].length))),
			),
			decoder_ns = time((j) => digest(c.decode(c.bytes[j], 0, c.bytes[j].length)));
		process.stdout.write(
			c.name.padEnd(20) +
				text_ns.toFixed(0).padStart(10) +
				decoder_ns.toFixed(0).padStart(12) +
				(text_ns / decoder_ns).toFixed(2).padStart(9) +
				"x\n",
		);
	}
}

main();
