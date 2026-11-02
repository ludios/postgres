import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

const script = path.join(import.meta.dirname, "../../scripts/git-reword.ts");

/** The environment for git: no global or system config, and a fixed identity. */
const env = {
	...process.env,
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
	return spawnSync(process.execPath, [script, target], {
		cwd: dir,
		env: { ...env, ...extra_env },
		input: message,
		encoding: "utf8",
	});
}

/**
 * @param dir The directory of the repository.
 * @param oid The full hash of a commit.
 * @returns The headers of the commit object, without its parents.
 */
function headers_without_parents(dir: string, oid: string): string {
	return git(dir, ["cat-file", "commit", oid])
		.split("\n\n")[0]
		.replace(/^parent .*\n/gm, "");
}

test("git-reword rewords a commit under others, leaving the index and the working tree alone", () => {
	const { dir, oids } = make_repo(["one", "two", "three", "four"]);
	fs.writeFileSync(path.join(dir, "0.txt"), "staged");
	git(dir, ["add", "0.txt"]);
	fs.writeFileSync(path.join(dir, "1.txt"), "unstaged");
	const changes = () => [git(dir, ["diff", "--cached"]), git(dir, ["diff"])];
	const changes_before = changes();

	const result = reword(dir, oids[1], "Two\n\nA body.  \n\n\n");
	expect([result.status, result.stderr]).toEqual([0, ""]);

	const copies = git(dir, ["rev-list", "--reverse", "main"]).split("\n");
	expect(copies.map((oid) => git(dir, ["log", "-1", "--format=%B", oid]))).toEqual([
		"one",
		"Two\n\nA body.",
		"three",
		"four",
	]);
	expect(copies[0]).toBe(oids[0]);
	// The copies keep their trees, authors and committers
	expect(copies.map((oid) => headers_without_parents(dir, oid))).toEqual(
		oids.map((oid) => headers_without_parents(dir, oid)),
	);
	expect(changes()).toEqual(changes_before);
});

test("git-reword refuses a commit that a remote-tracking branch contains", () => {
	const { dir, oids } = make_repo(["one", "two"]);
	git(dir, ["update-ref", "refs/remotes/origin/main", oids[0]]);
	const result = reword(dir, oids[0], "One\n");
	expect([result.status, result.stderr, git(dir, ["rev-parse", "main"])]).toEqual([
		1,
		`git-reword: ${oids[0]} is already in refs/remotes/origin/main\n`,
		oids[1],
	]);
});

test("git-reword begins again, and loses no commit, when the branch moves meanwhile", () => {
	const { dir, oids } = make_repo(["one", "two"]);
	// A git that commits, as another process might, just before the first `git update-ref`
	const bin = make_temporary_dir();
	const real_git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	fs.writeFileSync(
		path.join(bin, "git"),
		`#!/bin/sh
if [ "$1" = update-ref ] && mkdir "${bin}/raced" 2>/dev/null; then
	"${real_git}" commit -q --allow-empty -m raced
fi
exec "${real_git}" "$@"
`,
		{ mode: 0o755 },
	);

	const result = reword(dir, oids[0], "One\n", { PATH: `${bin}:${process.env.PATH}` });
	expect([result.status, result.stderr]).toEqual([0, ""]);
	expect(git(dir, ["log", "--format=%s", "main"]).split("\n")).toEqual(["raced", "two", "One"]);
});
