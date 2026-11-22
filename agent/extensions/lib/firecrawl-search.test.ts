/**
 * Tests for the keyless `--sources` gate (lib/firecrawl-search.ts).
 *
 * The contract worth pinning is the *direction* of a mistake. A block that
 * misfires costs the agent one round trip and an instruction it can act on; a
 * rewrite that misfires runs a command nobody wrote — pi re-validates nothing
 * after a handler mutates `event.input`. So every case below that is not an
 * unambiguous keyless bare `firecrawl search` asserts `allow`, and the block
 * cases assert that no `command` comes back at all.
 *
 * Run from the repo root:
 * `bun test agent/extensions/lib/firecrawl-search.test.ts`
 */
import { describe, expect, test } from "bun:test";

import {
	AMBIGUOUS_PREFIXES,
	guardFirecrawlSearch,
	type SearchGuardEnv,
	type SearchGuardVerdict,
} from "./firecrawl-search.js";

/** The broken setup: a self-hosted endpoint, and no API key to satisfy alexandria. */
const KEYLESS: SearchGuardEnv = { hasApiKey: false, hasApiUrl: true };

const verdict = (command: string, env: SearchGuardEnv = KEYLESS): SearchGuardVerdict =>
	guardFirecrawlSearch(command, env);

/** Assert every command in a table is allowed, naming the one that failed. */
function allows(commands: readonly string[]): void {
	for (const command of commands) {
		expect(verdict(command), `expected an allow verdict for:\n  ${command}`).toEqual({ kind: "allow" });
	}
}

describe("guardFirecrawlSearch — the keyless --sources gate", () => {
	test("blocks a bare firecrawl search when a URL is configured and no key exists", () => {
		const v = verdict('firecrawl search "pi coding agent" --limit 5');
		expect(v.kind).toBe("block");
		if (v.kind !== "block") return;
		// The reason has to name the flag and the source that caused it, because
		// the CLI's own error names neither: it blames a missing API key.
		expect(v.reason).toMatch(/--sources web/);
		expect(v.reason).toMatch(/Alexandria/);
		// Never a rewrite. The guard refuses; the agent decides the new command.
		expect("command" in v).toBe(false);
	});

	test("allows when FIRECRAWL_API_KEY is configured", () => {
		expect(verdict('firecrawl search "pi coding agent" --limit 5', { hasApiKey: true, hasApiUrl: true })).toEqual({
			kind: "allow",
		});
	});

	test("allows when FIRECRAWL_API_URL is unset", () => {
		// No endpoint means the CLI is not aimed at this instance (or is not aimed
		// anywhere), so its default sources may well be served. Not our business.
		expect(verdict('firecrawl search "pi coding agent" --limit 5', { hasApiKey: false, hasApiUrl: false })).toEqual({
			kind: "allow",
		});
	});

	test("allows --sources in every spelling", () => {
		allows([
			'firecrawl search "pi coding agent" --limit 5 --sources web',
			'firecrawl search "pi coding agent" --sources=web',
			'firecrawl search "pi coding agent" --sources "web"',
			"firecrawl search 'pi' --sources web,images",
		]);
	});

	test("does not override a deliberate non-web source", () => {
		// The guard's whole job is preserving an explicit choice, so it cannot
		// inspect *which* source was chosen and second-guess it.
		allows(['firecrawl search "budget deficits" --sources news']);
	});

	test("separates the two alexandria spellings", () => {
		// Naming the cloud index as a value is a decision the guard stays out of. The
		// positional path is not a decision — it is a web search shape that always
		// asks for the cloud index — so it gets refused, in its own words.
		allows(['firecrawl search --sources alexandria "q"', 'firecrawl search "q" --sources web,alexandria']);
		expect(verdict('firecrawl search alexandria "q"').kind).toBe("block");
	});

	test("ignores every non-search firecrawl command", () => {
		allows([
			"firecrawl scrape https://example.com --format markdown",
			"firecrawl map https://example.com --limit 50",
			"firecrawl crawl https://example.com --limit 25 --wait",
			"firecrawl --status",
			"firecrawl parse ./report.pdf",
		]);
	});

	test("is anchored to the command word, not the whole string", () => {
		// A substring match here would block half of research: the phrase shows up
		// in prose, in `grep` arguments, and in commit-message searches.
		allows([
			'firecrawl scrape "how to use firecrawl search"',
			'echo "firecrawl search x"',
			'grep -rn "firecrawl search" agent/',
			'git log --grep="firecrawl search"',
			"cat notes.md # firecrawl search",
		]);
	});

	test("blocks once however many bare searches a command chains", () => {
		const chained = verdict("firecrawl search a && firecrawl search b; firecrawl search c");
		expect(chained.kind).toBe("block");
		if (chained.kind !== "block") return;
		// One verdict, and the same one a single search gets: the reason is about
		// the missing flag, not about how many commands need it.
		const single = verdict("firecrawl search a");
		expect(single.kind).toBe("block");
		if (single.kind !== "block") return;
		expect(chained.reason).toBe(single.reason);
		expect("command" in chained).toBe(false);
	});

	test("allows when the command is ambiguous — when uncertain, allow", () => {
		allows([
			// A prefix that may resolve to a different program or supply a key.
			"env X=1 firecrawl search q",
			"npx firecrawl search q",
			"xargs firecrawl search q",
			// Body text, not a command: the search may never run at all.
			"cat <<'EOF'\nfirecrawl search q\nEOF",
			// Shell expansion the guard cannot evaluate.
			"firecrawl search $(cat q.txt)",
			// The command word itself is computed, so even `firecrawl` is unsure.
			"`which firecrawl` search q",
		]);
	});

	test("recognises the binary by its command-word token only", () => {
		expect(verdict("/usr/local/bin/firecrawl search q").kind).toBe("block");
		allows(["firecrawl-cli search q"]);
	});

	test("is total over junk input", () => {
		for (const command of ["", "   ", "\n", ";;;", '"']) {
			expect(() => verdict(command), `threw on ${JSON.stringify(command)}`).not.toThrow();
			expect(verdict(command), `expected an allow verdict for ${JSON.stringify(command)}`).toEqual({ kind: "allow" });
		}
	});

	test("does not split a command on a separator that sits inside quotes", () => {
		// The reason the tokenizer exists: a markdown table row, or a query with a
		// semicolon in it, is data. A raw split invents a command out of it.
		allows([
			'echo "| firecrawl search q | --limit 5" >> notes.md',
			'firecrawl search "a;b" --sources web',
			'firecrawl search "x|y" --sources web',
			'firecrawl search "x|y" --sources web && jq -r ".[].url"',
		]);
	});

	test("still blocks a quoted query that carries no --sources", () => {
		// The other half: the quoted separator becomes one inert token, and what is
		// left is still an unambiguous bare search.
		expect(verdict('firecrawl search "a;b"').kind).toBe("block");
	});

	test("allows an unbalanced quote rather than guessing which bytes are data", () => {
		allows(['firecrawl search "unclosed | tail -1']);
	});

	test("allows a wrapper outside the segment that holds the search", () => {
		// Every member is pinned in the only shape where it changes the verdict: a
		// lone `sudo firecrawl …` already fails the command-word test, so it is the
		// chained case that proves the set is read at all.
		allows([...AMBIGUOUS_PREFIXES].map((word) => `${word} ls && firecrawl search q`));
		// An assignment prefix is NOT a wrapper: it runs the same command.
		allows(["env X=1 true; firecrawl search q"]);
	});

	test("allows a key supplied on the command line, which process.env cannot see", () => {
		// The CLI's own key lookup takes a flag before the environment, so any of
		// these satisfies requireAlexandriaKey and would have run.
		allows([
			"FIRECRAWL_API_KEY=x firecrawl search q",
			"export FIRECRAWL_API_KEY=x && firecrawl search q",
			"declare -x FIRECRAWL_API_KEY=x\nfirecrawl search q",
			"firecrawl search q --api-key dummy",
			"firecrawl search q -k dummy",
		]);
	});

	test("blocks a --domain-tools search, whose reason names the second trigger", () => {
		const v = verdict("firecrawl search q --domain-tools example.com");
		expect(v.kind).toBe("block");
		if (v.kind !== "block") return;
		// `--sources web` alone does not save this command, so the copy must say so.
		expect(v.reason).toMatch(/--domain-tools/);
	});

	test("documents what the classifier does not read, so a change here is noticed", () => {
		// Known blind spots, pinned as ALLOW so widening either one fails here
		// rather than changing behaviour quietly.
		// A value-taking option before the sub-command reads as the sub-command, so
		// the search is never identified. Pinned as ALLOW on purpose: widening it is
		// a real change and should fail here rather than change behaviour quietly.
		allows(["firecrawl --api-url http://x search q"]);
		// A *boolean* option before the sub-command is fine — the first non-flag
		// token is still `search`.
		expect(verdict("firecrawl --json search q").kind).toBe("block");
		// Windows launchers are command words too.
		expect(verdict("firecrawl.exe search q").kind).toBe("block");
	});
	test("refuses the alexandria tool-discovery path with its own sentence", () => {
		// Verified against the CLI: this path keyless fails with the same error, and
		// adding --sources web cannot save it, so it must not be told to.
		const v = verdict('firecrawl search alexandria "vector databases"');
		expect(v.kind).toBe("block");
		if (v.kind !== "block") return;
		expect(v.reason).toMatch(/alexandria/);
		expect(v.reason).not.toMatch(/Add `--sources web` and re-run/);
	});

	test("reads a search behind a wrapper that preserves the argv", () => {
		// Checked against a real shell: these hand over `search q` unchanged, so what
		// sits behind them is still an unambiguous search.
		for (const wrapper of ["sudo", "time", "nice", "nohup", "command"]) {
			expect(verdict(`${wrapper} firecrawl search q`).kind).toBe("block");
			allows([`${wrapper} firecrawl search q --sources web`]);
		}
	});

	test("allows a wrapper that could supply the key or resolve a different binary", () => {
		allows([...AMBIGUOUS_PREFIXES].map((word) => `${word} firecrawl search q`));
	});
	test("allows a command that is not a string, rather than faulting the handler", () => {
		const junk = 42 as unknown as string;
		expect(() => verdict(junk)).not.toThrow();
		expect(verdict(junk)).toEqual({ kind: "allow" });
	});

	test("blocks a search carrying a non-key assignment prefix, and exempts a key one", () => {
		// The branch that skips `VAR=value` prefixes does two jobs: a plain prefix
		// must not hide the search, and a key prefix must authenticate it.
		expect(verdict("FOO=bar firecrawl search q").kind).toBe("block");
		allows(["FOO=bar firecrawl search q --sources web"]);
	});

	test("does not let a key prefix on one segment exempt a later search", () => {
		// `VAR=x cmd` binds to `cmd` alone in bash, so this search still runs keyless.
		expect(verdict("FIRECRAWL_API_KEY=x ls && firecrawl search q").kind).toBe("block");
	});

	test("treats a quoted flag name as the flag itself", () => {
		// The shell hands `"--sources"` to execve identically to `--sources`; only the
		// sub-command position is quoting-sensitive, and there it must stay sensitive.
		allows(['firecrawl search q "--sources" web', 'firecrawl search q "--sources=web"', 'firecrawl search q "--api-key" abc']);
		expect(verdict('firecrawl "search" q').kind).toBe("block");
	});

	test("allows a spaced heredoc delimiter and an argument that is an expansion", () => {
		allows(["cat << EOF\nfirecrawl search q\nEOF", 'cat << "EOF"\nfirecrawl search q\nEOF', 'firecrawl search "$SRC" q']);
	});

	test("splits on a newline so a multi-line script is read line by line", () => {
		expect(verdict("cd /tmp\nfirecrawl search q").kind).toBe("block");
		allows(["cd /tmp\nfirecrawl search q --sources web"]);
	});
});
