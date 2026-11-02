import type { Exchange } from "./connection.ts";
import type { Column } from "./protocol.ts";

/** The statement of a Result, as .statement gives it: see README's "### .statement" */
type Described = ReturnType<typeof statement>;

export default class Result extends Array {
	#count: number | null = null;
	#state: { pid: number | null; secret: number | null } | null = null;
	#command: string | null = null;
	#columns: Column[] | null = null;
	/** The exchange, until .statement is read: then what statement() made of it */
	#statement: Exchange | Described | null = null;

	get count() {
		return this.#count;
	}
	set count(x: number | null) {
		this.#count = x;
	}
	get state() {
		return this.#state;
	}
	set state(x: { pid: number | null; secret: number | null } | null) {
		this.#state = x;
	}
	get command() {
		return this.#command;
	}
	set command(x: string | null) {
		this.#command = x;
	}
	get columns() {
		return this.#columns;
	}
	set columns(x: Column[] | null) {
		this.#columns = x;
	}
	get statement() {
		const x = this.#statement;
		return x && "kind" in x ? (this.#statement = statement(x)) : x;
	}

	set statement(x: Exchange | Described | null) {
		this.#statement = x;
	}

	static get [Symbol.species]() {
		return Array;
	}
}

export function statement(item: Exchange) {
	const x = item.statement;
	return {
		name: x ? x.name : "",
		string: x ? x.text : item.text || "",
		types: item.params || (item.entry && item.entry.oids) || [],
		columns: item.columns || [],
	};
}
