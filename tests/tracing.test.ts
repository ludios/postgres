import dc from "diagnostics_channel";
import { AsyncLocalStorage } from "async_hooks";
import { expect, test } from "vitest";
import { postgres, options, delay, pg_port } from "./setup.ts";

function record(name) {
	const events = [],
		channel = dc.tracingChannel(name),
		recorder = (event) => (context) => events.push({ event, context, snapshot: { ...context } }),
		handlers = {
			start: recorder("start"),
			end: recorder("end"),
			asyncStart: recorder("asyncStart"),
			asyncEnd: recorder("asyncEnd"),
			error: recorder("error"),
		};
	channel.subscribe(handlers);
	return { events, stop: () => channel.unsubscribe(handlers) };
}

function listen(name) {
	const messages = [],
		fn = (message) => messages.push(message);
	dc.subscribe(name, fn);
	return { messages, stop: () => dc.unsubscribe(name, fn) };
}

test("Tracing: a query publishes start, end, asyncStart and asyncEnd with what it ran", async () => {
	const sql = postgres({ ...options, max: 1 });
	await sql`select 1`;
	const { events, stop } = record("postgres:query");
	const [{ x }] = await sql`select ${1}::int as x`;
	stop();
	const order = events.map((x) => x.event),
		c = events[events.length - 1].context;
	expect([
		order,
		c.query,
		c.command,
		c.count,
		c.database,
		typeof c.connection === "number" && c.port === pg_port && typeof c.host === "string",
		c.queued <= c.sent && c.sent <= c.firstByte && c.firstByte <= c.complete,
		c.parameters === undefined,
		x,
	]).toEqual([
		["start", "end", "asyncStart", "asyncEnd"],
		"select $1::int as x",
		"SELECT",
		1,
		sql.options.database,
		true,
		true,
		true,
		1,
	]);
	await sql.end();
});

test("Tracing: parameters are only in the context with debug", async () => {
	const sql = postgres({ ...options, debug: true, max: 1 });
	const { events, stop } = record("postgres:query");
	await sql`select ${"secret"}::text as x`;
	stop();
	expect(events[0].context.parameters).toEqual(["secret"]);
	await sql.end();
});

test("Tracing: a failing query publishes error with the error, then asyncStart and asyncEnd", async () => {
	const sql = postgres({ ...options, max: 1 });
	const { events, stop } = record("postgres:query");
	await sql`select wat`.catch(() => {});
	stop();
	expect([
		events.map((x) => x.event),
		events.find((x) => x.event === "error").context.error.code,
	]).toEqual([["start", "end", "error", "asyncStart", "asyncEnd"], "42703"]);
	await sql.end();
});

test("Tracing: start runs in the context of the code that made the query", async () => {
	const sql = postgres({ ...options, max: 1 }),
		store = new AsyncLocalStorage(),
		seen = [],
		start = (context) => seen.push(store.getStore() + ":" + context.query);
	dc.subscribe("tracing:postgres:query:start", start);
	await Promise.all([
		store.run("a", async () => await sql`select 1 as a`),
		store.run("b", async () => await sql`select 2 as b`),
	]);
	dc.unsubscribe("tracing:postgres:query:start", start);
	expect(seen.sort()).toEqual(["a:select 1 as a", "b:select 2 as b"]);
	await sql.end();
});

test("Tracing: a store bound to start is current while the query is dispatched", async () => {
	const sql = postgres({ ...options, max: 1 }),
		store = new AsyncLocalStorage(),
		channel = dc.tracingChannel<unknown, { queued: number }>("postgres:query"),
		seen = [],
		end = () => seen.push(store.getStore());
	channel.start.bindStore(store, (context) => "span for " + context.queued.toFixed(0).length);
	dc.subscribe("tracing:postgres:query:end", end);
	await sql`select 1`;
	channel.start.unbindStore(store);
	dc.unsubscribe("tracing:postgres:query:end", end);
	expect(seen.length === 1 && seen[0].startsWith("span for")).toBe(true);
	await sql.end();
});

test("Tracing: cursors and copy streams finish their trace", async () => {
	const sql = postgres({ ...options, max: 1 });
	const { events, stop } = record("postgres:query");
	for await (const [row] of sql`select generate_series(1, 3) as x`.cursor()) row;
	await sql`select generate_series(1, 3) as x`.cursor(2, () => {});
	const readable = await sql`copy (select 1) to stdout`.readable();
	for await (const x of readable) x;
	await delay(10);
	stop();
	const done = events.filter((x) => x.event === "asyncEnd").length,
		started = events.filter((x) => x.event === "start").length;
	expect(done === started && started === 3).toBe(true);
	await sql.end();
});

test("Tracing: connect publishes per attempt, with the backend pid or the error", async () => {
	const { events, stop } = record("postgres:connect");
	const sql = postgres({ ...options, max: 1 });
	await sql`select 1`;
	const bad = postgres({ ...options, port: 5434, max: 1, connect_timeout: 1 });
	await bad`select 1`.catch(() => {});
	stop();
	const ok = events.find((x) => x.event === "asyncEnd" && !x.context.error),
		failed = events.find((x) => x.event === "error");
	expect([
		typeof ok.context.result.pid,
		ok.context.port,
		failed.context.error.code,
		failed.context.port,
	]).toEqual(["number", pg_port, "ECONNREFUSED", 5434]);
	await sql.end();
	await bad.end();
});

test("Tracing: a transaction publishes its outcome", async () => {
	const sql = postgres({ ...options, max: 1 });
	const { events, stop } = record("postgres:transaction");
	await sql.begin((sql) => sql`select 1`);
	await sql
		.begin("read only", async (sql) => {
			await sql`select 1`;
			throw new Error("no");
		})
		.catch(() => {});
	stop();
	const done = events.filter((x) => x.event === "asyncEnd").map((x) => x.context);
	expect([
		done.map((x) => x.outcome),
		done[1].mode,
		done[1].error.message,
		typeof done[0].connection === "number",
	]).toEqual([["commit", "rollback"], "read only", "no", true]);
	await sql.end();
});

test("Tracing: the pool publishes open, lease, release, idle and close", async () => {
	const { messages, stop } = listen("postgres:pool");
	const sql = postgres({ ...options, max: 1 });
	await sql`select 1`;
	const reserved = await sql.reserve();
	reserved.release();
	await sql.end();
	stop();
	const kinds = [...new Set(messages.map((x) => x.event))];
	expect([
		["open", "idle", "lease", "release", "close"].filter((x) => kinds.includes(x)),
		messages.filter((x) => typeof x.stats.connections !== "number"),
	]).toEqual([["open", "idle", "lease", "release", "close"], []]);
});

test("Tracing: notices are published with their connection", async () => {
	const { messages, stop } = listen("postgres:notice");
	const sql = postgres({ ...options, max: 1, onnotice: false });
	await sql`do $$ begin raise notice 'hello'; end $$`;
	stop();
	expect([messages[0].notice.message, typeof messages[0].connection === "number"]).toEqual([
		"hello",
		true,
	]);
	await sql.end();
});

test("Tracing: without subscribers a query carries no trace", async () => {
	const sql = postgres({ ...options, max: 1 });
	const q = sql`select 1`;
	await q;
	expect(q.trace).toBe(null);
	await sql.end();
});
