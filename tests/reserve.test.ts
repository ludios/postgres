import net from "net";
import { expect, test } from "vitest";
import {
	postgres,
	sql,
	options,
	defer,
	delay,
	idle_timeout,
	pg_port,
	port_of,
	terminate,
	until_sleeping,
} from "./setup.ts";

test("Ensure reserve on connection throws proper error", async () => {
	const sql = postgres({
		socket: () => {
			throw "wat";
		},
		idle_timeout,
	});

	expect(await sql.reserve().catch((e) => e)).toBe("wat");
});

test("reserve connection", async () => {
	const reserved = await sql.reserve();

	setTimeout(() => reserved.release(), 510);

	const xs = await Promise.all([
		reserved`select 1 as x`.then(([{ x }]) => ({ time: Date.now(), x })),
		sql`select 2 as x`.then(([{ x }]) => ({ time: Date.now(), x })),
		reserved`select 3 as x`.then(([{ x }]) => ({ time: Date.now(), x })),
	]);

	if (xs[1].time - xs[2].time < 500) {
		throw new Error("Wrong time");
	}

	expect(xs.map((x) => x.x)).toEqual([1, 2, 3]);
});

test("arrays in reserved connection", async () => {
	using reserved = await sql.reserve();
	const [{ x }] = await reserved`select array[1, 2, 3] as x`;

	expect(x).toEqual([1, 2, 3]);
});

test("Ensure reserve on query throws proper error", async () => {
	const sql = postgres({ idle_timeout });
	using reserved = await sql.reserve();
	const [{ x }] = await reserved`select 'wat' as x`;
	expect(x).toBe("wat");
});

test("reserve with fetch_types: false on a cold pool", async () => {
	await using sql = postgres({ ...options, fetch_types: false });
	using reserved = await sql.reserve();
	const [{ x }] = await reserved`select 1 as x`;
	expect(x).toBe(1);
});

test("end() resolves after reserve and release", async () => {
	const sql = postgres(options);
	const reserved = await sql.reserve();
	reserved.release();
	expect(await sql.end().then(() => "ended")).toBe("ended");
});

test("end() resolves when a reserved connection is released after end was called (#1262)", async () => {
	const sql = postgres({ ...options, max: 2 });
	const reserved = await sql.reserve();
	await reserved`select 1`;
	const ended = sql.end();
	await delay(10);
	reserved.release();
	expect([await ended.then(() => "ended"), sql.stats.connections]).toEqual(["ended", 0]);
});

test("reserve queued behind a terminated connection", async () => {
	await using pool = postgres(options);
	const reserved = await pool.reserve();
	const [{ pid }] = await reserved`select pg_backend_pid() as pid`;
	const pending = pool.reserve();

	await terminate(pid);

	using next = await pending;
	const [{ x }] = await next`select 1 as x`;

	expect(x).toBe(1);
});

test("reserve after a terminated query", async () => {
	await using pool = postgres(options);
	const reserved = await pool.reserve();
	const [{ pid }] = await reserved`select pg_backend_pid() as pid`;
	const query = reserved`select pg_sleep(30)`.catch((e) => e);

	await until_sleeping(pid);

	await terminate(pid);
	await query;

	using next = await pool.reserve();
	const [{ x }] = await next`select 1 as x`;

	expect(x).toBe(1);
});

test("Reserved connection rejects queries after its backend is terminated", async () => {
	await using sql = postgres({ ...options, max: 2 });
	using reserved = await sql.reserve();
	const [{ pid }] = await reserved`select pg_backend_pid() as pid`;
	await sql`select pg_terminate_backend(${pid})`;
	await delay(100);
	const first = await reserved`select 1`.catch((e) => e.code);
	const second = await reserved`select 2`.catch((e) => e.code);
	expect([first, second]).toEqual(["CONNECTION_CLOSED", "CONNECTION_CLOSED"]);
});

test("Releasing a terminated reserved connection does not return it to the pool", async () => {
	await using sql = postgres({ ...options, max: 1 });
	using reserved = await sql.reserve();
	const [{ pid }] = await reserved`select pg_backend_pid() as pid`;
	await terminate(pid);
	await delay(100);
	await reserved`select 1`.catch(() => {});
	reserved.release();
	const [{ x }] = await Promise.race([sql`select 1 as x`, delay(2000).then(() => [{ x: "hung" }])]);
	expect(x).toBe(1);
});

test("Writing to a closed reserved connection rejects instead of crashing", async () => {
	let downstream;
	const proxy = net.createServer((x) => {
		downstream = x;
		const upstream = net.connect(pg_port, "127.0.0.1");
		x.pipe(upstream).pipe(x);
		x.on("error", () => upstream.destroy());
		upstream.on("error", () => x.destroy());
	});

	await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
	await using _close = defer(() => proxy.close());

	const sql = postgres({ ...options, host: "127.0.0.1", port: port_of(proxy), max: 1 });
	using reserved = await sql.reserve();

	await reserved`select 1`;
	downstream.end();
	await delay(50);

	const code = await reserved`select 1`.catch((e) => e.code);

	expect(code).toBe("CONNECTION_CLOSED");
});

test("A reserved connection released while its BEGIN is still unanswered is not handed to the next query in that transaction", async () => {
	await using sql = postgres({ ...options, max: 1 });
	await sql`create table test (a int)`;
	using reserved = await sql.reserve();
	const begin = reserved`begin`.execute();
	const insert = reserved`insert into test values (1)`.execute();
	begin.catch(() => {});
	insert.catch(() => {});
	await new Promise((r) => setTimeout(r, 0));
	reserved.release();
	const pooled = await sql`insert into test values (2)`.then(
		(x) => x.command,
		(e) => e.code,
	);
	const leased = [
		await begin.then(
			(x) => x.command,
			(e) => e.code,
		),
		await insert.then(
			(x) => x.command,
			(e) => e.code,
		),
	];
	const rows = (await sql`select array_agg(a order by a) as a from test`)[0].a;
	expect([pooled, leased, rows]).toEqual(["INSERT", ["BEGIN", "INSERT"], [2]]);
});

test("reserve and begin after end reject with CONNECTION_ENDED", async () => {
	const sql = postgres({ ...options });
	await sql`select 1`;
	await sql.end();
	const codes = [
		await sql.reserve().then(
			() => "ok",
			(e) => e.code,
		),
		await sql
			.begin(() => 1)
			.then(
				() => "ok",
				(e) => e.code,
			),
	];
	expect(codes).toEqual(["CONNECTION_ENDED", "CONNECTION_ENDED"]);
});

test("Releasing a reserved connection twice releases it once", async () => {
	await using sql = postgres({ ...options, max: 1 });
	const reserved = await sql.reserve();
	reserved.release();
	reserved.release();
	const [[a], [b]] = await Promise.all([
		sql`select 1 as x`,
		sql.reserve().then((r) => r`select 2 as x`.finally(r.release)),
	]);
	expect([a.x, b.x]).toEqual([1, 2]);
});

test("A describe() that a reserved connection gets as it is released rejects instead of running", async () => {
	await using sql = postgres(options);
	using reserved = await sql.reserve();
	const described = reserved`select ${"a"}::text as x`.describe().then(
		() => "described",
		(e) => e.code,
	);
	// The query is sent to the lease in one microtask, and goes to the connection in a later
	// microtask; the lease is released in a microtask between those two
	queueMicrotask(() => reserved.release());
	expect(await described).toBe("UNSAFE_TRANSACTION");
});
