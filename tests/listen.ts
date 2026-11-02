// @ts-nocheck
import { expect, test } from "vitest";
import { postgres, options, delay, pg_socket_dir } from "./setup.ts";

const until = async (fn, ms = 5000) => {
	const end = Date.now() + ms;
	while (!(await fn())) {
		if (Date.now() > end) throw new Error("Timed out waiting");
		await delay(10);
	}
};

test("listen and notify", async () => {
	const sql = postgres(options);
	const channel = "hello";
	const result = await new Promise(async (r) => {
		await sql.listen(channel, r);
		sql.notify(channel, "works");
	});

	expect(result).toBe("works");
	await sql.end();
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

	sql.listen("weee", () => {}).then(sql.end);

	expect(count).toBe(2);
});

test("multiple listeners work after a reconnect", async () => {
	const sql = postgres(options),
		xs = [];

	let listens = 0;
	try {
		const s1 = await sql.listen(
			"test",
			(x) => xs.push("1", x),
			() => listens++,
		);
		await sql.listen("test", (x) => xs.push("2", x));
		await sql.notify("test", "a");
		await until(() => xs.length === 4);
		await sql`select pg_terminate_backend(${s1.state.pid})`;
		await until(() => listens === 2);
		await sql.notify("test", "b");
		await until(() => xs.length === 8);
		expect(xs.join("")).toBe("1a2a1b2b");
		return;
	} finally {
		await sql.end();
	}
});

test("listen and notify with weird name", async () => {
	const sql = postgres(options);
	const channel = "wat-;.ø.§";
	let unlisten;
	const result = await new Promise(async (r) => {
		unlisten = (await sql.listen(channel, r)).unlisten;
		sql.notify(channel, "works");
	});
	await unlisten();

	expect(result).toBe("works");
	await sql.end();
});

test("listen and notify with upper case", async () => {
	const sql = postgres(options);
	const channel = "withUpperChar";
	const result = await new Promise(async (r) => {
		await sql.listen(channel, r);
		sql.notify(channel, "works");
	});

	expect(result).toBe("works");
	await sql.end();
});

test("listen reconnects", async () => {
	const sql = postgres(options),
		resolvers = {},
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
	sql.end();
	expect(connects).toBe(2);
});

test("listen keeps retrying when a reconnect attempt fails", { timeout: 20_000 }, async () => {
	const admin = postgres({ ...options, user: "postgres", pass: "", max: 1 });
	await admin`drop role if exists postgres_js_test_listen`;
	await admin`create role postgres_js_test_listen login`;
	const sql = postgres({
			...options,
			host: pg_socket_dir,
			user: "postgres_js_test_listen",
			pass: "",
			backoff: () => 0.1,
		}),
		xs = [];

	let listens = 0;
	try {
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
		expect(listens + " " + xs[0]).toBe("2 a");
		return;
	} finally {
		await sql.end();
		await admin`drop role postgres_js_test_listen`;
		await admin.end();
	}
});

test("listen result reports correct connection state after reconnection", async () => {
	const sql = postgres(options),
		xs = [];

	const result = await sql.listen("test", (x) => xs.push(x));
	const initialPid = result.state.pid;
	await sql.notify("test", "a");
	await sql`select pg_terminate_backend(${initialPid})`;
	await until(() => result.state.pid && result.state.pid !== initialPid);
	sql.end();

	expect(result.state.pid !== initialPid).toBe(true);
});

test("unlisten removes subscription", async () => {
	const sql = postgres(options),
		xs = [];

	const { unlisten } = await sql.listen("test", (x) => xs.push(x));
	await sql.notify("test", "a");
	await until(() => xs.length === 1);
	await unlisten();
	await sql.notify("test", "b");
	await delay(50);
	sql.end();

	expect(xs.join("")).toBe("a");
});

test("listen after unlisten", async () => {
	const sql = postgres(options),
		xs = [];

	const { unlisten } = await sql.listen("test", (x) => xs.push(x));
	await sql.notify("test", "a");
	await until(() => xs.length === 1);
	await unlisten();
	await sql.notify("test", "b");
	await delay(50);
	await sql.listen("test", (x) => xs.push(x));
	await sql.notify("test", "c");
	await until(() => xs.length === 2);
	sql.end();

	expect(xs.join("")).toBe("ac");
});

test("multiple listeners and unlisten one", async () => {
	const sql = postgres(options),
		xs = [];

	await sql.listen("test", (x) => xs.push("1", x));
	const s2 = await sql.listen("test", (x) => xs.push("2", x));
	await sql.notify("test", "a");
	await until(() => xs.length === 4);
	await s2.unlisten();
	await sql.notify("test", "b");
	await until(() => xs.length === 6);
	await delay(50);
	sql.end();

	expect(xs.join("")).toBe("1a2a1b");
});

test("Listen connection closes after the last unlisten", async () => {
	const sql = postgres(options);
	const {
		state: { pid },
		unlisten,
	} = await sql.listen("test", () => {});
	await unlisten();
	const gone = async () =>
		(await sql`select count(*)::int as n from pg_stat_activity where pid = ${pid}`)[0].n === 0;
	await until(gone);
	expect(await gone()).toBe(true);
	await sql.end();
});

test("Original listen handles unsubscribe after a reconnect", async () => {
	const sql = postgres(options),
		xs = [],
		arrivals = {},
		a = new Promise((r) => (arrivals.a = r)),
		b = new Promise((r) => (arrivals.b = r)),
		c = new Promise((r) => (arrivals.c = r));
	let registrations = 0,
		reconnect;

	const reconnected = new Promise((r) => (reconnect = r));

	try {
		const s1 = await sql.listen(
			"test",
			(x) => xs.push("1", x),
			() => ++registrations === 2 && reconnect(),
		);
		const s2 = await sql.listen("test", (x) => (xs.push("2", x), arrivals[x]()));
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
		expect(xs.join("") + ":" + available + ":" + retained).toBe("1a2a1b2b2c:1:0");
		return;
	} finally {
		await sql.end();
	}
});

test("Unlisten while reconnecting keeps only the other listener", async () => {
	const sql = postgres(options),
		callbacks = [];
	let released,
		received,
		first = 0,
		second = 0;

	const unlistened = new Promise((r) => (released = r)),
		arrived = new Promise((r) => (received = r));

	try {
		await sql.listen(
			"test",
			() => (callbacks.push("first"), received()),
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
		expect(callbacks.join(",") + ":" + second).toBe("first:1");
		return;
	} finally {
		await sql.end();
	}
});

test("A listener that throws keeps its connection and gets the next notification", async () => {
	const sql = postgres(options);
	const got = [];
	let onlisten = 0;
	await sql.listen(
		"throwing",
		(x) => {
			got.push(x);
			if (x === "throw") throw new Error("listener throws");
		},
		() => onlisten++,
	);
	await sql.notify("throwing", "throw");
	await until(() => got.length === 1);
	await sql.notify("throwing", "after");
	await until(() => got.length === 2);
	expect(onlisten + " " + got.join()).toBe("1 throw,after");
	await sql.end();
});

test("unlisten after end resolves without a query", async () => {
	const sql = postgres(options);
	const { unlisten } = await sql.listen("after_end", () => {});
	await sql.end();
	expect(await unlisten().then(() => "done")).toBe("done");
});
