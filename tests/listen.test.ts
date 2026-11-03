import { expect, test } from "vitest";
import {
	postgres,
	options,
	delay,
	until,
	defer,
	pg_socket_dir,
	terminate,
	proxy_to_server,
	type Proxied,
} from "./setup.ts";

/**
 * @param chunk - a chunk that a client sent
 * @returns whether the chunk carries the LISTEN statement of the tests below, not their UNLISTEN
 */
function sends_listen(chunk: Buffer) {
	return chunk.includes('listen "test"') && !chunk.includes('unlisten "test"');
}

/**
 * @param numbers - which connections through the proxy to drop: 2 for the second one that a client
 *   makes
 * @param dropped - called each time the hook drops a connection
 * @returns a `from_client` hook for proxy_to_server() that drops each of those connections as soon
 *   as the client sends a LISTEN on it
 */
function dropping_listens(numbers: number[], dropped: () => void) {
	return (x: Buffer, c: Proxied) => {
		if (numbers.includes(c.number) && sends_listen(x)) {
			dropped();
			c.server.destroy();
			c.client.destroy();
			return true;
		}
		return false;
	};
}

/**
 * @returns `timers`, to give as `options.timers`, and `pending`, the set of the timers that were
 *   set through `timers`, have neither been cleared nor run yet, and keep the process alive: a
 *   timer that is unref()ed (the pool's watchdog) leaves the set, as it is no pending work
 */
function tracked_timers() {
	const pending = new Set<NodeJS.Timeout>(),
		timers = {
			setTimeout(fn: (...args: any[]) => void, ms: number, ...args: unknown[]) {
				const timer = setTimeout(() => {
					pending.delete(timer);
					fn(...args);
				}, ms);
				pending.add(timer);
				const unref = timer.unref.bind(timer);
				timer.unref = () => {
					pending.delete(timer);
					return unref();
				};
				return timer;
			},
			clearTimeout(timer: NodeJS.Timeout) {
				pending.delete(timer);
				clearTimeout(timer);
			},
			setImmediate,
			clearImmediate,
			now: () => performance.now(),
		};
	return { pending, timers };
}

test.each(["hello", "wat-;.ø.§", "withUpperChar"])(
	"listen and notify on the channel %s",
	async (channel) => {
		await using sql = postgres(options);
		const { promise, resolve } = Promise.withResolvers();
		const { unlisten } = await sql.listen(channel, resolve);
		await sql.notify(channel, "works");
		const result = await promise;
		await unlisten();

		expect(result).toBe("works");
	},
);

test("listen and notify with a custom type given by name", async () => {
	await using sql = postgres({
		...options,
		types: { int: { to: "int4", from: ["int4"], serialize: String, parse: Number } },
	});
	const { promise, resolve } = Promise.withResolvers();
	await sql.listen("named", resolve);
	await sql.notify("named", "works");
	expect(await promise).toBe("works");
});

test("double listen", async () => {
	const sql = postgres(options),
		channel = "hello";

	let count = 0;

	await new Promise((resolve, reject) =>
		sql
			.listen(channel, resolve)
			.then(() => sql.notify(channel, "world"))
			.catch(reject),
	).then(() => count++);

	await new Promise((resolve, reject) =>
		sql
			.listen(channel, resolve)
			.then(() => sql.notify(channel, "world"))
			.catch(reject),
	).then(() => count++);

	void sql.listen("weee", () => {}).then(() => sql.end());

	expect(count).toBe(2);
});

test("multiple listeners work after a reconnect", async () => {
	await using sql = postgres(options);
	const xs: string[] = [];

	let listens = 0;
	const s1 = await sql.listen(
		"test",
		(x) => xs.push("1" + x),
		() => listens++,
	);
	await sql.listen("test", (x) => xs.push("2" + x));
	await sql.notify("test", "a");
	await until(() => xs.length === 2);
	await sql`select pg_terminate_backend(${s1.state.pid})`;
	await until(() => listens === 2);
	await sql.notify("test", "b");
	await until(() => xs.length === 4);
	expect(xs).toEqual(["1a", "2a", "1b", "2b"]);
});

test("listen reconnects", async () => {
	await using sql = postgres(options);
	const resolvers: Record<string, (value?: unknown) => void> = {},
		a = new Promise((r) => (resolvers.a = r)),
		b = new Promise((r) => (resolvers.b = r));

	let connects = 0;

	const {
		state: { pid },
	} = await sql.listen(
		"test",
		(x) => x in resolvers && resolvers[x](),
		() => connects++,
	);
	await sql.notify("test", "a");
	await a;
	await sql`select pg_terminate_backend(${pid})`;
	await until(() => connects === 2);
	await sql.notify("test", "b");
	await b;
	expect(connects).toBe(2);
});

test("listen keeps retrying when a reconnect attempt fails", async () => {
	await using admin = postgres({ ...options, user: "postgres", pass: "", max: 1 });
	await admin`drop role if exists postgres_js_test_listen`;
	await admin`create role postgres_js_test_listen login`;
	await using _drop_role = defer(() => admin`drop role postgres_js_test_listen`);
	await using sql = postgres({
		...options,
		host: pg_socket_dir,
		user: "postgres_js_test_listen",
		pass: "",
		backoff: () => 0.1,
	});
	const xs: string[] = [];

	let listens = 0;
	await sql.listen(
		"test",
		(x) => xs.push(x),
		() => listens++,
	);
	await admin`alter role postgres_js_test_listen nologin`;
	await admin`select pg_terminate_backend(pid) from pg_stat_activity where usename = 'postgres_js_test_listen'`;
	await delay(500);
	await admin`alter role postgres_js_test_listen login`;
	await until(() => listens === 2);
	await admin.notify("test", "a");
	await until(() => xs.length === 1);
	expect([listens, xs[0]]).toEqual([2, "a"]);
}, 20_000);

test("listen result reports correct connection state after reconnection", async () => {
	await using sql = postgres(options);
	const xs: string[] = [];

	const result = await sql.listen("test", (x) => xs.push(x));
	const initial_pid = result.state.pid;
	await sql.notify("test", "a");
	await sql`select pg_terminate_backend(${initial_pid})`;
	await until(() => result.state.pid && result.state.pid !== initial_pid);

	expect(result.state.pid !== initial_pid).toBe(true);
});

test("unlisten removes subscription", async () => {
	await using sql = postgres(options);
	const xs: string[] = [];

	const { unlisten } = await sql.listen("test", (x) => xs.push(x));
	await sql.notify("test", "a");
	await until(() => xs.length === 1);
	await unlisten();
	await sql.notify("test", "b");
	await delay(50);

	expect(xs).toEqual(["a"]);
});

test("listen after unlisten", async () => {
	await using sql = postgres(options);
	const xs: string[] = [];

	const { unlisten } = await sql.listen("test", (x) => xs.push(x));
	await sql.notify("test", "a");
	await until(() => xs.length === 1);
	await unlisten();
	await sql.notify("test", "b");
	await delay(50);
	await sql.listen("test", (x) => xs.push(x));
	await sql.notify("test", "c");
	await until(() => xs.length === 2);

	expect(xs).toEqual(["a", "c"]);
});

test("multiple listeners and unlisten one", async () => {
	await using sql = postgres(options);
	const xs: string[] = [];

	await sql.listen("test", (x) => xs.push("1" + x));
	const s2 = await sql.listen("test", (x) => xs.push("2" + x));
	await sql.notify("test", "a");
	await until(() => xs.length === 2);
	await s2.unlisten();
	await sql.notify("test", "b");
	await until(() => xs.length === 3);
	await delay(50);

	expect(xs).toEqual(["1a", "2a", "1b"]);
});

test("Listen connection closes after the last unlisten", async () => {
	await using sql = postgres(options);
	const {
		state: { pid },
		unlisten,
	} = await sql.listen("test", () => {});
	await unlisten();
	const gone = async () =>
		(await sql`select count(*)::int as n from pg_stat_activity where pid = ${pid}`)[0].n === 0;
	await until(gone);
	expect(await gone()).toBe(true);
});

test("Original listen handles unsubscribe after a reconnect", async () => {
	await using sql = postgres(options);
	const xs: string[] = [],
		arrivals: Record<string, (value?: unknown) => void> = {},
		a = new Promise((r) => (arrivals.a = r)),
		b = new Promise((r) => (arrivals.b = r)),
		c = new Promise((r) => (arrivals.c = r));
	let registrations = 0;
	const { promise: reconnected, resolve: reconnect } = Promise.withResolvers<void>();

	const s1 = await sql.listen(
		"test",
		(x) => xs.push("1" + x),
		() => ++registrations === 2 && reconnect(),
	);
	const s2 = await sql.listen("test", (x) => {
		xs.push("2" + x);
		arrivals[x]();
	});
	await sql.notify("test", "a");
	await a;
	await sql`select pg_terminate_backend(${s1.state.pid})`;
	await reconnected;
	await sql.notify("test", "b");
	await b;
	await s1.unlisten();
	await sql.notify("test", "c");
	await c;
	await s2.unlisten();
	const [{ available }] = await sql`select 1 as available`;
	const [{ retained }] = await sql`
      select count(*)::int as retained from pg_stat_activity
      where pid = ${s2.state.pid} and query ilike 'listen %'
    `;
	expect([xs, available, retained]).toEqual([["1a", "2a", "1b", "2b", "2c"], 1, 0]);
});

test("Unlisten while reconnecting keeps only the other listener", async () => {
	await using sql = postgres(options);
	const callbacks: string[] = [];
	let first = 0,
		second = 0;

	const { promise: unlistened, resolve: released } = Promise.withResolvers<void>(),
		{ promise: arrived, resolve: received } = Promise.withResolvers<void>();

	await sql.listen(
		"test",
		() => {
			callbacks.push("first");
			return received();
		},
		() => ++first === 2 && b.unlisten().then(released),
	);
	const b = await sql.listen(
		"test",
		() => callbacks.push("second"),
		() => second++,
	);
	await sql`select pg_terminate_backend(${b.state.pid})`;
	await unlistened;
	await sql.notify("test", "after");
	await arrived;
	expect([callbacks, second]).toEqual([["first"], 1]);
});

test("A listener that throws keeps its connection and gets the next notification", async () => {
	await using sql = postgres(options);
	const got: string[] = [];
	let onlisten = 0;
	await sql.listen(
		"throwing",
		(x) => {
			got.push(x);
			if (x === "throw") {
				throw new Error("listener throws");
			}
		},
		() => onlisten++,
	);
	await sql.notify("throwing", "throw");
	await until(() => got.length === 1);
	await sql.notify("throwing", "after");
	await until(() => got.length === 2);
	expect([onlisten, got]).toEqual([1, ["throw", "after"]]);
});

test("A listen() whose onlisten throws rejects and leaves no listener behind", async () => {
	await using sql = postgres(options);
	const kept: string[] = [],
		removed: string[] = [];
	await sql.listen("onlisten_throws", (x) => kept.push(x));
	const error = await sql
		.listen(
			"onlisten_throws",
			(x) => removed.push(x),
			() => {
				throw new Error("onlisten throws");
			},
		)
		.catch((e) => e.message);
	await sql.notify("onlisten_throws", "a");
	await until(() => kept.length === 1);
	expect([error, kept, removed]).toEqual(["onlisten throws", ["a"], []]);
});

test("unlisten after end resolves without a query", async () => {
	const sql = postgres(options);
	const { unlisten } = await sql.listen("after_end", () => {});
	await sql.end();
	expect(await unlisten().then(() => "done")).toBe("done");
});

test("listen after end rejects with CONNECTION_ENDED, with or without a listener connection", async () => {
	const unused = postgres(options),
		used = postgres(options);
	await used.listen("test", () => {});
	await Promise.all([unused.end(), used.end()]);
	const codes = await Promise.all(
		[unused, used].map((sql) =>
			sql
				.listen("test", () => {})
				.then(
					() => "ok",
					(e) => e.code,
				),
		),
	);
	expect(codes).toEqual(["CONNECTION_ENDED", "CONNECTION_ENDED"]);
});

test("A close while a LISTEN is in flight starts no second retry chain", async () => {
	// The proxy drops its second connection as soon as the client sends a LISTEN on it
	let dropped = false;
	await using proxy = await proxy_to_server({
		from_client: dropping_listens([2], () => (dropped = true)),
	});
	await using sql = postgres({
		...options,
		host: proxy.host,
		port: proxy.port,
		backoff: () => 0.1,
	});
	const xs: string[] = [];
	let listens = 0;
	const { state } = await sql.listen(
		"test",
		(x) => xs.push(x),
		() => listens++,
	);
	await terminate(state.pid);
	await until(() => listens === 2);
	// Time for a retry chain that the drop left behind to send its LISTEN, and call onlisten again
	await delay(300);
	await sql.notify("test", "a");
	await until(() => xs.length === 1);
	expect([dropped, listens, xs]).toEqual([true, 2, ["a"]]);
});

test("A listener that joins while a reconnect's LISTEN is in flight gets onlisten once", async () => {
	// The proxy holds back the LISTEN on its second connection until the test releases it
	let release!: () => void;
	const { promise: held, resolve: on_hold } = Promise.withResolvers<void>();
	await using proxy = await proxy_to_server({
		from_client: (x, c) => {
			if (c.number === 2 && sends_listen(x)) {
				release = () => c.server.write(x);
				on_hold();
				return true;
			}
			return false;
		},
	});
	await using sql = postgres({ ...options, host: proxy.host, port: proxy.port });
	let first = 0,
		second = 0;
	const { state } = await sql.listen(
		"test",
		() => {},
		() => first++,
	);
	await terminate(state.pid);
	await held;
	const joining = sql.listen(
		"test",
		() => {},
		() => second++,
	);
	release();
	await joining;
	await until(() => first === 2);
	expect([first, second]).toEqual([2, 1]);
});

test("The last unlisten during an outage clears the retry timer and sends no UNLISTEN", async () => {
	const { pending, timers } = tracked_timers();
	// The proxy drops its second connection as soon as the client sends a LISTEN on it
	let dropped = false;
	await using proxy = await proxy_to_server({
		from_client: dropping_listens([2], () => (dropped = true)),
	});
	await using sql = postgres({
		...options,
		host: proxy.host,
		port: proxy.port,
		backoff: () => 10,
		timers,
	} as any);
	const { state, unlisten } = await sql.listen("test", () => {});
	await terminate(state.pid);
	// The dropped LISTEN fails, and the channel waits 10 seconds to send it again
	await until(() => dropped && pending.size === 1);
	await unlisten();
	await sql.end();
	// No third connection: the LISTEN failed, so there was nothing to UNLISTEN
	expect([pending.size, proxy.connections.length]).toEqual([0, 2]);
});

test("A listen() that joins a channel that waits to retry its LISTEN sends the LISTEN at once", async () => {
	const { pending, timers } = tracked_timers();
	// The proxy drops its second connection as soon as the client sends a LISTEN on it
	let dropped = false;
	await using proxy = await proxy_to_server({
		from_client: dropping_listens([2], () => (dropped = true)),
	});
	await using sql = postgres({
		...options,
		host: proxy.host,
		port: proxy.port,
		backoff: () => 10,
		timers,
	} as any);
	let first = 0,
		second = 0;
	const { state } = await sql.listen(
		"test",
		() => {},
		() => first++,
	);
	await terminate(state.pid);
	// The dropped LISTEN fails, and the channel waits 10 seconds to send it again
	await until(() => dropped && pending.size === 1);
	await sql.listen(
		"test",
		() => {},
		() => second++,
	);
	expect([first, second, pending.size]).toEqual([2, 1, 0]);
});

test("A failed LISTEN of a listen() that joins a retrying channel counts as one more retry", async () => {
	const { pending, timers } = tracked_timers(),
		// The numbers of failed LISTENs that `sql` gives `backoff`
		counts: number[] = [];
	// The proxy drops its second and third connections as soon as the client sends a LISTEN on them
	let dropped = 0;
	await using proxy = await proxy_to_server({
		from_client: dropping_listens([2, 3], () => dropped++),
	});
	await using sql = postgres({
		...options,
		host: proxy.host,
		port: proxy.port,
		backoff: (retries: number) => {
			counts.push(retries);
			return 10;
		},
		timers,
	} as any);
	const { state } = await sql.listen("test", () => {});
	await terminate(state.pid);
	await until(() => dropped === 1 && pending.size === 1);
	const error = await sql.listen("test", () => {}).catch((e) => e.code);
	expect([dropped, error, counts, pending.size]).toEqual([2, "CONNECTION_CLOSED", [1, 2], 1]);
});
