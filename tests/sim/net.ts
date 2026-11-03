import { EventEmitter } from "events";

/** A fake net.Socket of Pipe(), with its peer and what the fake needs; `Record` for what the library adds */
export type End = EventEmitter & Record<string, any>;

/** A timer of Clock(): what its setTimeout() and setImmediate() give */
export type Timer = {
	ref: () => Timer;
	unref: () => Timer;
	hasRef: () => boolean;
	[Symbol.toPrimitive]: () => number;
	/** The order the timer was set in, which breaks ties of `at` */
	seq: number;
	/** When it fires, on the clock */
	at: number;
	fn: () => void;
};

/** @returns a deterministic source of pseudo-random numbers, from `seed` */
export function Random(seed: number) {
	let x = seed >>> 0;
	const next = () => {
		x = (x + 0x6d2b79f5) >>> 0;
		let t = Math.imul(x ^ (x >>> 15), 1 | x);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};

	return {
		next,
		int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
		chance: (p: number) => next() < p,
		pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)],
	};
}

export function Clock(
	onerror: (error: any) => void = (e) => {
		throw e;
	},
) {
	const timers = new Map<number, Timer>(),
		real_immediate = setImmediate;
	let now = 0,
		seq = 0;

	const add = (fn: (...args: any[]) => void, ms: number, args: unknown[]) => {
		const id: Timer = {
			ref: () => id,
			unref: () => id,
			hasRef: () => true,
			[Symbol.toPrimitive]: () => id.seq,
			seq: ++seq,
			at: now + Math.max(0, ms || 0),
			fn: () => fn(...args),
		};
		timers.set(id.seq, id);
		return id;
	};
	const clear = (id: Timer | null | undefined) => id && timers.delete(id.seq);

	return {
		timers: {
			setTimeout: (fn: (...args: any[]) => void, ms: number, ...args: unknown[]) =>
				add(fn, ms, args),
			clearTimeout: clear,
			setImmediate: (fn: (...args: any[]) => void, ...args: unknown[]) => add(fn, 0, args),
			clearImmediate: clear,
			now: () => now,
		},
		get now() {
			return now;
		},
		get pending() {
			return timers.size;
		},
		pending_timers: () => [...timers.values()],
		async run(until = Infinity) {
			let same = 0,
				at = now;
			while (true) {
				await new Promise(real_immediate);
				same = now === at ? same + 1 : 0;
				at = now;
				if (same > 20000) {
					throw new Error(
						"Timer storm: 20,000 timers ran at " + now + "ms without the clock moving on",
					);
				}

				let next: Timer | null = null;
				for (const x of timers.values()) {
					if (!next || x.at < next.at || (x.at === next.at && x.seq < next.seq)) {
						next = x;
					}
				}
				if (!next || next.at > until) {
					break;
				}

				timers.delete(next.seq);
				now = next.at;
				try {
					next.fn();
				} catch (e) {
					onerror(e);
				}
			}
			if (until !== Infinity) {
				now = Math.max(now, until);
			}
		},
	};
}

/**
 * @returns two connected fake sockets, `client` and `server`, whose data reaches the other end after
 *   up to `delay` ms of the clock, split in two with probability `split`
 */
export function Pipe({
	clock,
	random,
	delay = 0,
	split = 0,
}: {
	clock: ReturnType<typeof Clock>;
	random: ReturnType<typeof Random>;
	delay?: number;
	split?: number;
}) {
	const { setTimeout } = clock.timers;

	const client = end(),
		server = end();

	client.peer = server;
	server.peer = client;
	return { client, server };

	function end() {
		// A fake net.Socket: the Object.assign below adds its properties.
		const x: End = new EventEmitter();
		let last = 0,
			paused = false,
			held: Buffer[] = [];

		Object.assign(x, {
			destroyed: false,
			writable: true,
			readable: true,
			write(data: Buffer | string, encoding?: unknown, cb?: () => void) {
				if (typeof encoding === "function") {
					cb = encoding as () => void;
				}
				if (x.destroyed || !x.writable) {
					return false;
				}

				const bytes = Buffer.from(data as string);
				for (const part of chop(bytes)) {
					send(part);
				}
				if (cb) {
					setTimeout(cb, 0);
				}
				return true;
			},
			end(data?: Buffer) {
				if (x.destroyed || !x.writable) {
					return x;
				}

				if (data && data.length) {
					x.write(data);
				}
				x.writable = false;
				later(() => x.peer.closed(false));
				return x;
			},
			destroy(error?: Error) {
				if (x.destroyed) {
					return x;
				}

				x.destroyed = true;
				x.writable = x.readable = false;
				setTimeout(() => {
					if (error) {
						x.emit("error", error);
					}
					x.emit("close", !!error);
				}, 0);
				later(() => x.peer.closed(true));
				return x;
			},
			pause() {
				paused = true;
				return x;
			},
			resume() {
				paused = false;
				const xs = held;
				held = [];
				xs.forEach(receive);
				return x;
			},
			get readyState() {
				return x.destroyed
					? "closed"
					: x.readable && x.writable
						? "open"
						: x.readable
							? "readOnly"
							: "writeOnly";
			},
			setKeepAlive: () => x,
			setNoDelay: () => x,
			ref: () => x,
			unref: () => x,
			receive,
			closed(reset: boolean) {
				if (x.destroyed) {
					return;
				}

				if (reset) {
					x.destroyed = true;
					x.writable = x.readable = false;
					const error = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
					x.emit("error", error);
					x.emit("close", true);
				} else {
					x.readable = false;
					x.emit("end");
					if (x.writable) {
						x.end();
					}
					x.destroyed = true;
					x.emit("close", false);
				}
			},
		});

		return x;

		function receive(data: Buffer) {
			if (x.destroyed) {
				return;
			}
			if (paused) {
				held.push(data);
			} else {
				x.emit("data", data);
			}
		}

		function chop(data: Buffer) {
			if (!split || !random.chance(split) || data.length < 2) {
				return [data];
			}

			const at = random.int(1, data.length - 1);
			return [data.subarray(0, at), data.subarray(at)];
		}

		function later(fn: () => void) {
			last = Math.max(last, clock.now + (delay ? random.int(0, delay) : 0));
			setTimeout(fn, last - clock.now);
		}

		function send(data: Buffer) {
			later(() => x.peer.receive(data));
		}
	}
}
