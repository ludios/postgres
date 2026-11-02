import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const git_reword = path.join(import.meta.dirname, "../../scripts/git-reword");

/**
 * The environment for git: none of the GIT_* variables of the process that runs the tests (such as
 * GIT_DIR or GIT_INDEX_FILE, when a git hook runs them), no global or system config, and a fixed
 * identity.
 */
const env = {
	...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Author",
	GIT_AUTHOR_EMAIL: "author@example.com",
	GIT_COMMITTER_NAME: "Committer",
	GIT_COMMITTER_EMAIL: "committer@example.com",
};

/** The temporary directories that the current test made, to delete after it. */
const temporary = [];

afterEach(() => {
	for (const dir of temporary.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** @returns A new, empty, temporary directory. */
function make_temporary_dir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-reword-"));
	temporary.push(dir);
	return dir;
}

/**
 * Runs git.
 *
 * @param dir The directory to run git in.
 * @param args The arguments after `git`.
 * @returns What git wrote to stdout, trimmed.
 */
function git(dir: string, args: string[]): string {
	return execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
}

/**
 * Makes a repository whose branch `main` has one commit for each subject, each adding a file.
 *
 * @param subjects The subject of each commit, oldest first.
 * @returns The directory of the repository, and the full hash of each commit, oldest first.
 */
function make_repo(subjects: string[]) {
	const dir = make_temporary_dir();
	git(dir, ["init", "-q", "-b", "main"]);
	const oids = subjects.map((subject, i) => {
		fs.writeFileSync(path.join(dir, `${i}.txt`), subject);
		git(dir, ["add", "."]);
		git(dir, ["commit", "-q", "-m", subject]);
		return git(dir, ["rev-parse", "HEAD"]);
	});
	return { dir, oids };
}

/**
 * Runs git-reword.
 *
 * @param dir The directory to run it in.
 * @param target The commit to reword.
 * @param message The new message.
 * @param extra_env Environment variables to add to `env`.
 * @returns The exit status of git-reword, and what it wrote to stdout and to stderr.
 */
function reword(dir: string, target: string, message: string, extra_env = {}) {
	return spawnSync(git_reword, [target], {
		cwd: dir,
		env: { ...env, ...extra_env },
		input: message,
		encoding: "utf8",
	});
}

/**
 * @param name The name of a program.
 * @returns The path of the program that PATH finds.
 */
function find_program(name: string): string {
	return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
}

/**
 * Makes a fake program, which runs in place of the real program when git-reword runs with the
 * returned PATH.
 *
 * @param name The name of the program.
 * @param script A shell script to run in place of the program; it can run the real program as
 *   "$REAL", and it can use "$ONCE" as a path that does not exist yet, to make with `mkdir`.
 * @returns The PATH to run git-reword with, and the path of "$ONCE".
 */
function fake_program(name: string, script: string) {
	const bin = make_temporary_dir();
	const once = path.join(bin, "once");
	fs.writeFileSync(
		path.join(bin, name),
		`#!/bin/sh\nREAL="${find_program(name)}"\nONCE="${once}"\n${script}`,
		{ mode: 0o755 },
	);
	return { PATH: `${bin}:${process.env.PATH}`, once };
}

/**
 * @param dir The directory of a repository.
 * @returns A shell command that, the first time it runs, makes a commit in the repository, as
 *   another process might while git-reword runs.
 */
function commit_once(dir: string): string {
	return `if mkdir "$ONCE" 2>/dev/null; then
	env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE "${find_program("git")}" -C "${dir}" commit -q --allow-empty -m raced
fi`;
}

/** Whether this git has the experimental `git history` command, which git-reword needs. */
const has_git_history = spawnSync("git", ["history", "-h"], { env }).status === 0;
describe.skipIf(!has_git_history)("git-reword", () => {
	test("rewords a commit under others, leaving the index, the working tree and COMMIT_EDITMSG alone", () => {
		const { dir, oids } = make_repo(["one", "two", "three", "four"]);
		fs.writeFileSync(path.join(dir, "0.txt"), "staged");
		git(dir, ["add", "0.txt"]);
		fs.writeFileSync(path.join(dir, "1.txt"), "unstaged");
		// As a concurrent `git commit` might have left it
		fs.writeFileSync(path.join(dir, ".git/COMMIT_EDITMSG"), "theirs\n");
		const state = () => [
			git(dir, ["diff", "--cached"]),
			git(dir, ["diff"]),
			fs.readFileSync(path.join(dir, ".git/COMMIT_EDITMSG"), "utf8"),
		];
		const state_before = state();

		const result = reword(dir, oids[1], "Two\n\n#123 is fixed.  \n\n\n");
		expect([result.status, result.stderr]).toEqual([0, ""]);

		const copies = git(dir, ["rev-list", "--reverse", "main"]).split("\n");
		expect(copies.map((oid) => git(dir, ["log", "-1", "--format=%B", oid]))).toEqual([
			"one",
			"Two\n\n#123 is fixed.",
			"three",
			"four",
		]);
		expect(copies[0]).toBe(oids[0]);
		// The copies keep their trees and authors
		const tree_and_author = (oid) => git(dir, ["log", "-1", "--format=%T %an <%ae> %ad", oid]);
		expect(copies.map(tree_and_author)).toEqual(oids.map(tree_and_author));
		const short = (oid) => git(dir, ["rev-parse", "--short", oid]);
		expect(result.stdout).toBe(
			`${short(oids[3])} -> ${short(copies[3])} four\n` +
				`${short(oids[2])} -> ${short(copies[2])} three\n` +
				`${short(oids[1])} -> ${short(copies[1])} Two\n`,
		);
		expect(state()).toEqual(state_before);
	});

	test("rewords the commit at the tip of the branch", () => {
		const { dir, oids } = make_repo(["one", "two"]);
		const result = reword(dir, oids[1], "Two\n");
		expect([result.status, result.stderr]).toEqual([0, ""]);
		expect(git(dir, ["log", "--format=%s", "main"]).split("\n")).toEqual(["Two", "one"]);
	});

	test.each([
		["another branch contains it", "refs/heads/side"],
		["a remote-tracking branch contains it", "refs/remotes/origin/main"],
		["a tag contains it", "refs/tags/v1"],
		["it is not on the branch", null],
		["a commit after it is signed", null],
	])("refuses a commit when %s", (reason, ref) => {
		const { dir, oids } = make_repo(["one", "two"]);
		let target = oids[0];
		let error = "";
		if (ref !== null) {
			git(dir, ["update-ref", ref, target]);
			error = `${target} is also in ${ref}`;
		} else if (reason === "it is not on the branch") {
			target = git(dir, ["commit-tree", "-p", oids[0], "-m", "elsewhere", `${oids[0]}^{tree}`]);
			error = `${target} is not on refs/heads/main`;
		} else {
			const signed = git(dir, ["cat-file", "commit", oids[1]]).replace(
				/^(committer .*)$/m,
				"$1\ngpgsig -----BEGIN PGP SIGNATURE-----\n -----END PGP SIGNATURE-----",
			);
			const oid = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
				cwd: dir,
				env,
				input: signed + "\n",
				encoding: "utf8",
			}).trim();
			git(dir, ["update-ref", "refs/heads/main", oid]);
			error = `${target} or a commit after it is signed, and git history would drop the signature`;
		}
		const main_before = git(dir, ["rev-parse", "main"]);

		const result = reword(dir, target, "New\n");
		expect([result.status, result.stderr, git(dir, ["rev-parse", "main"])]).toEqual([
			1,
			`git-reword: ${error}\n`,
			main_before,
		]);
	});

	test.each([
		[
			"just before git history reword",
			"git",
			'if [ "$3" = history ]; then\n%s\nfi\nexec "$REAL" "$@"',
		],
		[
			"just before git update-ref",
			"git",
			'if [ "$1" = update-ref ]; then\n%s\nfi\nexec "$REAL" "$@"',
		],
		["while git history reads the new message", "cp", '"$REAL" "$@"\n%s'],
	])("begins again, and loses no commit, when the branch moves %s", (_, program, script) => {
		const { dir, oids } = make_repo(["one", "two"]);
		const fake = fake_program(program, script.replace("%s", commit_once(dir)));
		const result = reword(dir, oids[0], "One\n", { PATH: fake.PATH });
		expect([result.status, result.stderr, fs.existsSync(fake.once)]).toEqual([0, "", true]);
		expect(git(dir, ["log", "--format=%s", "main"]).split("\n")).toEqual(["raced", "two", "One"]);
	});

	test("ignores a COMMIT_EDITMSG that a concurrent git commit writes", () => {
		const { dir, oids } = make_repo(["one", "two"]);
		const fake = fake_program("cp", `"$REAL" "$@"\necho theirs > "${dir}/.git/COMMIT_EDITMSG"`);
		const result = reword(dir, oids[0], "One\n", { PATH: fake.PATH });
		expect([result.status, result.stderr]).toEqual([0, ""]);
		expect(git(dir, ["log", "--format=%s", "main"]).split("\n")).toEqual(["two", "One"]);
	});
});
