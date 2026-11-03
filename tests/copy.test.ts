import fs from "fs";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import stream from "stream";
import { expect, test } from "vitest";
import type { Sql } from "../types/index.js";
import {
	postgres,
	sql,
	options,
	delay,
	rel,
	server_major,
	until_sleeping,
	defer,
} from "./setup.ts";

test("Copy read", async () => {
	const result = [];

	await sql`create table test (x int)`;
	await sql`insert into test select * from generate_series(1,10)`;
	const readable = await sql`copy test to stdout`.readable();
	readable.on("data", (x) => result.push(x));
	await new Promise((r) => readable.on("end", r));

	expect(result.length).toBe(10);
});

test("Copy write", async () => {
	await sql`create table test (x int)`;
	const writable = await sql`copy test from stdin`.writable();

	writable.write("1\n");
	writable.write("1\n");
	writable.end();

	await new Promise((r) => writable.on("finish", r));

	expect((await sql`select 1 from test`).length).toBe(2);
});

test("Copy write as first", async () => {
	await sql`create table test (x int)`;
	const first = postgres(options);
	const writable =
		await first`COPY test FROM STDIN WITH(FORMAT csv, HEADER false, DELIMITER ',')`.writable();
	writable.write("1\n");
	writable.write("1\n");
	writable.end();

	await new Promise((r) => writable.on("finish", r));

	expect((await sql`select 1 from test`).length).toBe(2);
});

test("Copy from file", async () => {
	await sql`create table test (x int, y int, z int)`;
	await pipeline(fs.createReadStream(rel("copy.csv")), await sql`copy test from stdin`.writable());

	expect(await sql`select * from test order by x`).toEqual([
		{ x: 1, y: 2, z: 3 },
		{ x: 4, y: 5, z: 6 },
	]);
});

test("Copy from works in transaction", async () => {
	await sql`create table test(x int)`;
	const xs = await sql.begin(async (tx) => {
		(await tx`copy test from stdin`.writable()).end("1\n2");
		await delay(20);
		return tx`select 1 from test`;
	});

	expect(xs.length).toBe(2);
});

test("Copy from abort", async () => {
	await using sql = postgres(options);
	const readable = fs.createReadStream(rel("copy.csv"));

	await sql`create table test (x int, y int, z int)`;
	await sql`TRUNCATE TABLE test`;

	const writable = await sql`COPY test FROM STDIN`.writable();

	let aborted!: Error;

	readable.pipe(writable).on("error", (err) => (aborted = err));

	writable.destroy(new Error("abort"));
	await sql.end();

	expect(aborted.message).toBe("abort");
});

test("query during copy error", async () => {
	const sql = postgres(options);
	await sql`create table test (id serial primary key, name text)`;
	const copy = await sql`copy test from stdin`.writable();
	const error = await sql`select 1`.catch((e) => e);
	await new Promise<void>((r) => copy.end(() => r()));

	expect(error.code).toBe("COPY_IN_PROGRESS");
});

test("Copy from settles instead of hanging when the server rejects the data", async () => {
	await sql`create table test (x int, y int)`;

	const error = await sql
		.begin(async (tx) => {
			const writable = await tx`copy test from stdin`.writable();
			await new Promise((resolve, reject) => {
				writable.on("error", reject);
				writable.on("finish", resolve);
				writable.end("1\t2\t3\n");
			});
		})
		.catch((e) => e);

	const [{ count }] = await sql`
    select count(*)::int as count from pg_stat_activity
    where datname = current_database() and state = 'idle in transaction (aborted)'
  `;

	expect([error.code, count]).toEqual(["22P04", 0]);
});

test("Copy read with back-pressure", async () => {
	await sql`create table test (x int)`;

	const bufferSize = Math.ceil(stream.getDefaultHighWaterMark(false) / 6);
	await sql`insert into test select * from generate_series(10000, ${9999 + bufferSize})`;

	let result = 0;
	const readable = await sql`copy test to stdout`.readable();
	readable.on("data", () => result++);
	readable.pause();

	await Promise.all([
		new Promise((r) => readable.on("end", r)),
		new Promise<void>((r) =>
			readable.on("readable", () => {
				if ((readable as any).readableBuffer.length === bufferSize) {
					readable.removeAllListeners("readable");
					r();
				}
			}),
		),
	]);

	await sql`select 1`;

	expect(result).toBe(bufferSize);
});

test("Copy read through a slow pipeline keeps every byte and never stalls", async () => {
	const [expected, got] = await slowCopy(sql);
	expect(got).toBe(expected);
}, 30_000);

test("Copy read through a slow pipeline over direct TLS keeps every byte", async ({ skip }) => {
	const major = await server_major();
	skip(major < 17, "direct TLS needs PostgreSQL 17 or later");

	await using tls = postgres({ ...options, ssl: "require", sslnegotiation: "direct", max: 1 });
	const [{ ssl }] = await tls`select ssl from pg_stat_ssl where pid = pg_backend_pid()`;
	const [expected, got] = await slowCopy(tls);
	expect([got, ssl]).toEqual([expected, true]);
}, 30_000);

async function slowCopy(sql: Sql) {
	const query =
			"select i, md5(i::text) || repeat(chr(65 + i % 26), i % 300) from generate_series(1, 50000) i",
		[{ expected }] = await sql.unsafe(
			`select md5(string_agg(i || E'\\t' || x || E'\\n', '' order by i)) as expected from (${query}) t(i, x)`,
		),
		hash = crypto.createHash("md5");
	let n = 0;
	await pipeline(
		await sql.unsafe(`copy (${query}) to stdout`).readable(),
		new stream.Writable({
			highWaterMark: 1024,
			write(chunk, encoding, callback) {
				hash.update(chunk);
				if (n++ % 500 === 0) {
					setTimeout(callback, 1);
				} else if (n % 3) {
					callback();
				} else {
					setImmediate(callback);
				}
			},
		}),
	);
	return [expected, hash.digest("hex")];
}

test("A query on a reserved connection during its COPY is rejected and the COPY completes", async () => {
	await sql`create table test (a int)`;
	using reserved = await sql.reserve();
	const writable = await reserved`copy test from stdin`.writable();
	writable.write("1\n");
	const code = await reserved`select 1`.then(
		() => "ran",
		(e) => e.code,
	);
	await new Promise((resolve, reject) => {
		writable.on("finish", resolve);
		writable.on("error", reject);
		writable.end("2\n");
	});
	const [{ n }] = await reserved`select count(*)::int as n from test`;
	expect([code, n]).toEqual(["COPY_IN_PROGRESS", 2]);
});

test("A copy from stdin writable has the count of rows copied once it finishes (#465)", async () => {
	await sql`create table test (x int)`;
	const writable = await sql`copy test from stdin`.writable();
	await new Promise((resolve, reject) => {
		writable.on("finish", resolve);
		writable.on("error", reject);
		writable.write("1\n2\n");
		writable.end("3\n");
	});
	expect([writable.count, writable.command]).toEqual([3, "COPY"]);
});

test("Copy write waits for the socket to drain between large chunks", async () => {
	await sql`create table test (x text)`;
	const line = "x".repeat(1024 * 1024 - 1) + "\n",
		writable = await sql`copy test from stdin`.writable();
	await pipeline(stream.Readable.from(Array.from({ length: 8 }, () => line)), writable);
	const [{ n }] = await sql`select count(*)::int as n from test`;
	expect([writable.count, n]).toEqual([8, 8]);
});

test("Destroying a copy to stdout readable while back-pressure has paused it leaves the connection usable", async () => {
	await using sql = postgres({ ...options, max: 1, idle_timeout: null });
	const readable =
		await sql`copy (select repeat('x', 1000) from generate_series(1, 1000)) to stdout`.readable();
	// Nothing reads, so the connection stops reading the socket once the buffer is full
	while (readable.readableLength < readable.readableHighWaterMark) {
		await delay(1);
	}
	readable.destroy();
	const [{ x }] = await sql`select 1 as x`;
	expect(x).toBe(1);
});

test("Destroying a copy to stdout readable from a data handler leaves the connection usable", async () => {
	await using sql = postgres({ ...options, max: 1, idle_timeout: null });
	const xs = [];
	// Once the stream flows with an empty buffer, `push` emits "data" synchronously,
	// so destroying after a later chunk does so from inside `push`.
	for (const after of [1, 2, 50, 500]) {
		const readable =
			await sql`copy (select repeat('x', 1000) from generate_series(1, 1000)) to stdout`.readable();
		let n = 0;
		readable.on("data", () => {
			n++;
			if (n === after) {
				readable.destroy();
			}
		});
		const [{ x }] = await sql`select ${after}::int as x`;
		xs.push(x);
	}
	expect(xs).toEqual([1, 2, 50, 500]);
});

/** A COPY TO STDOUT whose server produces 5000 rows at once, and then one row a second for about a day. */
const SLOW_COPY =
	"copy (select i, case when i > 5000 then pg_sleep(1)::text end from generate_series(1, 90000) i) to stdout";

test("Canceling a copy to stdout that is being read fails its readable with 57014", async () => {
	await using sql = postgres({ ...options, max: 1, idle_timeout: null });
	const query = sql.unsafe(SLOW_COPY),
		readable = await query.readable();
	let cancelled!: Promise<void>;
	const error = await new Promise<{ code: string }>((resolve) => {
		readable.on("error", resolve);
		readable.once("data", () => {
			cancelled = query.cancel();
		});
	});
	await cancelled;
	const [{ x }] = await sql`select 1 as x`;
	expect([error.code, x]).toEqual(["57014", 1]);
});

test("Canceling a copy to stdout whose readable was destroyed in a transaction stops it, and aborts the transaction", async () => {
	await using sql = postgres({ ...options, max: 1, idle_timeout: null });
	const error = await sql
		.begin(async (tx) => {
			const query = tx.unsafe(SLOW_COPY),
				readable = await query.readable();
			await new Promise((resolve) => readable.once("data", resolve));
			// In a transaction block, the destroy only drops the rest, which would take a day
			readable.destroy();
			await query.cancel();
			await tx`select 1`;
		})
		.catch((e) => e);
	const [{ x }] = await sql`select 1 as x`;
	expect([error.code, x]).toEqual(["25P02", 1]);
});

test("A query is not queued behind a copy to stdout that nobody reads", async () => {
	await using sql = postgres({ ...options, max: 2 });
	using reserved = await sql.reserve();
	const readable =
			await sql`copy (select repeat('x', 1000) from generate_series(1, 1000)) to stdout`.readable(),
		query = sql`select 1 as x`.execute();
	// Until the release, the COPY's connection is the only one the pool may use
	await delay(50);
	reserved.release();
	const [{ x }] = await query;
	readable.destroy();
	expect(x).toBe(1);
	// The COPY's connection still discards the rest of the COPY's output, which the disposal would
	// count as unfinished; end() waits for it
	await sql.end();
});

test("Canceling a copy from stdin that waits for data fails its writable with 57014", async () => {
	await using sql = postgres({ ...options, max: 1, idle_timeout: null });
	await sql`create table test (x int)`;
	const query = sql`copy test from stdin`,
		writable = await query.writable();
	writable.write("1\n");
	// The server holds back a cancel request while it waits for COPY data
	const error = await new Promise<{ code: string }>((resolve) => {
			writable.on("error", resolve);
			void query.cancel();
		}),
		[{ n }] = await sql`select count(*)::int as n from test`;
	expect([error.code, n]).toEqual(["57014", 0]);
});

test("Canceling a copy to stdout while back-pressure has paused it fails its readable with 57014", async () => {
	await using sql = postgres({ ...options, max: 1, idle_timeout: null });
	const query = sql`copy (select repeat('x', 1000) from generate_series(1, 1000)) to stdout`,
		readable = await query.readable();
	while (readable.readableLength < readable.readableHighWaterMark) {
		await delay(1);
	}
	const error = await new Promise<{ code: string }>((resolve) => {
			readable.on("error", resolve);
			void query.cancel();
		}),
		[{ x }] = await sql`select 1 as x`;
	expect([error.code, x]).toEqual(["57014", 1]);
});

test("Destroying a copy both stream ends it with CopyDone, which keeps the connection", async () => {
	await sql`drop publication if exists copy_both`;
	await sql`create publication copy_both`;
	await using _drop = defer(() => sql`drop publication copy_both`);
	await using replication = postgres({
		database: options.db,
		max: 1,
		connection: { replication: "database" },
	});
	await replication.unsafe(
		"CREATE_REPLICATION_SLOT copy_both TEMPORARY LOGICAL pgoutput NOEXPORT_SNAPSHOT",
	);
	const [{ pid }] = await replication`select pg_backend_pid() as pid`.simple(),
		duplex = await replication
			.unsafe(
				"START_REPLICATION SLOT copy_both LOGICAL 0/0 (proto_version '1', publication_names 'copy_both')",
			)
			.writable();
	// walsender takes any message but CopyData, CopyDone and Terminate as a FATAL error
	duplex.destroy();
	const [{ pid: after }] = await replication`select pg_backend_pid() as pid`.simple();
	expect(after).toBe(pid);
});

test("Destroying a copy to stdout outside a transaction makes the server stop it", async () => {
	await using sql = postgres({ ...options, max: 1, idle_timeout: null });
	const readable = await sql.unsafe(SLOW_COPY).readable();
	await new Promise((resolve) => readable.once("data", resolve));
	readable.destroy();
	const [{ x }] = await sql`select 1 as x`;
	expect(x).toBe(1);
});

test("Destroying a copy to stdout in a transaction only drops the rest, which keeps the transaction", async () => {
	await using sql = postgres({ ...options, max: 1, idle_timeout: null });
	const x = await sql.begin(async (tx) => {
		// Still running when destroyed, but only for about a second more
		const readable =
			await tx`copy (select i, case when i > 5000 then pg_sleep(0.01)::text end from generate_series(1, 5100) i) to stdout`.readable();
		await new Promise((resolve) => readable.once("data", resolve));
		readable.destroy();
		const [{ x: one }] = await tx`select 1 as x`;
		return one;
	});
	expect(x).toBe(1);
});

test("Destroying a copy to stdout whose end is already buffered does not cancel the next query", async () => {
	await using sql = postgres({ ...options, max: 1, idle_timeout: null });
	const xs = [];
	using reserved = await sql.reserve();
	// With these sizes, back-pressure pauses the connection inside the last chunk of the
	// output, so the end of the COPY waits unread in that chunk
	for (const rows of [650, 700, 800, 1000]) {
		const readable = await reserved
			.unsafe(`copy (select repeat('x', 100) from generate_series(1, ${rows})) to stdout`)
			.readable();
		while (readable.readableLength < readable.readableHighWaterMark) {
			await delay(1);
		}
		await delay(20);
		const sleeping = reserved`select pg_sleep(0.1), ${rows}::int as x`.execute();
		// Let the query reach the connection, where it waits for the COPY to finish
		await delay(5);
		readable.destroy();
		const [{ x }] = await sleeping;
		xs.push(x);
	}
	expect(xs).toEqual([650, 700, 800, 1000]);
}, 20_000);

test("Destroying a copy to stdout after a begin in the same query keeps the transaction", async () => {
	await using sql = postgres({ ...options, max: 1, idle_timeout: null });
	using reserved = await sql.reserve();
	// Still running when destroyed, but only for about a second more
	const readable = await reserved
		.unsafe(
			"begin; copy (select i, case when i > 5000 then pg_sleep(0.01)::text end from generate_series(1, 5100) i) to stdout",
		)
		.readable();
	await new Promise((resolve) => readable.once("data", resolve));
	readable.destroy();
	const [{ x }] = await reserved`select 1 as x`;
	await reserved`rollback`;
	expect(x).toBe(1);
});

test("Canceling a copy from stdin before it starts fails its query with 57014", async () => {
	await using sql = postgres({ ...options, max: 1, idle_timeout: null });
	await sql`create table test (x int)`;
	// A reserved connection pipelines the COPY behind the sleep; the pool would keep it waiting
	using reserved = await sql.reserve();
	const [{ pid }] = await reserved`select pg_backend_pid() as pid`,
		head = reserved`select pg_sleep(0.2)`.execute(),
		query = reserved`copy test from stdin`,
		writable = query.writable();
	await until_sleeping(pid);
	// The server would hold back the cancel request while it waits for COPY data
	const cancelled = query.cancel(),
		error = await writable.then(
			(sink) => new Promise((resolve) => sink.on("error", resolve)),
			(e) => e,
		);
	await Promise.all([cancelled, head]);
	expect(error.code).toBe("57014");
});

test("Canceling a query after the end of its copy to stdout stops the statements after the COPY", async () => {
	await using sql = postgres({ ...options, max: 1, idle_timeout: null });
	const query = sql.unsafe(
			// The server flushes its output only when its buffer is full, which the long row does
			"copy (select 1) to stdout; select repeat('x', 70000); select pg_sleep(100)",
		),
		readable = await query.readable();
	await new Promise((resolve) => readable.on("end", resolve).resume());
	await query.cancel();
	const [{ x }] = await sql`select 1 as x`;
	expect(x).toBe(1);
});
