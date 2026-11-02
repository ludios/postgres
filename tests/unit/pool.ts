import v8 from "v8";
import vm from "vm";
import { expect, test } from "vitest";
import { Queue } from "../../src/pool.ts";

const gc = globalThis.Bun
	? () => globalThis.Bun.gc(true)
	: (v8.setFlagsFromString("--expose-gc"), vm.runInNewContext("gc"));

test("Queue hands items back in order across compaction", async () => {
	const q = Queue(),
		out = [];
	for (let i = 0; i < 5000; i++) {
		q.push(i);
		i % 3 === 0 && out.push(q.shift());
	}
	while (q.length) out.push(q.shift());
	expect(out.length === 5000 && out.every((x, i) => x === i)).toBe(true);
});

test("Queue removes, peeks and takes what is left", async () => {
	const q = Queue();
	[1, 2, 3, 4].forEach((x) => q.push(x));
	q.shift();
	const removed = q.remove((x) => x === 3),
		missing = q.remove((x) => x === 9);
	expect([removed, missing, q.peek(), q.take().join(), q.length].join(" ")).toBe(
		"true false 2 2,4 0",
	);
});

test("Queue shifts a long queue in linear time", async () => {
	const time = (n) => {
		const q = Queue();
		for (let i = 0; i < n; i++) q.push({ i });
		const start = performance.now();
		while (q.length) q.shift();
		return performance.now() - start;
	};
	const best = (n) => Math.min(...[1, 2, 3, 4, 5].map(() => time(n)));
	time(50000);
	const small = Math.max(best(50000), 1),
		large = best(400000);
	expect(large < small * 30).toBe(true);
});

test("Queue stays small when items cycle through it without it ever draining (#747)", async () => {
	const q = Queue();
	q.push("a");
	q.push("b");
	q.push("c");
	for (let i = 0; i < 1000000; i++) q.push(q.shift());
	gc();
	const before = process.memoryUsage().heapUsed;
	for (let i = 0; i < 1000000; i++) q.push(q.shift());
	gc();
	expect(q.length + " " + (process.memoryUsage().heapUsed - before < 1024 * 1024)).toBe("3 true");
});
