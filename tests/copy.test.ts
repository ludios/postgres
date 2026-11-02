import fs from "fs";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import stream from "stream";
import { expect, test } from "vitest";
import { postgres, sql, options, delay, rel, server_major } from "./setup.ts";

test("Copy read", async () => {
	const result = [];

	await sql`create table test (x int)`;
	await sql`insert into test select * from generate_series(1,10)`;
	const readable = await sql`copy test to stdout`.readable();
	readable.on("data", (x) => result.push(x));
	await new Promise((r) => readable.on("end", r));

	expect(result.length).toBe(10);
	await sql`drop table test`;
});

test("Copy write", async () => {
	await sql`create table test (x int)`;
	const writable = await sql`copy test from stdin`.writable();

	writable.write("1\n");
	writable.write("1\n");
	writable.end();

	await new Promise((r) => writable.on("finish", r));

	expect((await sql`select 1 from test`).length).toBe(2);
	await sql`drop table test`;
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
	await sql`drop table test`;
});

test("Copy from file", async () => {
	await sql`create table test (x int, y int, z int)`;
	await new Promise(async (r) =>
		fs
			.createReadStream(rel("copy.csv"))
			.pipe(await sql`copy test from stdin`.writable())
			.on("finish", r),
	);

	expect(await sql`select * from test order by x`).toEqual([
		{ x: 1, y: 2, z: 3 },
		{ x: 4, y: 5, z: 6 },
	]);
	await sql`drop table test`;
});

test("Copy from works in transaction", async () => {
	await sql`create table test(x int)`;
	const xs = await sql.begin(async (sql) => {
		(await sql`copy test from stdin`.writable()).end("1\n2");
		await delay(20);
		return sql`select 1 from test`;
	});

	expect(xs.length).toBe(2);
	await sql`drop table test`;
});

test("Copy from abort", async () => {
	const sql = postgres(options);
	const readable = fs.createReadStream(rel("copy.csv"));

	await sql`create table test (x int, y int, z int)`;
	await sql`TRUNCATE TABLE test`;

	const writable = await sql`COPY test FROM STDIN`.writable();

	let aborted;

	readable.pipe(writable).on("error", (err) => (aborted = err));

	writable.destroy(new Error("abort"));
	await sql.end();

	try {
		expect(aborted.message).toBe("abort");
	} finally {
		await postgres(options)`drop table test`;
	}
});

test("query during copy error", async () => {
	const sql = postgres(options);
	await sql`create table test (id serial primary key, name text)`;
	const copy = await sql`copy test from stdin`.writable();
	const error = await sql`select 1`.catch((e) => e);
	await copy.end();

	expect(error.code).toBe("COPY_IN_PROGRESS");
	await sql`drop table test`;
});

test("Copy from settles instead of hanging when the server rejects the data", async () => {
	await sql`create table test (x int, y int)`;

	const error = await sql
		.begin(async (sql) => {
			const writable = await sql`copy test from stdin`.writable();
			await new Promise((resolve, reject) => {
				writable.on("error", reject);
				writable.on("finish", resolve);
				writable.end("1\t2\t3\n");
			});
		})
		.catch((e) => e);

	const [{ count }] = await sql`
    select count(*)::int as count from pg_stat_activity
    where state = 'idle in transaction (aborted)'
  `;

	expect([error.code, count]).toEqual(["22P04", 0]);
	await sql`drop table test`;
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
				if (readable.readableBuffer.length === bufferSize) {
					readable.removeAllListeners("readable");
					r();
				}
			}),
		),
	]);

	await sql`select 1`;

	expect(result).toBe(bufferSize);
	await sql`drop table test`;
});

test(
	"Copy read through a slow pipeline keeps every byte and never stalls",
	{ timeout: 30_000 },
	async () => {
		const [expected, got] = await slowCopy(sql);
		expect(got).toBe(expected);
	},
);

test(
	"Copy read through a slow pipeline over direct TLS keeps every byte",
	{ timeout: 30_000 },
	async ({ skip }) => {
		const major = await server_major();
		skip(major < 17, "direct TLS needs PostgreSQL 17 or later");

		const tls = postgres({ ...options, ssl: "require", sslnegotiation: "direct", max: 1 });
		const [{ ssl }] = await tls`select ssl from pg_stat_ssl where pid = pg_backend_pid()`;
		const [expected, got] = await slowCopy(tls);
		await tls.end();
		expect([got, ssl]).toEqual([expected, true]);
	},
);

async function slowCopy(sql) {
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
				n++ % 500 === 0 ? setTimeout(callback, 1) : n % 3 ? callback() : setImmediate(callback);
			},
		}),
	);
	return [expected, hash.digest("hex")];
}

test("A query on a reserved connection during its COPY is rejected and the COPY completes", async () => {
	await sql`create table test (a int)`;
	const reserved = await sql.reserve();
	const writable = await reserved`copy test from stdin`.writable();
	writable.write("1\n");
	const code = await reserved`select 1`.then(
		() => "ran",
		(e) => e.code,
	);
	await new Promise(
		(resolve, reject) => (
			writable.on("finish", resolve),
			writable.on("error", reject),
			writable.end("2\n")
		),
	);
	const [{ n }] = await reserved`select count(*)::int as n from test`;
	reserved.release();
	expect([code, n]).toEqual(["COPY_IN_PROGRESS", 2]);
	await sql`drop table test`;
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
	await sql`drop table test`;
});

test(
	"Copy write waits for the socket to drain between large chunks",
	{ timeout: 10_000 },
	async () => {
		await sql`create table test (x text)`;
		const line = "x".repeat(1024 * 1024 - 1) + "\n",
			writable = await sql`copy test from stdin`.writable();
		await pipeline(stream.Readable.from(Array.from({ length: 8 }, () => line)), writable);
		const [{ n }] = await sql`select count(*)::int as n from test`;
		expect([writable.count, n]).toEqual([8, 8]);
		await sql`drop table test`;
	},
);

test(
	"Destroying a copy to stdout readable while back-pressure has paused it leaves the connection usable",
	{ timeout: 10_000 },
	async () => {
		const sql = postgres({ ...options, max: 1 }),
			readable =
				await sql`copy (select repeat('x', 1000) from generate_series(1, 1000)) to stdout`.readable();
		// Nothing reads, so the connection stops reading the socket once the buffer is full
		while (readable.readableLength < readable.readableHighWaterMark) {
			await delay(1);
		}
		readable.destroy();
		const [{ x }] = await sql`select 1 as x`;
		await sql.end();
		expect(x).toBe(1);
	},
);

test(
	"Destroying a copy to stdout readable from a data handler leaves the connection usable",
	{ timeout: 10_000 },
	async () => {
		const sql = postgres({ ...options, max: 1 }),
			xs = [];
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
		await sql.end();
		expect(xs).toEqual([1, 2, 50, 500]);
	},
);

/** A COPY TO STDOUT that sends 5000 rows at once, then one row a second for a day. */
const SLOW_COPY =
	"copy (select i, case when i > 5000 then pg_sleep(1)::text end from generate_series(1, 90000) i) to stdout";

test(
	"Canceling a copy to stdout that is being read fails its readable with 57014",
	{ timeout: 10_000 },
	async () => {
		const sql = postgres({ ...options, max: 1 }),
			query = sql.unsafe(SLOW_COPY),
			readable = await query.readable(),
			error = await new Promise<{ code: string }>((resolve) => {
				readable.on("error", resolve);
				readable.once("data", () => query.cancel());
			}),
			[{ x }] = await sql`select 1 as x`;
		await sql.end();
		expect([error.code, x]).toEqual(["57014", 1]);
	},
);

test(
	"Canceling a copy to stdout whose readable was destroyed lets the next query run",
	{ timeout: 10_000 },
	async () => {
		const sql = postgres({ ...options, max: 1 }),
			query = sql.unsafe(SLOW_COPY),
			readable = await query.readable();
		await new Promise((resolve) => readable.once("data", resolve));
		readable.destroy();
		await query.cancel();
		const [{ x }] = await sql`select 1 as x`;
		await sql.end();
		expect(x).toBe(1);
	},
);
