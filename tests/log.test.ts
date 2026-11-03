// What the library logs, as an operator sees it: tests/unit/log.test.ts covers the helpers that
// make the lines; these tests make the events happen on a server and check the lines.
import net from "net";
import { expect, test } from "vitest";
import { postgres, options, delay } from "./setup.ts";
import { log_lines, log_records, port_of, until } from "./helpers.ts";

/** @returns a TCP port of 127.0.0.1 on which nothing listens */
async function closed_port() {
	const server = net.createServer().listen(0, "127.0.0.1");
	await new Promise((r) => server.once("listening", r));
	const port = port_of(server);
	await new Promise((r) => server.close(r));
	return port;
}

test("a failed connection attempt is logged with its error, the requests it fails and the next attempt", async () => {
	const records = await log_records();
	await using sql = postgres({ ...options, host: "127.0.0.1", port: await closed_port() });
	expect(await sql`select 1`.catch((e) => e.code)).toBe("ECONNREFUSED");
	expect(log_lines(records, "pool", "warning")).toEqual([
		expect.stringMatching(
			/^warning connecting to \S+ failed \(1 in a row\); rejecting 1 waiting requests with this error; next attempt when a request comes, \d+ ms from now at the earliest: connect ECONNREFUSED 127\.0\.0\.1:\d+$/,
		),
	]);
});

test("the pool's first connection is logged at info, with the backend's pid, TLS and the authentication", async () => {
	const records = await log_records();
	await using sql = postgres(options);
	await sql`select 1`;
	expect(log_lines(records, "pool", "info")).toEqual([
		expect.stringMatching(
			/^info connected to \S+ in \d+ ms: connection \d+, backend pid \d+, tls off, auth not asked$/,
		),
	]);
});

test("a connection that the server closes is logged with the server's error and the idle time", async () => {
	const records = await log_records();
	await using sql = postgres({ ...options, max: 1 });
	const [{ pid }] = await sql`select pg_backend_pid() as pid`;
	await using other = postgres(options);
	await other`select pg_terminate_backend(${pid}::int)`;
	await until(() => log_lines(records, "connection", "warning").length);
	expect(log_lines(records, "connection", "warning")).toEqual([
		expect.stringMatching(
			/^warning server closed connection \d+ to \S+ after [\d.]+ s idle: 57P01 terminating connection due to administrator command$/,
		),
	]);
});

test("a notice is logged at the level of its severity", async () => {
	const records = await log_records();
	await using sql = postgres(options);
	await sql`do $$ begin raise warning 'careful'; end $$`;
	expect(log_lines(records, "notice")).toEqual([
		expect.stringMatching(
			/^warning server notice WARNING 01000 on connection \d+ to \S+: careful$/,
		),
	]);
});

test("every query is logged at debug with its times, and a slow one at warning", async () => {
	const records = await log_records();
	await using sql = postgres(options);
	await sql`select 1`;
	await sql`select pg_sleep(1.1)`;
	expect(log_lines(records, "query")).toEqual([
		expect.stringMatching(
			/^debug query on connection \d+ to \S+ took \d+ ms, queued \d+ ms before \(SELECT 1\); sql: select 1$/,
		),
		expect.stringMatching(
			/^warning slow query on connection \d+ to \S+ took 1[01]\d\d ms, queued \d+ ms before \(SELECT 1\); sql: select pg_sleep\(1\.1\)$/,
		),
	]);
});

test("a request rejected with QUEUE_TIMEOUT is logged by the pool, and the query as never sent", async () => {
	const records = await log_records();
	await using sql = postgres({ ...options, max: 1, queue_timeout: 0.2 });
	using reserved = await sql.reserve();
	expect(await sql`select 2`.catch((e) => e.code)).toBe("QUEUE_TIMEOUT");
	expect(reserved).toBeDefined();
	expect(log_lines(records, "pool", "warning")).toEqual([
		expect.stringMatching(
			/^warning a query waited 0\.2 s for a connection to \S+ and was rejected with QUEUE_TIMEOUT$/,
		),
	]);
	expect(log_lines(records, "query").filter((x) => x.includes("select 2"))).toEqual([
		expect.stringMatching(
			/^debug query to \S+ failed after \d+ ms in the queue, before it was sent: QUEUE_TIMEOUT: Waited more than 0\.2 seconds for a connection; sql: select 2$/,
		),
	]);
});

test("requests waiting for a connection for over a second are logged, and so is the queue emptying", async () => {
	const records = await log_records();
	await using sql = postgres({ ...options, max: 1 });
	const held = await sql.reserve(),
		first = sql`select 1`.execute();
	await delay(1100);
	// Placing a request looks at the queue, which has waited for over a second by now
	const second = sql`select 2`.execute();
	await until(() => sql.stats.waiting === 2);
	held.release();
	await Promise.all([first, second]);
	expect(log_lines(records, "pool").filter((x) => x.includes("queue for"))).toEqual([
		expect.stringMatching(
			/^warning queue for a connection to \S+ not empty for [\d.]+ s: 2 requests waiting, the oldest for [\d.]+ s; 1 of 1 connections open \(1 leased\), 0 opening$/,
		),
		expect.stringMatching(/^info queue for a connection to \S+ empty again after [\d.]+ s$/),
	]);
});

test("the LISTEN connection's close, and the channels listening again, are logged", async () => {
	const records = await log_records();
	await using sql = postgres(options);
	const { state } = await sql.listen("logged", () => {});
	await sql`select pg_terminate_backend(${state.pid}::int)`;
	await until(() => log_lines(records, "listen", "info").length);
	expect(log_lines(records, "listen")).toEqual([
		expect.stringMatching(/^debug listening on channel logged at \S+$/),
		expect.stringMatching(
			/^warning LISTEN connection \d+ to \S+ closed; sending LISTEN again for 1 channels; notifications sent until the new LISTENs succeed are lost$/,
		),
		expect.stringMatching(/^debug listening on channel logged at \S+ again$/),
		expect.stringMatching(
			/^info listening again on all 1 channels at \S+, [\d.]+ s after their connection closed$/,
		),
	]);
	expect(log_lines(records, "connection", "warning")).toEqual([
		expect.stringMatching(
			/^warning server closed connection \d+ to \S+ \(LISTEN\) after [\d.]+ s idle: 57P01 terminating connection due to administrator command$/,
		),
	]);
});

test("a server error about the server's own trouble, such as a full disk, is logged at error", async () => {
	const records = await log_records();
	await using sql = postgres(options);
	const code =
		await sql`do $$ begin raise exception 'no space left' using errcode = '53100'; end $$`.catch(
			(e) => e.code,
		);
	expect(code).toBe("53100");
	expect(log_lines(records, "connection", "error")).toEqual([
		expect.stringMatching(
			/^error server reports insufficient resources on connection \d+ to \S+: 53100 no space left$/,
		),
	]);
});

test("a handler that throws is logged at error, and the connection goes on", async () => {
	const records = await log_records();
	await using sql = postgres({
		...options,
		onnotice: () => {
			throw new Error("boom");
		},
	});
	await sql`do $$ begin raise notice 'hi'; end $$`;
	expect((await sql`select 1 as x`)[0].x).toBe(1);
	expect(log_lines(records, "connection", "error")).toEqual([
		expect.stringMatching(/^error onnotice handler threw on connection \d+ to \S+; ignored: boom$/),
	]);
});

test("a transaction left open on a pooled connection, and a reserve released inside one, are logged", async () => {
	const records = await log_records();
	await using sql = postgres({ ...options, max: 2 });
	expect(await sql`begin`.catch((e) => e.code)).toBe("UNSAFE_TRANSACTION");
	const reserved = await sql.reserve();
	await reserved`begin`;
	reserved.release();
	await until(() =>
		log_lines(records, "connection", "debug").some((x) =>
			x.endsWith("closed: released inside a transaction"),
		),
	);
	expect(log_lines(records, "connection", "warning")).toEqual([
		expect.stringMatching(
			/^warning query on pooled connection \d+ to \S+ left a transaction block open; rolling it back and rejecting the queries in flight \(UNSAFE_TRANSACTION\); use sql\.begin\(\) or sql\.reserve\(\); sql: begin$/,
		),
	]);
	expect(log_lines(records, "pool", "warning")).toEqual([
		expect.stringMatching(
			/^warning sql\.reserve\(\) released connection \d+ to \S+ inside an open transaction \(status T\); closing it instead of reusing it$/,
		),
	]);
});
