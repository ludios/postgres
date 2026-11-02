import { expect, test } from "vitest";
import { Query } from "../../src/query.ts";

/**
 * @returns A Query whose cancel requests all fail, as when the network is down, and a function
 *   that returns how many cancel requests it has tried to send.
 */
function uncancelable_query() {
	let cancels = 0;
	const handler = {
		cancel: () => {
			cancels++;
			return Promise.reject(new Error("the cancel request could not be sent"));
		},
	};
	return { query: new Query(["select 1"], [], handler as any), cancels: () => cancels };
}

/**
 * Runs `fn`, then waits until Node would have reported any error that `fn` left unhandled.
 *
 * @param fn A function that may leave an error unhandled.
 * @returns The errors that Node reported as uncaught exceptions or as unhandled rejections.
 */
async function unhandled_errors(fn: () => void) {
	const errors = [];
	const on_error = (error) => errors.push(error);
	process.on("uncaughtException", on_error);
	process.on("unhandledRejection", on_error);
	try {
		fn();
		// Node reports both kinds of error once the microtask queue has drained
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		process.off("uncaughtException", on_error);
		process.off("unhandledRejection", on_error);
	}
	return errors;
}

test("cancel() rejects when the cancel request fails, but leaving that unhandled crashes nothing", async () => {
	const { query } = uncancelable_query();
	await expect(query.cancel()).rejects.toThrow("the cancel request could not be sent");
	const errors = await unhandled_errors(() => {
		void query.cancel();
	});
	expect(errors).toEqual([]);
});

test("A query given an aborted AbortSignal ignores a failed cancel request", async () => {
	const { query, cancels } = uncancelable_query();
	const errors = await unhandled_errors(() => {
		void query.signal(AbortSignal.abort());
	});
	expect([errors, cancels()]).toEqual([[], 1]);
});

test("A query whose AbortSignal aborts later ignores a failed cancel request", async () => {
	const { query, cancels } = uncancelable_query();
	const controller = new AbortController();
	const errors = await unhandled_errors(() => {
		void query.signal(controller.signal);
		controller.abort();
	});
	expect([errors, cancels()]).toEqual([[], 1]);
});
