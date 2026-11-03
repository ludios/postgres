import v8 from "v8";
import vm from "vm";
import { expect, test } from "vitest";
import * as fc from "fast-check";
import { Queue } from "../../src/pool.ts";
import { thrown } from "../helpers.ts";

/** @returns Node's gc(), which --expose-gc makes */
function exposed_gc() {
	v8.setFlagsFromString("--expose-gc");
	return vm.runInNewContext("gc");
}

const bun = (globalThis as { Bun?: { gc: (full: boolean) => void } }).Bun,
	gc = bun ? () => bun.gc(true) : exposed_gc();

test("Queue hands items back in order across compaction", async () => {
	const q = Queue(),
		out = [];
	for (let i = 0; i < 5000; i++) {
		q.push(i);
		if (i % 3 === 0) {
			out.push(q.shift());
		}
	}
	while (q.length) {
		out.push(q.shift());
	}
	expect(out).toEqual([...Array(5000).keys()]);
});

test("Queue removes, peeks and takes what is left", async () => {
	const q = Queue();
	[1, 2, 3, 4].forEach((x) => q.push(x));
	q.shift();
	const removed = q.remove((x) => x === 3),
		missing = q.remove((x) => x === 9);
	expect([removed, missing, q.peek(), q.take(), q.length]).toEqual([true, false, 2, [2, 4], 0]);
});

test("Queue shifts a long queue in linear time", async () => {
	const time = (n: number) => {
		const q = Queue();
		for (let i = 0; i < n; i++) {
			q.push({ i });
		}
		const start = performance.now();
		while (q.length) {
			q.shift();
		}
		return performance.now() - start;
	};
	const best = (n: number) => Math.min(...[1, 2, 3, 4, 5].map(() => time(n)));
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
	for (let i = 0; i < 1000000; i++) {
		q.push(q.shift());
	}
	gc();
	const before = process.memoryUsage().heapUsed;
	for (let i = 0; i < 1000000; i++) {
		q.push(q.shift());
	}
	gc();
	expect([q.length, process.memoryUsage().heapUsed - before < 1024 * 1024]).toEqual([3, true]);
});

/**
 * An operation on a queue of numbers: remove() takes out the first item equal to its number, and
 * push_many() and shift_many() do many at once, so that a run gets past the 1024 shifts after which
 * the queue compacts
 */
type Operation =
	| { op: "push"; x: number }
	| { op: "shift" }
	| { op: "peek" }
	| { op: "remove"; x: number }
	| { op: "take" }
	| { op: "push_many"; n: number }
	| { op: "shift_many"; n: number };

const operation: fc.Arbitrary<Operation> = fc.oneof(
	fc.record({ op: fc.constant("push" as const), x: fc.nat({ max: 20 }) }),
	fc.record({ op: fc.constant("shift" as const) }),
	fc.record({ op: fc.constant("peek" as const) }),
	fc.record({ op: fc.constant("remove" as const), x: fc.nat({ max: 20 }) }),
	fc.record({ op: fc.constant("take" as const) }),
	// Often, and of up to 1500 items, so that about one run in ten compacts (measured: 102 of 1000)
	{
		arbitrary: fc.record({
			op: fc.constant("push_many" as const),
			n: fc.integer({ min: 1, max: 1500 }),
		}),
		weight: 4,
	},
	{
		arbitrary: fc.record({
			op: fc.constant("shift_many" as const),
			n: fc.integer({ min: 1, max: 1500 }),
		}),
		weight: 4,
	},
);

/**
 * @param ops - operations, run in order on a Queue and on a plain array
 * @returns what each operation gave on the Queue, then what each gave on the array: shift() and
 *   peek() the item (or the error's message for a shift() of an empty queue, which throws),
 *   remove() whether it removed, take() the items, push() the queue's length after it, push_many()
 *   the length after it, and shift_many() the items it shifted (no more than the queue had)
 */
function compared(ops: Operation[]) {
	const queue = Queue<number>(),
		model: number[] = [],
		got: unknown[] = [],
		want: unknown[] = [];
	for (const o of ops) {
		switch (o.op) {
			case "push": {
				queue.push(o.x);
				model.push(o.x);
				got.push(queue.length);
				want.push(model.length);
				break;
			}
			case "shift": {
				got.push(model.length === 0 ? thrown(() => queue.shift()).message : queue.shift());
				want.push(model.length === 0 ? "Bug: shift() of an empty Queue" : model.shift());
				break;
			}
			case "peek": {
				got.push(queue.peek());
				want.push(model[0]);
				break;
			}
			case "remove": {
				const i = model.indexOf(o.x);
				got.push(queue.remove((x) => x === o.x));
				want.push(i !== -1);
				if (i !== -1) {
					model.splice(i, 1);
				}
				break;
			}
			case "take": {
				got.push(queue.take());
				want.push(model.splice(0));
				break;
			}
			case "push_many": {
				for (let i = 0; i < o.n; i++) {
					queue.push(i % 21);
					model.push(i % 21);
				}
				got.push(queue.length);
				want.push(model.length);
				break;
			}
			case "shift_many": {
				const n = Math.min(o.n, model.length);
				got.push(Array.from({ length: n }, () => queue.shift()));
				want.push(model.splice(0, n));
				break;
			}
		}
	}
	return [got, want];
}

test("Queue gives what a plain array gives, for any pushes, shifts, peeks, removes and takes, also once it compacts", async () => {
	fc.assert(
		fc.property(fc.array(operation, { maxLength: 60 }), (ops) => {
			const [got, want] = compared(ops);
			expect(got).toEqual(want);
		}),
		{ numRuns: 1000 },
	);
});

test("Queue says how it emptied (served, taken or removed), and not when take() finds nothing", async () => {
	const how: string[] = [],
		q = Queue<number>((x) => how.push(x));
	q.push(1);
	q.shift();
	q.push(2);
	q.push(3);
	q.take();
	q.take();
	q.push(4);
	q.remove((x) => x === 4);
	q.push(5);
	q.push(6);
	q.remove((x) => x === 5);
	q.shift();
	expect(how).toEqual(["served", "taken", "removed", "served"]);
});
