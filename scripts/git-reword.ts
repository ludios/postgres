/**
 * Replaces the message of a commit on the current branch, even while other processes commit in
 * the same working tree.
 *
 * Usage: node scripts/git-reword.ts COMMIT < NEW_MESSAGE
 *
 * It writes only commit objects and the branch, never the working tree or the index, so it leaves
 * alone the files that others are editing and the changes that others have staged.
 *
 * COMMIT keeps its tree, author and committer. The commits after COMMIT get new hashes, because
 * their parents change, but keep everything else. The branch moves to the new commits only if it
 * still points where it pointed when the rewording began; otherwise, the rewording begins again,
 * so a commit made meanwhile is never lost. A `git commit` running at the very moment the branch
 * moves fails without changing anything, and then needs running again.
 *
 * It refuses to reword a commit that a remote-tracking branch or a tag contains, and a commit that
 * is signed or has a signed commit after it (because the signature would no longer match).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

/** How many times the rewording begins again, if the branch keeps moving, before giving up. */
const MAX_ATTEMPTS = 10;

/** A reason to refuse the rewording; the branch stays where it was. */
class RefusalError extends Error {
	name = "RefusalError";
}

/**
 * Runs git in the current directory.
 *
 * @param args The arguments after `git`.
 * @param input What to write to the stdin of git.
 * @returns The exit status of git, and what git wrote to stdout and to stderr.
 */
function run_git(args: string[], input = "") {
	const result = spawnSync("git", args, { encoding: "utf8", input });
	if (result.error) {
		throw result.error;
	}
	return result;
}

/**
 * Runs git in the current directory, and throws an Error if git exits with a nonzero status.
 *
 * @param args The arguments after `git`.
 * @param input What to write to the stdin of git.
 * @returns What git wrote to stdout.
 */
function git(args: string[], input = ""): string {
	const result = run_git(args, input);
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} exited with status ${result.status}: ${result.stderr}`);
	}
	return result.stdout;
}

/**
 * @param name A name for a commit, such as a hash or `HEAD~2`.
 * @returns The full hash of the commit.
 */
function resolve_commit(name: string): string {
	const result = run_git(["rev-parse", "-q", "--verify", "--end-of-options", name + "^{commit}"]);
	if (result.status !== 0) {
		throw new RefusalError(`${name} is not a commit`);
	}
	return result.stdout.trim();
}

/** @returns The full name of the branch that HEAD is on, such as `refs/heads/prime`. */
function current_branch(): string {
	const result = run_git(["symbolic-ref", "-q", "HEAD"]);
	if (result.status !== 0) {
		throw new RefusalError("HEAD is not on a branch");
	}
	return result.stdout.trim();
}

/** @returns The new message from stdin, cleaned up as `git commit -F` cleans up a message. */
function read_message(): string {
	if (process.stdin.isTTY) {
		throw new RefusalError("the new message must come from stdin");
	}
	const message = git(["stripspace"], fs.readFileSync(0, "utf8"));
	if (message === "") {
		throw new RefusalError("the new message is empty");
	}
	return message;
}

/**
 * Throws a RefusalError if `target` is not on the branch, or has been published.
 *
 * @param target The full hash of the commit to reword.
 * @param branch The full name of the branch.
 * @param tip The full hash of the commit that the branch points to.
 */
function check_rewordable(target: string, branch: string, tip: string) {
	if (run_git(["merge-base", "--is-ancestor", target, tip]).status !== 0) {
		throw new RefusalError(`${target} is not on ${branch}`);
	}
	const refs = git([
		"for-each-ref",
		"--format=%(refname)",
		"--contains",
		target,
		"refs/remotes",
		"refs/tags",
	]).trim();
	if (refs !== "") {
		throw new RefusalError(`${target} is already in ${refs.split("\n").join(", ")}`);
	}
}

/**
 * Writes a copy of a commit object, with its parents replaced by their copies, and optionally
 * with a new message.
 *
 * @param oid The full hash of the commit to copy.
 * @param copies Maps the full hash of each commit copied so far to the full hash of its copy. A
 *   parent that is not in it stays.
 * @param message The message for the copy; if undefined, the copy keeps the message.
 * @returns The full hash of the copy.
 */
function copy_commit(oid: string, copies: Map<string, string>, message?: string): string {
	const raw = git(["cat-file", "commit", oid]);
	const end = raw.indexOf("\n\n");
	if (end === -1) {
		throw new Error(`commit ${oid} has no blank line after its headers`);
	}

	const headers = raw.slice(0, end);
	if (/^gpgsig/m.test(headers)) {
		throw new RefusalError(`${oid} is signed, and the signature would not match its copy`);
	}
	const copy =
		headers.replace(/^parent (\S+)$/gm, (_, parent) => "parent " + (copies.get(parent) ?? parent)) +
		"\n\n" +
		(message ?? raw.slice(end + 2));
	return git(["hash-object", "-t", "commit", "-w", "--stdin"], copy).trim();
}

/**
 * Copies `target` with the new message, and the commits after it on the branch with new parents,
 * then moves the branch to the copy of its tip, unless the branch moved meanwhile.
 *
 * @param target The full hash of the commit to reword.
 * @param message The new message.
 * @param branch The full name of the branch.
 * @returns Maps the full hash of each commit that was copied (oldest first) to the full hash of
 *   its copy; or null if the branch moved meanwhile.
 */
function reword_once(target: string, message: string, branch: string): Map<string, string> | null {
	const tip = git(["rev-parse", "--verify", branch]).trim();
	check_rewordable(target, branch, tip);
	const after = git(["rev-list", "--reverse", "--topo-order", "--ancestry-path", `${target}..${tip}`])
		.split("\n")
		.filter(Boolean);

	const copies = new Map<string, string>();
	copies.set(target, copy_commit(target, copies, message));
	for (const oid of after) {
		copies.set(oid, copy_commit(oid, copies));
	}

	// Moves the branch only if it still points to `tip`
	const moved = run_git(["update-ref", "-m", "reword " + target, branch, copies.get(tip), tip]);
	if (moved.status !== 0) {
		if (git(["rev-parse", "--verify", branch]).trim() !== tip) {
			return null;
		}
		throw new Error(`git update-ref failed: ${moved.stderr}`);
	}
	return copies;
}

/**
 * Prints each commit that was copied, with the hash of its copy and its subject.
 *
 * @param copies Maps the full hash of each commit that was copied to the full hash of its copy.
 */
function report(copies: Map<string, string>) {
	const subjects = git(["log", "--no-walk=unsorted", "--format=%s", ...copies.values()]).split("\n");
	[...copies].forEach(([oid, copy], i) => {
		process.stdout.write(`${oid.slice(0, 12)} -> ${copy.slice(0, 12)} ${subjects[i]}\n`);
	});
}

function main() {
	const args = process.argv.slice(2);
	if (args.length !== 1) {
		console.error("Usage: node scripts/git-reword.ts COMMIT < NEW_MESSAGE");
		process.exitCode = 2;
		return;
	}

	try {
		const target = resolve_commit(args[0]);
		const branch = current_branch();
		const message = read_message();
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const copies = reword_once(target, message, branch);
			if (copies !== null) {
				report(copies);
				return;
			}
		}
		throw new RefusalError(`${branch} kept moving, so gave up after ${MAX_ATTEMPTS} attempts`);
	} catch (error) {
		if (!(error instanceof RefusalError)) {
			throw error;
		}
		console.error("git-reword: " + error.message);
		process.exitCode = 1;
	}
}

main();
