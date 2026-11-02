import { expect, test } from "vitest";
import { postgres, options, delay } from "./setup.ts";

/** @returns how many TCP sockets keep this process's event loop alive */
function ref_sockets() {
	return process.getActiveResourcesInfo().filter((x) => x === "TCPSocketWrap").length;
}

test("unref_sockets lets go of a connection that waited for the types to load", async () => {
	const before = ref_sockets();
	// min: 2 opens a second connection, which waits while the first one loads the types
	const sql = postgres({ ...options, min: 2, max: 2, unref_sockets: true });
	await sql`select 1`;
	while (sql.stats.opening) {
		await delay(10);
	}
	const connections = sql.stats.connections,
		after = ref_sockets();
	await sql.end();
	expect([connections, after - before]).toEqual([2, 0]);
});
