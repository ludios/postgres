import dc from "diagnostics_channel";
import net from "net";
import { AsyncLocalStorage } from "async_hooks";
import { expect, onTestFinished, test, vi } from "vitest";
import { postgres, options, delay, pg_port, until_sleeping, proxy_to_server } from "./setup.ts";

function record(name: string) {
	const events: { event: string; context: any; snapshot: any }[] = [],
		channel = dc.tracingChannel(name),
		recorder = (event: string) => (context: any) =>
			events.push({ event, context, snapshot: { ...context } }),
		handlers = {
			start: recorder("start"),
			end: recorder("end"),
			asyncStart: recorder("asyncStart"),
			asyncEnd: recorder("asyncEnd"),
			error: recorder("error"),
		};
	channel.subscribe(handlers);
	const stop = () => {
		channel.unsubscribe(handlers);
	};
	// Unsubscribes also when the test throws before its stop()
	onTestFinished(stop);
	return { events, stop };
}

function listen(name: string) {
	const messages: any[] = [],
		fn = (message: unknown) => messages.push(message);
	dc.subscribe(name, fn);
	const stop = () => {
		dc.unsubscribe(name, fn);
	};
	// Unsubscribes also when the test throws before its stop()
	onTestFinished(stop);
	return { messages, stop };
}

test("Tracing: a query publishes start, end, asyncStart and asyncEnd with what it ran", async () => {
	await using sql = postgres({ ...options, max: 1 });
	await sql`select 1`;
	const { events, stop } = record("postgres:query");
	const [{ x }] = await sql`select ${1}::int as x`;
	stop();
	const order = events.map((e) => e.event),
		c = events[events.length - 1].context;
	expect([
		order,
		c.query,
		c.command,
		c.count,
		c.database,
		c.connection,
		c.port,
		c.host,
		[c.queued, c.sent, c.firstByte, c.complete],
		c.parameters,
		x,
	]).toEqual([
		["start", "end", "asyncStart", "asyncEnd"],
		"select $1::int as x",
		"SELECT",
		1,
		sql.options.database,
		expect.any(Number),
		pg_port,
		expect.any(String),
		expect.toSatisfy(
			(t) => t[0] <= t[1] && t[1] <= t[2] && t[2] <= t[3],
			"queued <= sent <= firstByte <= complete",
		),
		undefined,
		1,
	]);
});

test("Tracing: parameters are only in the context with debug", async () => {
	await using sql = postgres({ ...options, debug: true, max: 1 });
	const { events, stop } = record("postgres:query");
	await sql`select ${"secret"}::text as x`;
	stop();
	expect(events[0].context.parameters).toEqual(["secret"]);
});

test("Tracing: a failing query publishes error with the error, then asyncStart and asyncEnd", async () => {
	await using sql = postgres({ ...options, max: 1 });
	const { events, stop } = record("postgres:query");
	await sql`select wat`.catch(() => {});
	stop();
	expect([
		events.map((x) => x.event),
		events.find((x) => x.event === "error").context.error.code,
	]).toEqual([["start", "end", "error", "asyncStart", "asyncEnd"], "42703"]);
});

test("Tracing: start runs in the context of the code that made the query", async () => {
	await using sql = postgres({ ...options, max: 1 });
	const store = new AsyncLocalStorage<string>(),
		seen: string[] = [],
		start = (context: any) => seen.push(store.getStore() + ":" + context.query);
	dc.subscribe("tracing:postgres:query:start", start);
	onTestFinished(() => {
		dc.unsubscribe("tracing:postgres:query:start", start);
	});
	await Promise.all([
		store.run("a", async () => await sql`select 1 as a`),
		store.run("b", async () => await sql`select 2 as b`),
	]);
	expect(seen.toSorted()).toEqual(["a:select 1 as a", "b:select 2 as b"]);
});

test("Tracing: a store bound to start is current while the query is dispatched", async () => {
	await using sql = postgres({ ...options, max: 1 });
	const store = new AsyncLocalStorage(),
		channel = dc.tracingChannel<unknown, { query: string }>("postgres:query"),
		seen: unknown[] = [],
		end = () => seen.push(store.getStore());
	channel.start.bindStore(store, (context) => "span for " + context.query);
	dc.subscribe("tracing:postgres:query:end", end);
	onTestFinished(() => {
		channel.start.unbindStore(store);
		dc.unsubscribe("tracing:postgres:query:end", end);
	});
	await sql`select 1`;
	expect(seen).toEqual(["span for select 1"]);
});

test("Tracing: cursors and copy streams finish their trace", async () => {
	await using sql = postgres({ ...options, max: 1 });
	const { events, stop } = record("postgres:query");
	for await (const _ of sql`select generate_series(1, 3) as x`.cursor()) {
		// Only the trace matters
	}
	await sql`select generate_series(1, 3) as x`.cursor(2, () => {});
	const readable = await sql`copy (select 1) to stdout`.readable();
	for await (const _ of readable) {
		// Only the trace matters
	}
	await delay(10);
	stop();
	const done = events.filter((x) => x.event === "asyncEnd").length,
		started = events.filter((x) => x.event === "start").length;
	expect([done, started]).toEqual([3, 3]);
});

test("Tracing: an empty query of the simple protocol is traced, with its empty text", async () => {
	await using sql = postgres({ ...options, max: 1 });
	const { events, stop } = record("postgres:query");
	await sql.unsafe("");
	stop();
	expect(events.filter((x) => x.event === "asyncEnd").map((x) => x.context.query)).toEqual([""]);
});

test("Tracing: connect publishes per attempt, with the backend pid or the error", async () => {
	const { events, stop } = record("postgres:connect");
	await using sql = postgres({ ...options, max: 1 });
	await sql`select 1`;
	await using bad = postgres({ ...options, port: 5434, max: 1, connect_timeout: 1 });
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
});

test("Tracing: a transaction publishes its outcome", async () => {
	await using sql = postgres({ ...options, max: 1 });
	const { events, stop } = record("postgres:transaction");
	await sql.begin((tx) => tx`select 1`);
	await sql
		.begin("read only", async (tx) => {
			await tx`select 1`;
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
});

test("Tracing: the pool publishes open, lease, release, idle and close", async () => {
	const { messages, stop } = listen("postgres:pool");
	await using sql = postgres({ ...options, max: 1 });
	await sql`select 1`;
	const reserved = await sql.reserve();
	reserved.release();
	await sql.end();
	stop();
	const kinds = new Set(messages.map((x) => x.event));
	expect([
		["open", "idle", "lease", "release", "close"].filter((x) => kinds.has(x)),
		messages.filter((x) => typeof x.stats?.connections !== "number"),
	]).toEqual([["open", "idle", "lease", "release", "close"], []]);
});

test("Tracing: the pool publishes idle only for a connection with nothing in flight and no lease", async () => {
	const { messages, stop } = listen("postgres:pool");
	await using sql = postgres({ ...options, max: 1 });
	await sql`select 1`;
	const before_pipelining = messages.length;
	// Both queries are in flight on the one connection, so the first to finish leaves it busy
	await Promise.all([sql`select 1`, sql`select 2`]);
	const pipelining = messages.slice(before_pipelining).map((x) => x.event);
	// The first release hands the connection straight to the second lease
	const before_reserving = messages.length,
		reserves = [sql.reserve(), sql.reserve()];
	for (const reserve of reserves) {
		using reserved = await reserve;
		await reserved`select 1`;
	}
	const reserving = messages.slice(before_reserving).map((x) => x.event);
	await sql.end();
	stop();
	const kinds = messages.map((x) => x.event);
	expect([
		kinds.indexOf("open") < kinds.indexOf("idle"),
		pipelining,
		reserving.filter((x) => x !== "wait"),
		messages.filter((x) => x.event === "idle" && x.stats.idle !== 1).length,
	]).toEqual([true, ["idle"], ["lease", "release", "lease", "release", "idle"], 0]);
});

test("Tracing: the pool publishes no idle for a connection that is closing", async () => {
	const { messages, stop } = listen("postgres:pool");
	const sql = postgres({ ...options, max: 1 });
	await sql`select 1`;
	const slow = sql`select pg_sleep(0.05)`.execute();
	// execute() sends the query in a microtask, so wait for one: close() must find it in flight
	await Promise.resolve();
	const before_close = messages.length,
		closed = sql.close();
	await slow;
	await closed;
	stop();
	expect(messages.slice(before_close).map((x) => x.event)).toEqual(["close"]);
});

test("Tracing: the pool publishes idle for a cancelled query's connection once its cancel request has been handled", async () => {
	// The proxy passes the server's close of the cancel request's connection on to the client only
	// when the test says so, so that the cancelled query's ReadyForQuery is sure to arrive first
	const releasable = Promise.withResolvers<() => void>();
	await using proxy = await proxy_to_server({
		server_closed: (c) => {
			// A CancelRequest has the code 80877102 after its length, where a StartupMessage has
			// the protocol version
			if (c.first?.readInt32BE(4) !== 80877102) {
				return false;
			}
			releasable.resolve(() => c.client.destroy());
			return true;
		},
	});
	const { messages, stop } = listen("postgres:pool");
	// connect_timeout bounds the cancel request too, which the proxy keeps in flight until the
	// test releases it, so the 1 second of `options` could run out on a slow machine
	await using sql = postgres({
		...options,
		host: proxy.host,
		port: proxy.port,
		max: 1,
		connect_timeout: 10,
	});
	const [{ pid }] = await sql`select pg_backend_pid() as pid`;
	const query = sql`select pg_sleep(2)`.execute(),
		failed = query.catch((x) => x.code);
	await until_sleeping(pid);
	const idles = () => messages.filter((x) => x.event === "idle").length,
		before = idles(),
		cancelled = query.cancel(),
		code = await failed;
	// The query has failed, but the client has not seen the cancel request's connection close yet
	const while_held = idles() - before;
	(await releasable.promise)();
	await cancelled;
	stop();
	expect([code, while_held, idles() - before]).toEqual(["57014", 0, 1]);
});

test("Tracing: the pool's close event has an error only if the connection did not close in an orderly way", async () => {
	const { messages, stop } = listen("postgres:pool");
	const closed_ids: number[] = [];
	let raw!: net.Socket;
	await using sql = postgres({
		...options,
		max: 1,
		onclose: (id) => closed_ids.push(id),
		socket: () => (raw = net.connect(pg_port, "localhost")),
	});
	await sql`select 1`;
	await sql.close();
	await sql`select 1`;
	raw.destroy();
	await vi.waitUntil(() => closed_ids.length === 2);
	await sql.end();
	stop();
	expect(
		messages
			.filter((x) => x.event === "close" && closed_ids.includes(x.connection))
			.map((x) => x.error && x.error.code),
	).toEqual([undefined, "CONNECTION_CLOSED"]);
});

test("Tracing: notices are published with their connection", async () => {
	const { messages, stop } = listen("postgres:notice");
	await using sql = postgres({ ...options, max: 1, onnotice: false });
	await sql`do $$ begin raise notice 'hello'; end $$`;
	stop();
	expect([messages[0].notice.message, typeof messages[0].connection === "number"]).toEqual([
		"hello",
		true,
	]);
});

test("Tracing: without subscribers a query carries no trace", async () => {
	await using sql = postgres({ ...options, max: 1 });
	const q = sql`select 1`;
	await q;
	expect((q as any).trace).toBe(null);
});
