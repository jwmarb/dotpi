/**
 * Behavioural check for patch 3 in scripts/patch-pi.sh (per-message thinking
 * labels). See docs/adr/0034 for why the patch exists.
 *
 *     node scripts/check-thinking-label-patch.mjs
 *
 * This does NOT re-implement the patch. It EXTRACTS the live
 * `setHiddenThinkingLabel` body from the installed bundle and runs it against a
 * stand-in for pi's component tree, so the assertions below describe whatever
 * is actually installed. A hand-copied body would drift from the real one and
 * quietly start testing nothing.
 *
 * Exits non-zero if the installed behaviour is wrong, and reports UNPATCHED
 * (rather than failing) when the marker is absent, since patch 3 is optional.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PKG =
	process.env.PI_PKG_DIR ??
	join(homedir(), ".bun/install/global/node_modules/@earendil-works/pi-coding-agent");
const MARKER = "PI_PER_MESSAGE_THINKING_LABEL";

/** Locates the bundled chunk holding the label setter; its hash changes per release. */
async function findChunk() {
	const dir = join(PKG, "dist/bundle/chunks");
	const { readdir } = await import("node:fs/promises");
	for (const name of await readdir(dir)) {
		if (!name.endsWith(".js")) continue;
		const path = join(dir, name);
		const source = await readFile(path, "utf8");
		if (source.includes("defaultHiddenThinkingLabel")) return { path, source };
	}
	throw new Error("no chunk contains defaultHiddenThinkingLabel — bundle layout changed");
}

/** Slices out the setter body by brace-matching from the marker. */
function extractSetter(source) {
	const start = source.indexOf(`setHiddenThinkingLabel(label){/*${MARKER}*/`);
	if (start === -1) return undefined;
	const open = source.indexOf("{", start);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const ch = source[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return source.slice(open + 1, i);
		}
	}
	throw new Error("unbalanced braces while extracting the setter");
}

class AssistantMessageComponent {
	constructor(label) {
		this.label = label;
	}
	setHiddenThinkingLabel(label) {
		this.label = label;
	}
}

/** Minimal stand-in for pi's InteractiveMode, carrying only what the setter touches. */
function makeMode(setterBody) {
	const setter = new Function("label", "AssistantMessageComponent", setterBody);
	return {
		defaultHiddenThinkingLabel: "Thinking...",
		hiddenThinkingLabel: "Thinking...",
		chatContainer: { children: [] },
		streamingComponent: undefined,
		ui: { requestRender() {} },
		setHiddenThinkingLabel(label) {
			setter.call(this, label, AssistantMessageComponent);
		},
		startTurn() {
			const component = new AssistantMessageComponent(this.hiddenThinkingLabel);
			this.chatContainer.children.push(component);
			this.streamingComponent = component;
			return component;
		},
		endStream() {
			this.streamingComponent = undefined;
		},
	};
}

const chunk = await findChunk();
const body = extractSetter(chunk.source);
if (body === undefined) {
	console.log(`UNPATCHED: ${MARKER} absent from ${chunk.path}`);
	console.log("Patch 3 is optional; run scripts/patch-pi.sh to apply it.");
	console.log('Without it, "Thought for Ns" appears on every assistant turn.');
	process.exit(0);
}

const labels = (mode) => mode.chatContainer.children.map((c) => c.label);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let failures = 0;
const check = (name, ok, got) => {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` -> got ${JSON.stringify(got)}`}`);
};

const mode = makeMode(body);

// A label applied mid-stream lands on the message being reasoned about.
mode.startTurn();
mode.setHiddenThinkingLabel("Thought for 5s");
check("labels the streaming message", same(labels(mode), ["Thought for 5s"]), labels(mode));
mode.endStream();

// The next turn must not inherit the previous duration while it is still thinking.
mode.startTurn();
check("next turn opens as 'Thinking...'", labels(mode)[1] === "Thinking...", labels(mode));

// The whole point: an earlier turn keeps its own number.
mode.setHiddenThinkingLabel("Thought for 12s");
check(
	"earlier turn keeps its own duration",
	same(labels(mode), ["Thought for 5s", "Thought for 12s"]),
	labels(mode),
);
mode.endStream();

// pi clears streamingComponent at message_end, so a late label must still find a home.
mode.startTurn();
mode.endStream();
mode.setHiddenThinkingLabel("Thought for 3s");
check(
	"late label hits the newest message only",
	same(labels(mode), ["Thought for 5s", "Thought for 12s", "Thought for 3s"]),
	labels(mode),
);

// pi itself calls this bare on /reload: it must still reset everything.
mode.setHiddenThinkingLabel();
check(
	"bare call resets every message",
	same(labels(mode), ["Thinking...", "Thinking...", "Thinking..."]),
	labels(mode),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
