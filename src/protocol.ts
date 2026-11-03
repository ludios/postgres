export function Writer(size = 16384) {
	let b = Buffer.allocUnsafe(size),
		i = 0,
		at = 0;

	const w = {
		get length() {
			return i;
		},
		type(x: number) {
			fit(5);
			at = i;
			b[i] = x;
			i += 5;
			return w;
		},
		untyped() {
			fit(4);
			at = i;
			i += 4;
			return w;
		},
		end() {
			b.writeInt32BE(i - at - 1, at + 1);
			return w;
		},
		end_untyped() {
			b.writeInt32BE(i - at, at);
			return w;
		},
		str(x: string) {
			fit(x.length * 3 + 1);
			i += b.write(x, i);
			b[i++] = 0;
			return w;
		},
		bytes(x: string | Uint8Array) {
			if (typeof x === "string") {
				fit(x.length * 3);
				i += b.write(x, i);
			} else {
				fit(x.length);
				b.set(x, i);
				i += x.length;
			}
			return w;
		},
		value(x: Value) {
			if (x === null || x === undefined) {
				return w.i32(-1);
			}
			const n = i;
			i += 4;
			w.bytes(x);
			b.writeInt32BE(i - n - 4, n);
			return w;
		},
		u8(x: number) {
			fit(1);
			b[i++] = x;
			return w;
		},
		i16(x: number) {
			fit(2);
			b.writeInt16BE(x, i);
			i += 2;
			return w;
		},
		u16(x: number) {
			fit(2);
			b.writeUInt16BE(x, i);
			i += 2;
			return w;
		},
		i32(x: number) {
			fit(4);
			b.writeInt32BE(x, i);
			i += 4;
			return w;
		},
		truncate(n: number) {
			i = n;
			return w;
		},
		take() {
			const out = i < 4096 ? Buffer.from(b.subarray(0, i)) : b.subarray(0, i);
			if (i >= 4096) {
				b = Buffer.allocUnsafe(size);
			}
			i = at = 0;
			return out;
		},
	};

	return w;

	function fit(n: number) {
		if (b.length - i >= n) {
			return;
		}

		const prev = b;
		b = Buffer.allocUnsafe(Math.max(size, prev.length * 2, i + n));
		prev.copy(b, 0, 0, i);
	}
}

/** Writes the messages of the protocol into a buffer, which take() hands over */
export type Writer = ReturnType<typeof Writer>;

/** A parameter's value as sent: text, bytes, or null */
export type Value = string | Uint8Array | null | undefined;

const scratch = Writer(1024);

const S = 83,
	H = 72,
	X = 88,
	c = 99,
	Q = 81,
	p = 112,
	d = 100,
	f = 102,
	D = 68,
	C = 67,
	E = 69,
	P = 80,
	B = 66;

export const sync = (w: Writer) => w.type(S).end();
export const flush = (w: Writer) => w.type(H).end();
export const terminate = (w: Writer) => w.type(X).end();
export const copy_done = (w: Writer) => w.type(c).end();
export const ssl_request = (w: Writer) => w.untyped().i32(80877103).end_untyped();
export const query = (w: Writer, text: string) => w.type(Q).str(text).end();
export const password = (w: Writer, x: string) => w.type(p).str(x).end();
export const sasl_response = (w: Writer, x: string | Uint8Array) => w.type(p).bytes(x).end();
export const copy_data = (w: Writer, x: string | Uint8Array) => w.type(d).bytes(x).end();
export const copy_fail = (w: Writer, x: string) => w.type(f).str(x).end();
export const describe = (w: Writer, kind: string, name: string) =>
	w.type(D).u8(kind.charCodeAt(0)).str(name).end();
export const close = (w: Writer, kind: string, name: string) =>
	w.type(C).u8(kind.charCodeAt(0)).str(name).end();
export const execute = (w: Writer, portal: string, rows = 0) =>
	w.type(E).str(portal).i32(rows).end();
export const cancel = (w: Writer, pid: number, secret: number) =>
	w.untyped().i32(80877102).i32(pid).i32(secret).end_untyped();

export const Sync = one(sync);
export const Flush = one(flush);
export const Terminate = one(terminate);
export const CopyDone = one(copy_done);
export const SSLRequest = one(ssl_request);
export const Query = one(query);
export const Password = one(password);
export const SASLResponse = one(sasl_response);
export const CopyData = one(copy_data);
export const CopyFail = one(copy_fail);
export const Describe = one(describe);
export const Close = one(close);
export const Execute = one(execute);
export const Cancel = one(cancel);
export const Startup = one(startup);
export const SASL = one(sasl);
export const Parse = one(parse);
export const Bind = one(bind);
export const Run = one(run);

/** @returns a function that writes `fn`'s message with the arguments it is given, and takes it as a Buffer */
function one<A extends unknown[]>(fn: (w: Writer, ...xs: A) => unknown) {
	return (...xs: A) => {
		try {
			fn(scratch, ...xs);
		} catch (thrown) {
			scratch.truncate(0);
			throw thrown;
		}
		return scratch.take();
	};
}

export function startup(
	w: Writer,
	parameters: Record<string, string | number | boolean | undefined>,
) {
	w.untyped().i32(196608);
	for (const k in parameters) {
		if (parameters[k]) {
			w.str(unbroken(k, k)).str(unbroken(k, "" + parameters[k]));
		}
	}

	return w.u8(0).end_untyped();
}

function unbroken(k: string, x: string) {
	if (x.indexOf("\0") !== -1) {
		throw Object.assign(new Error("The connection parameter " + k + " contains a NUL character"), {
			code: "NUL_CHARACTER",
		});
	}

	return x;
}

export function sasl(w: Writer, mechanism: string, initial: string | Uint8Array) {
	return w.type(p).str(mechanism).i32(Buffer.byteLength(initial)).bytes(initial).end();
}

export function parse(w: Writer, name: string, text: string, oids: number[] = []) {
	w.type(P).str(name).str(text).u16(oids.length);
	for (let j = 0; j < oids.length; j++) {
		w.i32(oids[j] | 0);
	}

	return w.end();
}

export function bind(
	w: Writer,
	portal: string,
	name: string,
	values: Value[] = [],
	formats: number[] = [],
	result_formats: number[] = [],
) {
	w.type(B).str(portal).str(name).i16(formats.length);
	for (let j = 0; j < formats.length; j++) {
		w.i16(formats[j]);
	}

	w.u16(values.length);
	for (let j = 0; j < values.length; j++) {
		w.value(values[j]);
	}

	w.i16(result_formats.length);
	for (let j = 0; j < result_formats.length; j++) {
		w.i16(result_formats[j]);
	}

	return w.end();
}

export function run(
	w: Writer,
	portal: string,
	name: string,
	values: Value[],
	rows: number,
	flushing: boolean,
	result_formats: number[] | null = null,
) {
	bind(w, portal, name, values, [], result_formats || []);
	execute(w, portal, rows);
	return flushing ? flush(w) : sync(w);
}

const largest = 0x40000000;

/**
 * Splits what the socket reads into the server's messages.
 * @param onframe - called with each message: its type byte, and the buffer with the start and end of
 *   the message in it
 * @param shared - whether the buffers pushed are reused by the socket, so that a message kept past
 *   the call of `onframe` (while paused, or when own() says so) must be copied
 * @param onerror - called with the error of a message whose length is invalid
 */
export function Frames(
	onframe: (type: number, x: Buffer, start: number, end: number) => void,
	shared = false,
	onerror: ((error: Error) => void) | null = null,
) {
	const chunks: Buffer[] = [],
		owned = new WeakSet();

	let data: Buffer | null = null,
		owning = false,
		at = 0,
		part: Buffer | null = null,
		filled = 0,
		paused = false,
		running = false,
		broken = false;

	return {
		push(x: Buffer) {
			if (broken) {
				return;
			}

			chunks.push(shared && (paused || owning) ? own(x) : x);
			pump();
		},
		get paused() {
			return paused;
		},
		owns(x: Buffer) {
			return !shared || owned.has(x);
		},
		own(x: boolean) {
			owning = x;
			if (x) {
				settle();
			}
		},
		pause() {
			paused = true;
			settle();
		},
		resume() {
			paused = false;
			pump();
		},
	};

	function own(x: Buffer) {
		const copy = Buffer.from(x);
		owned.add(copy);
		return copy;
	}

	function settle() {
		if (!shared) {
			return;
		}

		if (data && at < data.length && !owned.has(data)) {
			data = own(data.subarray(at));
			at = 0;
		}
		for (let i = 0; i < chunks.length; i++) {
			if (!owned.has(chunks[i])) {
				chunks[i] = own(chunks[i]);
			}
		}
	}

	function pump() {
		if (running) {
			return;
		}

		running = true;
		try {
			while (true) {
				// onframe() may pause, and a bad length breaks
				if (broken || paused) {
					break;
				}
				const chunk = data !== null && at < data.length ? data : next();
				if (chunk === null) {
					break;
				}
				if (part !== null) {
					fill(chunk, part);
				} else {
					frame(chunk);
				}
			}
		} finally {
			running = false;
		}
	}

	function invalid(length: number) {
		if (length >= 4 && length <= largest) {
			return false;
		}

		broken = true;
		chunks.length = 0;
		data = part = null;
		at = filled = 0;
		const failure = Object.assign(
			new Error("The server sent a message with an invalid length (" + length + ")"),
			{ code: "PROTOCOL_ERROR" },
		);
		if (onerror) {
			onerror(failure);
		}
		return true;
	}

	/** @returns the next chunk, which becomes `data`, read from its start; or null if none waits */
	function next() {
		data = chunks.shift() ?? null;
		at = 0;
		return data;
	}

	/**
	 * Reads the frame at `at` of `chunk` (the current `data`), if the chunk holds it whole; else
	 * starts a partial frame with the rest of the chunk.
	 */
	function frame(chunk: Buffer) {
		const left = chunk.length - at;
		if (left < 5) {
			return start(chunk, 5);
		}

		const length = chunk.readInt32BE(at + 1);
		if (invalid(length)) {
			return;
		}

		const end = at + 1 + length;
		if (end > chunk.length) {
			return start(chunk, end - at);
		}

		const begin = at;
		at = end;
		onframe(chunk[begin], chunk, begin, end);
	}

	/** Starts a partial frame of `length` bytes with the rest of `chunk` */
	function start(chunk: Buffer, length: number) {
		const x = Buffer.allocUnsafe(length);
		part = x;
		if (shared) {
			owned.add(x);
		}
		filled = chunk.copy(x, 0, at);
		at = chunk.length;
	}

	/**
	 * Fills partial frame `x` (the current `part`) from `chunk` (the current `data`), and reads the
	 * frame once it is whole. A partial frame of 5 bytes is a header, which gives the frame's length.
	 */
	function fill(chunk: Buffer, x: Buffer) {
		const n = chunk.copy(x, filled, at, at + x.length - filled);
		filled += n;
		at += n;
		if (filled < x.length) {
			return;
		}

		if (x.length === 5) {
			const length = x.readInt32BE(1);
			if (invalid(length)) {
				return;
			}

			const whole = Buffer.allocUnsafe(1 + length);
			part = whole;
			if (shared) {
				owned.add(whole);
			}
			filled = x.copy(whole);
			if (filled === whole.length) {
				done(whole);
			}
			return;
		}
		done(x);
	}

	/** Reads whole frame `x`, the current `part` */
	function done(x: Buffer) {
		part = null;
		onframe(x[0], x, 0, x.length);
	}
}

const error_fields: Record<number, string> = {
	83: "severity_local",
	86: "severity",
	67: "code",
	77: "message",
	68: "detail",
	72: "hint",
	80: "position",
	112: "internal_position",
	113: "internal_query",
	87: "where",
	115: "schema_name",
	116: "table_name",
	99: "column_name",
	100: "data_type_name",
	110: "constraint_name",
	70: "file",
	76: "line",
	82: "routine",
};

export function error(x: Buffer, start: number, end: number) {
	const fields: Record<string, string> = {};
	for (let i = start + 5; i < end - 1;) {
		const zero = x.indexOf(0, i + 1);
		fields[error_fields[x[i]] || String.fromCharCode(x[i])] = x.toString("utf8", i + 1, zero);
		i = zero + 1;
	}
	// The V field (the severity, not localized) is optional: PostgreSQL sends it since 9.6, and a
	// pooler that makes its own errors may send only S
	if (fields.severity === undefined && fields.severity_local !== undefined) {
		fields.severity = fields.severity_local;
	}
	return fields;
}

/** A Buffer with Node's undocumented utf8Slice(), which skips the argument checks of toString() */
type Sliceable = Buffer & { utf8Slice(start: number, end: number): string };

export const text: (x: Buffer, start: number, end: number) => string =
	typeof (Buffer.prototype as Partial<Sliceable>).utf8Slice === "function"
		? (x, start, end) => (x as Sliceable).utf8Slice(start, end)
		: (x, start, end) => x.toString("utf8", start, end);

const u32 = (x: Buffer, i: number) =>
		((x[i] << 24) | (x[i + 1] << 16) | (x[i + 2] << 8) | x[i + 3]) >>> 0,
	u16 = (x: Buffer, i: number) => (x[i] << 8) | x[i + 1],
	field = (name: string, table: number, number: number, type: number): Column => ({
		name,
		table,
		number,
		type,
	});

/** A column of a RowDescription. The connection adds `parser` and `decode` to the columns it makes. */
export type Column = {
	name: string;
	/** The oid of the table that the column is from, or 0 */
	table: number;
	/** The column's number in that table, or 0 */
	number: number;
	/** The oid of the column's type */
	type: number;
	/** Parses a value of the column from its text; null for a column read as text */
	parser?: ((x: string) => unknown) | null;
	/** Decodes a value of the column from its binary form, for a column fetched in binary; else null */
	decode?: ((x: Buffer, start: number, end: number) => unknown) | null;
};

export function row_description(x: Buffer, start: number, end: number, make = field) {
	const columns = new Array((x[start + 5] << 8) | x[start + 6]);
	for (let i = start + 7, j = 0; j < columns.length; j++) {
		let zero = i;
		while (x[zero] !== 0) {
			zero++;
		}
		columns[j] = make(text(x, i, zero), u32(x, zero + 1), u16(x, zero + 5), u32(x, zero + 7));
		i = zero + 19;
	}
	return columns;
}

export function parameter_description(x: Buffer, start: number) {
	const oids = new Array(x.readUInt16BE(start + 5));
	for (let j = 0; j < oids.length; j++) {
		oids[j] = x.readUInt32BE(start + 7 + j * 4);
	}

	return oids;
}

export function command_complete(x: Buffer, start: number, end: number) {
	const first = start + 5;

	let e = end - 1,
		count = null;

	while (true) {
		let s = e - 1;
		while (s >= first && x[s] >= 48 && x[s] <= 57) {
			s--;
		}
		if (s === e - 1 || s < first || x[s] !== 32) {
			break;
		}
		if (count === null) {
			count = +text(x, s + 1, e);
		}
		e = s;
	}

	return { command: text(x, first, e), count };
}

export function ready_for_query(x: Buffer, start: number) {
	return String.fromCharCode(x[start + 5]);
}

export function notification(x: Buffer, start: number) {
	const zero = x.indexOf(0, start + 9);
	return {
		pid: x.readInt32BE(start + 5),
		channel: x.toString("utf8", start + 9, zero),
		payload: x.toString("utf8", zero + 1, x.indexOf(0, zero + 1)),
	};
}

export function parameter_status(x: Buffer, start: number) {
	const zero = x.indexOf(0, start + 5);
	return [
		x.toString("utf8", start + 5, zero),
		x.toString("utf8", zero + 1, x.indexOf(0, zero + 1)),
	];
}

/** The backend's process id and the secret key of its cancel requests, from BackendKeyData */
export type Backend = { pid: number; secret: number };

export function backend_key_data(x: Buffer, start: number): Backend {
	return { pid: x.readInt32BE(start + 5), secret: x.readInt32BE(start + 9) };
}
