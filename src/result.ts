import type { Exchange } from "./connection.ts";
import type { Backend, Column } from "./protocol.ts";

/** The statement of a Result, as .statement gives it: see README's "### .statement" */
type Described = { name: string; string: string; types: number[]; columns: Column[] };

export default class Result extends Array {
	#count: number | null = null;
	#state: Backend | null = null;
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
	set state(x: Backend | null) {
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

export function statement(item: Exchange): Described {
	switch (item.kind) {
		case "query":
			return {
				name: item.statement.name,
				string: item.statement.text,
				types: item.params || (item.entry && item.entry.oids) || [],
				columns: item.columns || [],
			};
		case "step":
			// The step's own exchange learns nothing of the statement: the cursor's did
			return statement(item.origin);
		case "simple":
			return { name: "", string: item.text, types: [], columns: item.columns || [] };
		default:
			return { name: "", string: "", types: [], columns: [] };
	}
}
