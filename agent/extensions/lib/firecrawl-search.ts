/**
 * The keyless `--sources` gate for `firecrawl search`.
 *
 * **What this owns:** the one decision "is this shell command an unambiguous
 * `firecrawl search` that will die on this instance because the CLI's default
 * source list names a cloud-only index?" Nothing else — not the environment,
 * not the `tool_call` registration, not what pi does with the refusal.
 *
 * **Why the decision lives here rather than beside the handler:** it is a pure
 * function of (command text, two booleans), and it is exactly the kind of rule a
 * one-line substring check gets spectacularly wrong — `grep -rn "firecrawl
 * search" agent/` mentions the phrase and must not be blocked. Splitting it out
 * follows `auto-update/`, where `compareSemver`/`planUpdateCheck` are tested in
 * `lib/auto-update.test.ts` and `index.ts` keeps only registration: this file
 * holds the reasoning and the whole table of command shapes, `firecrawl-cli.ts`
 * holds the `pi.on`, and the suite needs no mock pi to reach the logic. It is
 * also what keeps `lib/` free of the pi package, which the `lib/` rule requires.
 *
 * **Why there is a tokenizer and not a regex.** The first version of this gate
 * split the raw string on `;`, `|` and `&`. That invented commands out of prose:
 * `echo "| firecrawl search q |" >> notes.md` — a markdown table row — was
 * refused. Masking quoted runs fixed that and broke differently, because a quote
 * is shell syntax and not a boundary: `firecrawl search q "--sources" web` passes
 * the flag and was refused anyway, while `firecrawl "search" q` is an ordinary
 * bare search and got through. So the text is now tokenised the way the shell
 * would read it — quotes removed, separators honoured only outside quotes,
 * expansions recorded — and every rule below compares argv elements to argv
 * elements.
 *
 * **The direction of a mistake is deliberate: allow when uncertain.** A block
 * that misfires costs the agent one round trip and hands it a sentence it can
 * act on. The alternative this module refuses — rewriting the command — misfires
 * by running a command nobody wrote, because pi performs *no re-validation* of
 * `event.input` after a handler mutates it. So no verdict here ever carries a
 * replacement command, and every shape this file cannot read (a wrapper prefix, a
 * heredoc body, an unbalanced quote, an expanded argument, a computed command
 * word) is allowed. The fallback when the guard stays quiet is the CLI's own loud
 * error: a worse message, but not a wrong action.
 *
 * **Known blind spots, all in the allow direction.** An option's value sitting in
 * the sub-command's place (`firecrawl --api-url X search q` reads `X` as the
 * sub-command, so the search is never identified) is not recognised, and neither
 * is any tool but `bash`/`powershell` running the CLI. `--sources` is matched in
 * its long form only, which is complete for `firecrawl-cli` 1.25.1 — it has no
 * `-s` alias (`-s` is `--scrape-id`). A key that reaches the CLI through its own
 * credentials file (`~/.config/firecrawl-cli/credentials.json`, written by
 * `firecrawl config`) is invisible here: reading it is an env-and-file question
 * the caller owns, and nothing in 1.25.1 writes that file by itself.
 *
 * @module extensions/lib/firecrawl-search
 */

/** The two environment facts the gate needs; reading them is the caller's job. */
export interface SearchGuardEnv {
	/** A `FIRECRAWL_API_KEY` exists, so the default sources can authenticate. */
	readonly hasApiKey: boolean;
	/** A `FIRECRAWL_API_URL` exists, so the CLI aims at this instance at all. */
	readonly hasApiUrl: boolean;
}

/**
 * The gate's whole output. There is no `rewrite` member: the guard refuses and
 * explains, and the agent writes the corrected command.
 */
export type SearchGuardVerdict =
	| { readonly kind: "allow" }
	| { readonly kind: "block"; readonly reason: string };

/**
 * One argv element as the shell would hand it over: `text` with the quotes
 * removed, and `expanded` when any part of it is `$VAR`, `${VAR}`, `$(…)` or a
 * backtick — in which case the element's real value does not exist yet and no
 * rule here may judge it. Quoting needs no flag of its own: a quoted word and an
 * unquoted one arrive at `execve` identical, so they tokenize identically.
 * of it is `$VAR`, `${VAR}`, `$(…)` or a backtick — in which case the element's
 * real value does not exist yet and no rule here may judge it.
 */
interface Token {
	readonly text: string;
	readonly expanded: boolean;
}

/** The flag whose absence is being refused. */
const SOURCE_FLAG = "--sources";

/** An inline key satisfies the default sources without any environment variable. */
const KEY_FLAGS = new Set(["-k", "--api-key"]);

/**
 * Words that change what the segment means: `env` may inject the very key whose
 * absence we are refusing, `npx` resolves a different binary, `xargs` takes part
 * of the argv from stdin, `watch` re-runs under a shell of its own. One of these
 * as a command word makes the whole line unreadable, so the line is allowed.
 */
export const AMBIGUOUS_PREFIXES = new Set(["env", "npx", "xargs", "watch"]);

/**
 * Words that run the same binary with the same argv (`bash` treats `time` as a
 * reserved word, `command` bypasses aliases, the rest are privilege/scheduling
 * wrappers). Verified against a real shell: `time firecrawl search q` hands over
 * `search q` unchanged. They are skipped, so the search behind them is still read.
 * Export-like words are absent for a different reason: see `KEY_EXPORTERS`.
 */
const PASSTHROUGH_WRAPPERS = new Set(["sudo", "time", "nice", "nohup", "command"]);

/**
 * Builtins that put a variable into the environment for everything that follows
 * them in the same shell — the opposite of a `VAR=x cmd` prefix, which binds to
 * one command. `export KEY=x && firecrawl search q` really does run authenticated.
 */
const KEY_EXPORTERS = new Set(["export", "declare", "typeset"]);

/** `<<EOF`, `<<- EOF`, `<<'EOF'`: what follows is heredoc body, not commands. */
const HEREDOC = /<<[-~]?\s*[\w'"]/;

/** A leading `FOO=bar` assignment: a value, not the command word. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A key supplied as a shell assignment, which `process.env` cannot see. */
const KEY_ASSIGNMENT = /^FIRECRAWL_API_KEY=.+$/;

/** Characters that end a command, when they are not inside quotes. */
const SEPARATOR_CHARS = new Set([";", "&", "|", "\n"]);

/** The binary, as a command word: so `firecrawl-cli` cannot hit it, and Windows launchers can. */
const BINARY_WORD = /^(?:.*[/\\])?firecrawl(?:\.exe|\.cmd|\.bat)?$/;

/** Characters that end a word, when they are not inside quotes. */
const WORD_BREAK = /[\t \n]/;

const ALLOW: SearchGuardVerdict = { kind: "allow" };

/**
 * What the agent reads when it is refused. Deliberately NOT exported: the suite
 * asserts the wording a real agent sees, and a shared constant would let the
 * copy and the assertion drift together and go wrong in the same direction.
 */
const MISSING_SOURCES_REASON = [
	"firecrawl search needs --sources web on this instance.",
	"",
	"The CLI defaults `search` to the sources `web,alexandria`, and `alexandria` is a",
	"cloud-only index this self-hosted instance does not serve. The command would die",
	"with `Alexandria requires a Firecrawl API key with access enabled.` — an error",
	"about a missing flag, not about the topic.",
	"",
	"Add `--sources web` and re-run. If the command also passes `--domain-tools`, drop",
	"that too: it reaches for the same cloud index and needs the same key.",
	"",
	"If this command was not an unambiguous firecrawl search, run it as its own tool",
	"call, or prefix it with a space and `echo` to see how it was read.",
].join("\n");
/**
 * The second refusal, for the one shape where `--sources web` is not the answer.
 * `search alexandria "…"` asks the cloud tool index by position, so the command
 * needs a different command, not a flag — and telling it to add one would be a
 * refusal that sends the agent in a circle.
 */
const ALEXANDRIA_PATH_REASON = [
	"firecrawl search alexandria <query> queries Firecrawl's cloud tool index.",
	"",
	"It is not a web search with a missing flag: it always asks for that index, so",
	"`--sources web` does not change it, and on this keyless self-hosted instance it",
	"dies with `Alexandria requires a Firecrawl API key with access enabled.`",
	"",
	"Drop the `alexandria` argument to search the web, with `--sources web`.",
].join("\n");

/**
 * Consume one expansion starting at `at` and return the index just past it.
 * Nesting is counted for `$( … )` because a `)` inside a quoted string in a
 * substitution is not the end of it.
 */
function expansionEnd(command: string, at: number): number {
	const open = command[at];
	if (open === "`") {
		const close = command.indexOf("`", at + 1);
		return close < 0 ? command.length : close + 1;
	}
	if (command[at + 1] === "(") {
		let depth = 0;
		for (let i = at + 1; i < command.length; i++) {
			if (command[i] === "(") depth++;
			else if (command[i] === ")" && --depth === 0) return i + 1;
		}
		return command.length;
	}
	if (command[at + 1] === "{") {
		const close = command.indexOf("}", at + 2);
		return close < 0 ? command.length : close + 1;
	}
	const name = /^\$\w+/.exec(command.slice(at));
	return name ? at + name[0].length : at + 1;
}

/**
 * Split a command line into `&&`/`||`/`;`/`|`/`&`/newline-separated segments of
 * argv elements, the way a shell would read it.
 *
 * `null` means the quoting never closed: at that point which bytes are data is
 * genuinely undecidable, and the caller must allow.
 */
function tokenize(command: string): Token[][] | null {
	const segments: Token[][] = [];
	let segment: Token[] = [];
	let text = "";
	let expanded = false;
	let started = false;
	let inSingle = false;
	let inDouble = false;

	const endWord = () => {
		if (started) segment.push({ text, expanded });
		text = "";
		expanded = false;
		started = false;
	};
	const endSegment = () => {
		endWord();
		segments.push(segment);
		segment = [];
	};

	for (let at = 0; at < command.length; at++) {
		const ch = command[at] as string;

		if (inSingle) {
			if (ch === "'") inSingle = false;
			else text += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			started = true;
			continue;
		}
		if (ch === '"') {
			inDouble = !inDouble;
			started = true;
			continue;
		}
		if (ch === "\\" && at + 1 < command.length) {
			text += command[++at];
			started = true;
			continue;
		}
		if (ch === "$" || ch === "`") {
			// An expansion is inert inside single quotes and live inside double ones,
			// where the text is kept as written because quotes already stop a `;` or a
			// `|` from separating anything.
			if (inDouble) {
				text += ch;
				expanded = true;
				started = true;
				continue;
			}
			const end = expansionEnd(command, at);
			text += command.slice(at, end);
			expanded = true;
			started = true;
			at = end - 1;
			continue;
		}
		if (!inDouble && SEPARATOR_CHARS.has(ch)) {
			while (at + 1 < command.length && SEPARATOR_CHARS.has(command[at + 1] as string)) at++;
			endSegment();
			continue;
		}
		if (!inDouble && WORD_BREAK.test(ch)) {
			endWord();
			continue;
		}
		text += ch;
		started = true;
	}

	if (inSingle || inDouble) return null;
	endSegment();
	return segments;
}

/** The command word of a segment, past any `VAR=value` prefixes and argv-preserving wrappers. */
function commandWord(tokens: readonly Token[]): {
	word: Token | undefined;
	at: number;
	keyAssigned: boolean;
} {
	let at = 0;
	let keyAssigned = false;
	for (;;) {
		const token = tokens[at] as Token | undefined;
		if (token === undefined) break;
		if (ASSIGNMENT.test(token.text)) {
			// A `VAR=x cmd` prefix binds to `cmd` alone: it is a fact about this
			// segment and nothing else, so `keyAssigned` exempts only this command.
			if (KEY_ASSIGNMENT.test(token.text)) keyAssigned = true;
			at++;
			continue;
		}
		if (PASSTHROUGH_WRAPPERS.has(token.text)) {
			at++;
			continue;
		}
		break;
	}
	return { word: tokens[at], at, keyAssigned };
}

/**
 * Refuse an unambiguous keyless bare `firecrawl search`; allow everything else.
 *
 * @param command The `bash`/`powershell` tool's command text, exactly as it was
 *   asked for. Never parsed by a shell and never modified. A non-string is
 *   allowed rather than thrown on: the signature says string, and pi validates
 *   tool arguments before this handler runs, but a convenience gate must not be
 *   able to fault on a caller's type error.
 * @param env Whether a key and an endpoint are configured. Callers read these at
 *   call time so configuring a key takes effect without a restart.
 */
export function guardFirecrawlSearch(command: string, env: SearchGuardEnv): SearchGuardVerdict {
	// A key satisfies the default sources itself, and with no endpoint the CLI is not
	// aimed at this instance at all (a non-default apiUrl is what makes it skip key
	// validation — see `firecrawl-cli.ts`). Either way the rule does not apply, and
	// it is decided before any parsing so no command shape can reach it.
	if (env.hasApiKey || !env.hasApiUrl) return ALLOW;
	if (typeof command !== "string" || command.length === 0) return ALLOW;

	// A heredoc body is prose that happens to look like commands, and this file does
	// not parse where the body ends.
	if (HEREDOC.test(command)) return ALLOW;

	const segments = tokenize(command);
	if (segments === null) return ALLOW;

	for (const tokens of segments) {
		const { word, at, keyAssigned } = commandWord(tokens);
		if (word === undefined || word.expanded) continue;

		// `export KEY=x && …` authenticates every segment after it, so nothing later
		// in this command can hit the missing-key error.
		if (KEY_EXPORTERS.has(word.text) && tokens.some((t) => KEY_ASSIGNMENT.test(t.text))) return ALLOW;

		// One wrapper anywhere makes the whole line unreadable: what it runs, and
		// whether it runs each segment at all, is up to the wrapper.
		if (AMBIGUOUS_PREFIXES.has(word.text)) return ALLOW;

		// Anchored to the command word on purpose: the phrase `firecrawl search`
		// turns up in `grep` arguments, commit searches, and prose about itself.
		if (!BINARY_WORD.test(word.text)) continue;

		const args = tokens.slice(at + 1);
		const subCommand = args.find((token) => !token.text.startsWith("-"));
		if (subCommand === undefined || subCommand.text !== "search") continue;

		// Any expanded argument could be holding the flag we say is missing.
		if (args.some((token) => token.expanded)) continue;
		// `search alexandria "…"` is the CLI's tool-discovery path. It is checked
		// before the flag rules because no flag rescues it: it always asks for the
		// cloud index, so it needs its own sentence rather than advice to add
		// `--sources web`, which would not save it.
		if (subCommand === args[0] && args[1]?.text === "alexandria") {
			return { kind: "block", reason: ALEXANDRIA_PATH_REASON };
		}
		// An explicit source list is a decision — including a deliberately non-web one,
		// including `--sources alexandria` by name, and quoting the flag name changes
		// nothing about the argv the CLI receives.
		if (args.some((t) => t.text === SOURCE_FLAG || t.text.startsWith(`${SOURCE_FLAG}=`))) continue;
		// So is an inline key, here or on this segment's own prefix.
		if (keyAssigned || args.some((t) => KEY_FLAGS.has(t.text))) continue;

		// One refusal is enough: the reason is about the missing flag, not about
		// how many searches in this command need it.
		return { kind: "block", reason: MISSING_SOURCES_REASON };
	}

	return ALLOW;
}
