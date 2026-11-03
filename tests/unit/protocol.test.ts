import { expect, test } from "vitest";
import * as fc from "fast-check";
import * as p from "../../src/protocol.ts";
import { thrown } from "../helpers.ts";

const hex = (x: Uint8Array) => Buffer.from(x).toString("hex");
const str = (x: string) => Buffer.from(x + "\0");
const i16 = (x: number) => {
	const b = Buffer.alloc(2);
	b.writeInt16BE(x);
	return b;
};
const i32 = (x: number) => {
	const b = Buffer.alloc(4);
	b.writeInt32BE(x);
	return b;
};
const msg = (type: string, ...parts: Buffer[]) => {
	const body = Buffer.concat(parts);
	return Buffer.concat([Buffer.from(type), i32(body.length + 4), body]);
};

test("Sync, Flush, Terminate, CopyDone", async () => {
	const expected = hex(Buffer.concat([msg("S"), msg("H"), msg("X"), msg("c")]));
	expect(hex(Buffer.concat([p.Sync(), p.Flush(), p.Terminate(), p.CopyDone()]))).toBe(expected);
});

test("Query", async () => {
	const expected = hex(msg("Q", str("select 1")));
	expect(hex(p.Query("select 1"))).toBe(expected);
});

test("Parse unnamed without types", async () => {
	const expected = hex(msg("P", str(""), str("select 1"), i16(0)));
	expect(hex(p.Parse("", "select 1", []))).toBe(expected);
});

test("Parse named with types", async () => {
	const expected = hex(msg("P", str("s1"), str("select $1, $2"), i16(2), i32(23), i32(0)));
	expect(hex(p.Parse("s1", "select $1, $2", [23, 0]))).toBe(expected);
});

test("Bind with text values and null", async () => {
	const expected = hex(
		msg(
			"B",
			str(""),
			str("s1"),
			i16(0),
			i16(3),
			i32(2),
			Buffer.from("42"),
			i32(-1),
			i32(0),
			i16(0),
		),
	);
	expect(hex(p.Bind("", "s1", [Buffer.from("42"), null, Buffer.alloc(0)]))).toBe(expected);
});

test("Bind accepts strings and measures utf8 bytes", async () => {
	const expected = hex(
		msg("B", str("c1"), str(""), i16(0), i16(1), i32(4), Buffer.from("æø"), i16(0)),
	);
	expect(hex(p.Bind("c1", "", ["æø"]))).toBe(expected);
});

test("Bind with parameter and result formats", async () => {
	const expected = hex(
		msg(
			"B",
			str(""),
			str("s2"),
			i16(1),
			i16(1),
			i16(1),
			i32(1),
			Buffer.from([1]),
			i16(2),
			i16(0),
			i16(1),
		),
	);
	expect(hex(p.Bind("", "s2", [Buffer.from([1])], [1], [0, 1]))).toBe(expected);
});

test("Describe statement and portal", async () => {
	const expected = hex(
		Buffer.concat([msg("D", Buffer.from("S"), str("s1")), msg("D", Buffer.from("P"), str(""))]),
	);
	expect(hex(Buffer.concat([p.Describe("S", "s1"), p.Describe("P", "")]))).toBe(expected);
});

test("Execute unnamed and named with a row limit", async () => {
	const expected = hex(Buffer.concat([msg("E", str(""), i32(0)), msg("E", str("c1"), i32(100))]));
	expect(hex(Buffer.concat([p.Execute("", 0), p.Execute("c1", 100)]))).toBe(expected);
});

test("Close portal and statement", async () => {
	const expected = hex(
		Buffer.concat([msg("C", Buffer.from("P"), str("c1")), msg("C", Buffer.from("S"), str("s1"))]),
	);
	expect(hex(Buffer.concat([p.Close("P", "c1"), p.Close("S", "s1")]))).toBe(expected);
});

test("CopyData and CopyFail", async () => {
	const expected = hex(Buffer.concat([msg("d", Buffer.from("1,a\n")), msg("f", str("stop"))]));
	expect(hex(Buffer.concat([p.CopyData(Buffer.from("1,a\n")), p.CopyFail("stop")]))).toBe(expected);
});

test("Startup has no type byte and ends with an empty name", async () => {
	const body = Buffer.concat([
		i32(196608),
		str("user"),
		str("u"),
		str("database"),
		str("d"),
		Buffer.from([0]),
	]);
	const expected = hex(Buffer.concat([i32(body.length + 4), body]));
	expect(hex(p.Startup({ user: "u", database: "d" }))).toBe(expected);
});

test("SSLRequest and CancelRequest", async () => {
	const expected = hex(
		Buffer.concat([i32(8), i32(80877103), i32(16), i32(80877102), i32(1234), i32(-5)]),
	);
	expect(hex(Buffer.concat([p.SSLRequest(), p.Cancel(1234, -5)]))).toBe(expected);
});

test("Password, SASL initial response and SASL response", async () => {
	const expected = hex(
		Buffer.concat([
			msg("p", str("secret")),
			msg("p", str("SCRAM-SHA-256"), i32(12), Buffer.from("n,,n=*,r=abc")),
			msg("p", Buffer.from("c=biws,r=abc")),
		]),
	);
	expect(
		hex(
			Buffer.concat([
				p.Password("secret"),
				p.SASL("SCRAM-SHA-256", "n,,n=*,r=abc"),
				p.SASLResponse("c=biws,r=abc"),
			]),
		),
	).toBe(expected);
});

const messages = [
	msg("1"),
	msg("T", i16(1), str("x"), i32(0), i16(0), i32(23), i16(4), i32(-1), i16(0)),
	msg("D", i16(1), i32(1), Buffer.from("1")),
	msg("C", str("SELECT 1")),
	msg("Z", Buffer.from("I")),
];
const stream = Buffer.concat(messages);

/**
 * @param chunks - buffers to push to a Frames, in order
 * @returns each message that the Frames hands over, as its type character followed by its length in
 * bytes (including the type byte)
 */
function collect(chunks: Buffer[]) {
	const out: string[] = [],
		frames = p.Frames((type, buffer, start, end) =>
			out.push(String.fromCharCode(type) + (end - start)),
		);
	chunks.forEach((x) => frames.push(x));
	return out;
}

test("Frames splits one chunk into messages with their full length", async () => {
	expect(collect([stream])).toEqual(["15", "T27", "D12", "C14", "Z6"]);
});

test("Frames gives the same messages for every two-way split", async () => {
	const expected = collect([stream]);
	for (let i = 1; i < stream.length; i++) {
		const got = collect([stream.subarray(0, i), stream.subarray(i)]);
		expect(got, "split at " + i).toEqual(expected);
	}
});

test("Frames handles one byte at a time", async () => {
	const expected = collect([stream]);
	expect(collect([...stream].map((x) => Buffer.from([x])))).toEqual(expected);
});

test("Frames on a shared read buffer keeps what it has not framed when paused, and what comes while paused", async () => {
	const expected = collect([stream]),
		shared = Buffer.alloc(stream.length),
		out: string[] = [],
		frames = p.Frames((type, buffer, start, end) => {
			out.push(String.fromCharCode(type) + (end - start));
			if (type === 84) {
				frames.pause();
			}
		}, true),
		read = (from: number, to: number) => {
			stream.copy(shared, 0, from, to);
			frames.push(shared.subarray(0, to - from));
			shared.fill(0);
		};
	read(0, 20);
	read(20, 40);
	read(40, stream.length);
	frames.resume();
	expect(out).toEqual(expected);
});

test("Frames owning a shared read buffer hands over messages that stay intact after the buffer is reused", async () => {
	const shared = Buffer.alloc(stream.length),
		kept: Buffer[] = [],
		frames = p.Frames((type, buffer, start, end) => {
			if (frames.owns(buffer)) {
				kept.push(buffer.subarray(start, end));
			}
			if (type === 49) {
				frames.own(true);
			}
		}, true),
		read = (from: number, to: number) => {
			stream.copy(shared, 0, from, to);
			frames.push(shared.subarray(0, to - from));
			shared.fill(0);
		};
	read(0, 7);
	read(7, 20);
	read(20, stream.length);
	frames.own(false);
	expect(kept.map(hex)).toEqual(messages.slice(1).map(hex));
});

test("Frames hands over the whole message buffer", async () => {
	let got;
	p.Frames(
		(type, buffer, start, end) =>
			type === 67 && (got = buffer.toString("utf8", start + 5, end - 1)),
	).push(stream);
	expect(got).toBe("SELECT 1");
});

test("Frames pauses mid-chunk and resumes without a new push", async () => {
	const out: string[] = [];
	const frames = p.Frames((type) => {
		out.push(String.fromCharCode(type));
		if (type === 84) {
			frames.pause();
		}
	});
	frames.push(stream);
	const paused = [...out];
	frames.resume();
	expect([paused, out]).toEqual([
		["1", "T"],
		["1", "T", "D", "C", "Z"],
	]);
});

const decode = <T>(fn: (x: Buffer, start: number, end: number) => T, x: Buffer) =>
	fn(x, 0, x.length);

test("Decode ErrorResponse fields", async () => {
	const e = decode(
		p.error,
		msg(
			"E",
			Buffer.from("SERROR\0"),
			Buffer.from("VERROR\0"),
			Buffer.from("C42601\0"),
			Buffer.from('Msyntax error at or near "selec"\0'),
			Buffer.from("P1\0"),
			Buffer.from("RscannerYYerror\0"),
			Buffer.from([0]),
		),
	);
	expect([e.severity, e.code, e.message, e.position, e.routine]).toEqual([
		"ERROR",
		"42601",
		'syntax error at or near "selec"',
		"1",
		"scannerYYerror",
	]);
});

test("Decode ErrorResponse with the severity only in the localized S field", async () => {
	const e = decode(
		p.error,
		msg(
			"E",
			Buffer.from("SFATAL\0"),
			Buffer.from("C08P01\0"),
			Buffer.from("Mserver login has been failing, try again later (server_login_retry)\0"),
			Buffer.from([0]),
		),
	);
	expect([e.severity, e.severity_local, e.code]).toEqual(["FATAL", "FATAL", "08P01"]);
});

test("Decode ErrorResponse without either severity field and without a severity", async () => {
	const e = decode(
		p.error,
		msg("E", Buffer.from("C08P01\0"), Buffer.from("Mno severity\0"), Buffer.from([0])),
	);
	expect(["severity" in e, "severity_local" in e, e.code]).toEqual([false, false, "08P01"]);
});

test("Decode RowDescription", async () => {
	const columns = decode(
		p.row_description,
		msg(
			"T",
			i16(2),
			str("id"),
			i32(16384),
			i16(1),
			i32(23),
			i16(4),
			i32(-1),
			i16(0),
			str("name"),
			i32(16384),
			i16(2),
			i32(25),
			i16(-1),
			i32(-1),
			i16(0),
		),
	);
	expect(columns.map((x) => [x.name, x.table, x.number, x.type])).toEqual([
		["id", 16384, 1, 23],
		["name", 16384, 2, 25],
	]);
});

test("Decode ParameterDescription", async () => {
	expect(decode(p.parameter_description, msg("t", i16(3), i32(23), i32(25), i32(0)))).toEqual([
		23, 25, 0,
	]);
});

test("Decode CommandComplete", async () => {
	expect(
		["INSERT 0 3", "SELECT 5", "BEGIN", "CREATE TABLE", "COPY 2"]
			.map((x) => decode(p.command_complete, msg("C", str(x))))
			.map((x) => [x.command, x.count]),
	).toEqual([
		["INSERT", 3],
		["SELECT", 5],
		["BEGIN", null],
		["CREATE TABLE", null],
		["COPY", 2],
	]);
});

test("Decode ReadyForQuery status", async () => {
	expect(["I", "T", "E"].map((x) => decode(p.ready_for_query, msg("Z", Buffer.from(x))))).toEqual([
		"I",
		"T",
		"E",
	]);
});

test("Decode NotificationResponse", async () => {
	const x = decode(p.notification, msg("A", i32(42), str("chan"), str("hello")));
	expect([x.pid, x.channel, x.payload]).toEqual([42, "chan", "hello"]);
});

test("Decode ParameterStatus and BackendKeyData", async () => {
	const [name, value] = decode(p.parameter_status, msg("S", str("TimeZone"), str("UTC"))),
		key = decode(p.backend_key_data, msg("K", i32(99), i32(-7)));
	expect([name, value, key.pid, key.secret]).toEqual(["TimeZone", "UTC", 99, -7]);
});

test("A message that fails to encode leaves nothing behind for the next one", async () => {
	const bad = {
		toString() {
			throw new Error("wat");
		},
	};
	const error = thrown(() => p.Startup({ user: "a", database: bad as any })).message;
	expect([error, p.Sync()]).toEqual(["wat", Buffer.from("5300000004", "hex")]);
});

test("Column table oids, numbers and type oids are read unsigned, as in v3", async () => {
	const name = Buffer.from("a\0"),
		body = Buffer.alloc(2 + name.length + 18);
	body.writeUInt16BE(1, 0);
	name.copy(body, 2);
	body.writeUInt32BE(0xfffffff0, 2 + name.length);
	body.writeUInt16BE(0xffff, 6 + name.length);
	body.writeUInt32BE(0x80000001, 8 + name.length);
	const x = Buffer.concat([Buffer.from("T"), Buffer.alloc(4), body]);
	x.writeInt32BE(body.length + 4, 1);
	const [c] = p.row_description(x, 0, x.length);
	expect([c.table, c.number, c.type]).toEqual([4294967280, 65535, 2147483649]);
});

test("A parameter type oid above 2^31 is written as its four bytes", async () => {
	const w = p.Writer(64);
	p.parse(w, "", "select $1", [0x80000001]);
	const x = w.take();
	expect(x.subarray(x.length - 4).toString("hex")).toBe("80000001");
});

/** A message of the server: its type byte, and its body (the bytes after the length) */
const server_message = fc.tuple(fc.integer({ min: 0, max: 255 }), fc.uint8Array({ maxLength: 40 }));

/**
 * @param type - the type byte of a message of the server
 * @param body - its body
 * @returns the message as the server sends it
 */
function framed(type: number, body: Uint8Array) {
	return Buffer.concat([Buffer.from([type]), i32(body.length + 4), Buffer.from(body)]);
}

/**
 * @param x - bytes
 * @param lengths - the lengths of the chunks to cut `x` into, in order; a length may be 0
 * @returns the chunks, and what is left of `x` after them as one more chunk (possibly empty)
 */
function chunked(x: Buffer, lengths: number[]) {
	const chunks: Buffer[] = [];
	let at = 0;
	for (const n of lengths) {
		if (at >= x.length) {
			break;
		}
		chunks.push(x.subarray(at, at + n));
		at += n;
	}
	chunks.push(x.subarray(at));
	return chunks;
}

/**
 * Feeds messages to a Frames the way a socket would, and gathers what it hands over.
 * @param ms - the messages
 * @param lengths - how to cut the bytes of `ms` into pushes, as chunked() takes them
 * @param pauses - the indexes of the messages whose handler pauses the Frames
 * @param resumes - the indexes of the pushes after which the Frames is resumed, if it is paused;
 *   after the last push, it is resumed until it stays running
 * @param shared - whether every push comes from one read buffer that the next read overwrites
 * @param own_at - the index of the message whose handler asks the Frames to own its buffers from
 *   then on, if any
 * @returns the type byte and the hex of each message handed over, in order; a message whose buffer
 *   the Frames owns is kept by reference, as the connection keeps it, so that an overwritten shared
 *   buffer shows up as a wrong message
 */
function handed_over(
	ms: [number, Uint8Array][],
	lengths: number[],
	pauses: number[],
	resumes: number[],
	shared: boolean,
	own_at: number | null,
) {
	const all = Buffer.concat(ms.map(([type, body]) => framed(type, body))),
		buffer = Buffer.alloc(all.length + 1),
		out: [number, Buffer][] = [],
		frames = p.Frames((type, x, start, end) => {
			out.push([
				type,
				frames.owns(x) ? x.subarray(start, end) : Buffer.from(x.subarray(start, end)),
			]);
			if (out.length - 1 === own_at) {
				frames.own(true);
			}
			if (pauses.includes(out.length - 1)) {
				frames.pause();
			}
		}, shared);

	chunked(all, lengths).forEach((chunk, i) => {
		if (shared) {
			chunk.copy(buffer);
			frames.push(buffer.subarray(0, chunk.length));
			buffer.fill(0xff);
		} else {
			frames.push(chunk);
		}
		if (resumes.includes(i)) {
			frames.resume();
		}
	});
	while (frames.paused) {
		frames.resume();
	}
	return out.map(([type, x]) => [type, hex(x)]);
}

test("Frames hands over every message whole, however the bytes are chunked, paused, resumed and copied", async () => {
	fc.assert(
		fc.property(
			fc.array(server_message, { maxLength: 12 }),
			fc.array(fc.nat({ max: 50 })),
			fc.uniqueArray(fc.nat({ max: 12 })),
			fc.uniqueArray(fc.nat({ max: 60 })),
			fc.boolean(),
			fc.option(fc.nat({ max: 12 })),
			(ms, lengths, pauses, resumes, shared, own_at) => {
				expect(handed_over(ms, lengths, pauses, resumes, shared, own_at)).toEqual(
					ms.map(([type, body]) => [type, hex(framed(type, body))]),
				);
			},
		),
		{ numRuns: 2000 },
	);
});

/** Any text; fast-check's binary unit makes any code point but a lone surrogate */
const any_text = fc.string({ unit: "binary" });

/** A write to a Writer, and the bytes that the write adds */
type Write = { apply: (w: p.Writer) => void; bytes: Buffer };

const writes: fc.Arbitrary<Write> = fc.oneof(
	{
		arbitrary: any_text.map((x) => ({
			apply: (w: p.Writer) => w.str(x),
			bytes: Buffer.from(x + "\0"),
		})),
		weight: 10,
	},
	{
		arbitrary: any_text.map((x) => ({ apply: (w: p.Writer) => w.bytes(x), bytes: Buffer.from(x) })),
		weight: 10,
	},
	{
		arbitrary: fc
			.uint8Array({ maxLength: 100 })
			.map((x) => ({ apply: (w: p.Writer) => w.bytes(x), bytes: Buffer.from(x) })),
		weight: 10,
	},
	{
		arbitrary: fc.option(any_text).map((x) => ({
			apply: (w: p.Writer) => w.value(x),
			bytes: x === null ? i32(-1) : Buffer.concat([i32(Buffer.byteLength(x)), Buffer.from(x)]),
		})),
		weight: 10,
	},
	{
		arbitrary: fc
			.integer({ min: 0, max: 255 })
			.map((x) => ({ apply: (w: p.Writer) => w.u8(x), bytes: Buffer.from([x]) })),
		weight: 10,
	},
	{
		arbitrary: fc
			.integer({ min: -32768, max: 32767 })
			.map((x) => ({ apply: (w: p.Writer) => w.i16(x), bytes: i16(x) })),
		weight: 10,
	},
	{
		arbitrary: fc.integer({ min: 0, max: 65535 }).map((x) => ({
			apply: (w: p.Writer) => w.u16(x),
			bytes: Buffer.from([x >> 8, x & 255]),
		})),
		weight: 10,
	},
	{
		arbitrary: fc.integer().map((x) => ({ apply: (w: p.Writer) => w.i32(x), bytes: i32(x) })),
		weight: 10,
	},
	// Once in about 80 writes, more than the 4096 bytes past which take() hands over the buffer itself
	{
		arbitrary: fc.uint8Array({ minLength: 4096, maxLength: 5000 }).map((x) => ({
			apply: (w: p.Writer) => w.bytes(x),
			bytes: Buffer.from(x),
		})),
		weight: 1,
	},
);

/** The type byte and the writes of a message to the server */
const client_message = fc.tuple(
	fc.integer({ min: 1, max: 127 }),
	fc.array(writes, { maxLength: 8 }),
);

/**
 * @param w - a Writer
 * @param type - the type byte of a message
 * @param xs - the writes of its body
 * @returns the message that `w` hands over for them
 */
function written(w: p.Writer, type: number, xs: Write[]) {
	w.type(type);
	xs.forEach((x) => x.apply(w));
	return w.end().take();
}

/**
 * @param type - the type byte of a message
 * @param xs - the writes of its body
 * @returns the hex of the message as the server expects it
 */
const expected_message = (type: number, xs: Write[]) =>
	hex(msg(String.fromCharCode(type), ...xs.map((x) => x.bytes)));

test("Writer encodes any writes from any starting size, and a message taken stays intact", async () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 1, max: 100 }),
			client_message,
			client_message,
			(size, [type_a, a], [type_b, b]) => {
				const w = p.Writer(size),
					first = written(w, type_a, a),
					second = written(w, type_b, b);
				expect([hex(first), hex(second)]).toEqual([
					expected_message(type_a, a),
					expected_message(type_b, b),
				]);
			},
		),
		{ numRuns: 1000 },
	);
});

test("Bind encodes any values, as text or bytes, with their lengths in bytes", async () => {
	const values = fc.array(fc.oneof(any_text, fc.uint8Array({ maxLength: 50 }), fc.constant(null)));
	fc.assert(
		fc.property(
			any_text,
			any_text,
			values,
			fc.array(fc.integer({ min: 0, max: 1 })),
			fc.array(fc.integer({ min: 0, max: 1 })),
			(portal, statement, xs, formats, results) => {
				const expected = msg(
					"B",
					str(portal),
					str(statement),
					i16(formats.length),
					...formats.map(i16),
					i16(xs.length),
					...xs.map((x) =>
						x === null ? i32(-1) : Buffer.concat([i32(Buffer.byteLength(x)), Buffer.from(x)]),
					),
					i16(results.length),
					...results.map(i16),
				);
				expect(hex(p.Bind(portal, statement, xs, formats, results))).toBe(hex(expected));
			},
		),
		{ numRuns: 1000 },
	);
});

/** A string that a message of the server can hold as a field: well-formed, with no NUL */
const field_text = any_text.filter((x) => !x.includes("\0"));

test("Decode RowDescription with any names and unsigned oids and numbers", async () => {
	const column = fc.record({
		name: field_text,
		table: fc.integer({ min: 0, max: 0xffffffff }),
		number: fc.integer({ min: 0, max: 0xffff }),
		type: fc.integer({ min: 0, max: 0xffffffff }),
	});
	const u32 = (x: number) => {
		const b = Buffer.alloc(4);
		b.writeUInt32BE(x);
		return b;
	};
	fc.assert(
		fc.property(fc.array(column, { maxLength: 20 }), (columns) => {
			const x = msg(
				"T",
				i16(columns.length),
				...columns.flatMap((c) => [
					str(c.name),
					u32(c.table),
					Buffer.from([c.number >> 8, c.number & 255]),
					u32(c.type),
					i16(-1),
					i32(-1),
					i16(0),
				]),
			);
			expect(decode(p.row_description, x).map((c) => [c.name, c.table, c.number, c.type])).toEqual(
				columns.map((c) => [c.name, c.table, c.number, c.type]),
			);
		}),
		{ numRuns: 500 },
	);
});

test("Decode ErrorResponse with any texts in its fields", async () => {
	const fields = fc.record({
		severity_local: field_text,
		severity: field_text,
		code: field_text,
		message: field_text,
		detail: field_text,
		hint: field_text,
		position: field_text,
	});
	fc.assert(
		fc.property(fields, (f) => {
			const x = msg(
				"E",
				str("S" + f.severity_local),
				str("V" + f.severity),
				str("C" + f.code),
				str("M" + f.message),
				str("D" + f.detail),
				str("H" + f.hint),
				str("P" + f.position),
				Buffer.from([0]),
			);
			const e = decode(p.error, x);
			expect([
				e.severity_local,
				e.severity,
				e.code,
				e.message,
				e.detail,
				e.hint,
				e.position,
			]).toEqual([f.severity_local, f.severity, f.code, f.message, f.detail, f.hint, f.position]);
		}),
		{ numRuns: 500 },
	);
});

test("Decode CommandComplete for any command tag, counting its last number", async () => {
	fc.assert(
		fc.property(
			fc.stringMatching(/^[A-Z]+( [A-Z]+)*$/),
			fc.array(fc.nat(), { maxLength: 3 }),
			(command, counts) => {
				const tag = command + counts.map((n) => " " + n).join(""),
					x = decode(p.command_complete, msg("C", str(tag)));
				expect([x.command, x.count]).toEqual([
					command,
					counts.length ? counts[counts.length - 1] : null,
				]);
			},
		),
		{ numRuns: 500 },
	);
});
