// Model-output: Claude Opus 5.5
import { EventEmitter } from "events";
import { expect, test } from "vitest";
import { Socket } from "../../src/socket.ts";
import { port_of } from "../common.ts";

function fake() {
	// A fake net.Socket, which records what is written to it
	const x: EventEmitter & Record<string, any> = new EventEmitter();
	x.written = [];
	x.write = (data) => (x.written.push(data), true);
	x.end = (data) => (data && x.written.push(data), (x.ended = true));
	x.destroy = () => x.emit("close", true);
	x.pause = () => (x.paused = true);
	x.resume = () => (x.paused = false);
	return x;
}

test("Socket takes the user socket", async () => {
	const raw = fake(),
		socket = await Socket({ socket: () => raw });
	expect(socket.raw === raw).toBe(true);
});

test("Socket passes data, drain and writes through", async () => {
	const raw = fake(),
		socket = await Socket({ socket: async () => raw }),
		got = [];
	socket.ondata = (x) => got.push(x.toString());
	socket.ondrain = () => got.push("drain");
	raw.emit("data", Buffer.from("a"));
	raw.emit("drain");
	socket.write(Buffer.from("b"));
	expect(got.join() + "|" + raw.written.join()).toBe("a,drain|b");
});

test("Socket closes once with the error that came before", async () => {
	const raw = fake(),
		socket = await Socket({ socket: () => raw }),
		closes = [];
	socket.onclose = (x) => closes.push(x && x.code);
	raw.emit("error", Object.assign(new Error("reset"), { code: "ECONNRESET" }));
	raw.emit("close", true);
	raw.emit("close", true);
	expect(closes.join()).toBe("ECONNRESET");
});

test("Socket does not write after close", async () => {
	const raw = fake(),
		socket = await Socket({ socket: () => raw });
	raw.emit("close", false);
	expect([socket.write(Buffer.from("x")), raw.written.length, socket.closed].join()).toBe(
		"false,0,true",
	);
});

test("Socket pause and resume reach the user socket", async () => {
	const raw = fake(),
		socket = await Socket({ socket: () => raw });
	socket.pause();
	const paused = raw.paused;
	socket.resume();
	expect(paused + "," + raw.paused).toBe("true,false");
});

test("Socket rejects when the user socket fails", async () => {
	expect(
		await Socket({
			socket: () => {
				throw new Error("nope");
			},
		}).catch((e) => e.message),
	).toBe("nope");
});

test("Socket reads plain TCP through a shared buffer unless onread is false", async () => {
	const net = await import("net"),
		server = net.createServer((x) => x.end());
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = port_of(server),
		shared = await Socket({ ssl: false }, "127.0.0.1", port),
		stream = await Socket({ ssl: false, onread: false }, "127.0.0.1", port);
	shared.destroy();
	stream.destroy();
	server.close();
	expect([shared.shared, stream.shared].join()).toBe("true,false");
});
