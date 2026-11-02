import dc from "diagnostics_channel";
import type { Channel, TracingChannel } from "diagnostics_channel";
import type { Options } from "./index.ts";

/** A tracing channel; Node 22 and later also tell whether any of its channels has subscribers */
type Tracing = TracingChannel & { hasSubscribers?: boolean };

export const channels = {
	query: tracing("postgres:query"),
	connect: tracing("postgres:connect"),
	transaction: tracing("postgres:transaction"),
	pool: plain("postgres:pool"),
	notice: plain("postgres:notice"),
};

const done = Symbol("done");

export const now = () => performance.now();

export const userName = (options: Options) =>
	typeof options.user === "function" ? null : options.user;

export function active(t: Tracing | null) {
	return (
		!!t &&
		(t.hasSubscribers !== undefined
			? t.hasSubscribers
			: t.start.hasSubscribers ||
				t.end.hasSubscribers ||
				t.asyncStart.hasSubscribers ||
				t.asyncEnd.hasSubscribers ||
				t.error.hasSubscribers)
	);
}

export function listened(channel: Channel | null) {
	return !!channel && channel.hasSubscribers;
}

export function start<T>(t: Tracing, context: object, fn: () => T): T {
	if (typeof t.start.runStores === "function") {
		return t.start.runStores(context, run);
	}
	t.start.publish(context);
	return run();

	function run() {
		try {
			return fn();
		} finally {
			t.end.publish(context);
		}
	}
}

export function finish(t: Tracing, context: object, error: unknown, result?: unknown) {
	const x = context as { [done]?: boolean; error?: unknown; result?: unknown };
	if (x[done]) {
		return;
	}

	x[done] = true;

	if (error) {
		x.error = error;
		t.error.publish(context);
	} else {
		x.result = result;
	}

	t.asyncStart.publish(context);
	t.asyncEnd.publish(context);
}

function tracing(name: string): Tracing | null {
	try {
		return typeof dc.tracingChannel === "function" ? dc.tracingChannel(name) : null;
	} catch {
		return null;
	}
}

function plain(name: string): Channel | null {
	try {
		return dc.channel(name);
	} catch {
		return null;
	}
}
