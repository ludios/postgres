import { spawnSync } from "child_process";
import path from "path";
import { delay, postgres } from "./common.ts";

const here = path.dirname(new URL(import.meta.url).pathname),
	dir = (process.env.PGTEST_DIR || path.join(here, ".pgdata")) + "/failover",
	find = "command -v pg_ctl || ls -d /usr/lib/postgresql/*/bin/pg_ctl | sort -V | tail -n 1",
	bin = process.env.PG_BIN || path.dirname(spawnSync("sh", ["-c", find]).stdout.toString().trim()),
	url = "postgres://postgres@localhost:5434,localhost:5435/postgres",
	until = async (fn: () => unknown, ms = 100) => {
		while (!fn()) {
			await delay(ms);
		}
	},
	ctl = (...args: string[]) => spawnSync(path.join(bin, "pg_ctl"), args, { encoding: "utf8" }),
	failures: string[] = [],
	expected = new Set([
		"CONNECTION_CLOSED",
		"CONNECTION_DESTROYED",
		"CONNECT_TIMEOUT",
		"ECONNREFUSED",
		"ECONNRESET",
		"57P01",
		"57P02",
		"57P03",
	]);

const setup = spawnSync("sh", [path.join(here, "failover.sh")], {
	encoding: "utf8",
	stdio: ["ignore", "pipe", "inherit"],
});
if (setup.status !== 0) {
	throw new Error("could not set up the primary and standby");
}

const writer = postgres(url, {
		target_session_attrs: "primary",
		max: 4,
		connect_timeout: 2,
		idle_timeout: 1,
		onnotice: false,
	}),
	reader = postgres(url, {
		target_session_attrs: "prefer-standby",
		max: 2,
		connect_timeout: 2,
		idle_timeout: 1,
		onnotice: false,
	});

await writer`create table failover (id int primary key, port int)`;
await delay(500);

const [{ standby }] = await reader`select pg_is_in_recovery() as standby`;
if (!standby) {
	failures.push("prefer-standby did not connect to the standby");
}

const state = { running: true };
let id = 0,
	written = 0,
	last_port: number | null = null,
	failed_at: number | null = null,
	resumed_at: number | null = null;
const errors: Record<string, number> = {};

async function write() {
	while (state.running) {
		const x = ++id;
		try {
			const [{ port }] =
				await writer`insert into failover values (${x}, inet_server_port()) returning port`;
			written++;
			last_port = port;
			if (failed_at && !resumed_at && port === 5435) {
				resumed_at = Date.now();
			}
		} catch (error) {
			const { message, code: raw } = error as { code?: string | null; message: string },
				code = raw || message;
			errors[code] = (errors[code] || 0) + 1;
			if (code === "25006") {
				failures.push("a write reached a read-only server: " + message);
			}
			if (!expected.has(code) && code !== "25006") {
				failures.push("unexpected error: " + code + " " + message);
			}
			await delay(50);
		}
	}
}

const writers = [...Array(4)].map(write);
await delay(1000);
const before = { written, port: last_port };

ctl("-D", dir + "/primary", "-m", "immediate", "stop");
failed_at = Date.now();
await delay(300);
ctl("-D", dir + "/standby", "promote", "-w");

const deadline = Date.now() + 20000;
await until(() => resumed_at || Date.now() > deadline);
await delay(1000);
state.running = false;
await Promise.race([
	Promise.all(writers),
	delay(10000).then(() => failures.push("writes did not settle after the failover")),
]);

if (before.port !== 5434) {
	failures.push("writes before the failover went to " + before.port);
}
if (!resumed_at) {
	failures.push("writes did not resume within 20s of the failover");
}
if (last_port !== 5435) {
	failures.push("writes after the failover went to " + last_port + ", not the promoted standby");
}

const [{ count }] = await writer`select count(*)::int as count from failover`.catch(() => [
	{ count: -1 },
]);
if (!(count >= before.written)) {
	failures.push(
		"the promoted standby has " +
			count +
			" rows, fewer than the " +
			before.written +
			" written before the failover",
	);
}

const ended = await Promise.race([
	Promise.all([writer.end({ timeout: 2 }), reader.end({ timeout: 2 })]).then(() => true),
	delay(10000).then(() => false),
]);
if (!ended) {
	failures.push("end() did not resolve");
}

spawnSync("sh", [path.join(here, "failover.sh"), "reset"]);

console.log(
	"written " +
		written +
		", resumed after " +
		(resumed_at ? resumed_at - failed_at + "ms" : "-") +
		", errors " +
		JSON.stringify(errors),
);
console.log(
	failures.length ? "⚠️ " + failures.length + " problems\n" + failures.join("\n") : "🎉 failover",
);
process.exitCode = failures.length ? 1 : 0;
