import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, join } from "node:path";
import { setCapabilities, resetCapabilitiesCache, visibleWidth } from "@earendil-works/pi-tui";
import { type Art, captureNotices, cleanCatimg, diskUsage, modelRow, modelRowText, newNoticeStore, onNotices, parseGpus, size, updateLines, layoutRows, warnOnce, firstFrame, MAX_IMAGE_COLS, parseStyle, pickImage, readConfig, renderArt, writeSetting } from "../startup-fetch.ts";
import { FALLBACK_MODEL_ID, FALLBACK_PROVIDER, type ChainEntry } from "../model-fallback/lib.ts";
import { publishServedRouter, servedRouter, type ServedRouter } from "../model-fallback/served.ts";
import { chooseImage, listImages } from "./startup-images.ts";
import { LOGO_KEYS, pickLogo, renderLogo, truecolor } from "./distro-logos.ts";
import { ENV_AGENT_DIR, settingsFile } from "./layout.ts";

/**
 * `readConfig` / `writeSetting` go through the settings seam (`lib/settings.ts`),
 * which resolves the global file through `layout.ts` **at call time**. So these tests
 * move the agent directory with `ENV_AGENT_DIR` instead of passing a path, and the
 * `expect` inside `beforeEach` is what proves the move took — an un-moved
 * `settingsFile()` would otherwise have the real `agent/settings.json` as its write
 * target, which no test may touch.
 */
const envBefore = process.env[ENV_AGENT_DIR];
let agentTmp = "";
let projCwd = "";

beforeEach(() => {
	agentTmp = mkdtempSync(join(os.tmpdir(), "sf-env-agent-"));
	projCwd = mkdtempSync(join(os.tmpdir(), "sf-cwd-"));
	process.env[ENV_AGENT_DIR] = agentTmp;
	expect(settingsFile().startsWith(agentTmp)).toBe(true);
});

afterEach(() => {
	if (envBefore === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = envBefore;
	rmSync(agentTmp, { recursive: true, force: true });
	rmSync(projCwd, { recursive: true, force: true });
});

/** Write the temp agent dir's settings file — the one `writeSetting` will patch. */
const writeGlobal = (obj: Record<string, unknown>) => writeFileSync(settingsFile(), JSON.stringify(obj));

/** The temp agent dir's settings file, parsed. */
const globalJson = () => JSON.parse(readFileSync(settingsFile(), "utf-8")) as Record<string, unknown>;

/** A project `.pi/settings.json` inside the temp cwd. */
const writeProject = (obj: Record<string, unknown>) => {
	const f = join(projCwd, ".pi", "settings.json");
	mkdirSync(join(f, ".."), { recursive: true });
	writeFileSync(f, JSON.stringify(obj));
	return f;
};

/**
 * Run `fn` with the process cwd at `dir`, restored after: `readConfig`'s project file
 * is `join(process.cwd(), ".pi", "settings.json")`, so a cwd-sensitive assertion has to
 * move the real cwd (this repo has no `.pi/settings.json`, but a future one must not
 * silently change what these tests read).
 */
function atCwd<T>(dir: string, fn: () => T): T {
	const prior = process.cwd();
	process.chdir(dir);
	try {
		return fn();
	} finally {
		process.chdir(prior);
	}
}

describe("readConfig", () => {
	test("mode, image, ~ expansion", () => {
		const c = readConfig({ mode: "cycle", image: "~/a.png" });
		expect(c.mode).toBe("cycle");
		expect(c.image).toBe(join(os.homedir(), "a.png"));
		expect(readConfig({ mode: "bogus", image: "duck.png" })).toMatchObject({ mode: "fixed", image: "duck.png" });
	});
	test("height bounds and defaults", () => {
		expect(readConfig({ height: 20 }).height).toBe(20);
		expect(readConfig({ height: 2 }).height).toBe(13);
		expect(readConfig({ height: "x" }).height).toBe(13);
		expect(readConfig({}).image).toBeUndefined();
		// No `startupFetch` at all — what the seam reports when neither settings file
		// exists, which is the case the old `/nonexistent` path stood for.
		expect(readConfig(undefined)).toMatchObject({ mode: "fixed", height: 13 });
		expect(readConfig("nonsense")).toMatchObject({ mode: "fixed", height: 13 });
	});
	test("the default argument reads the temp settings file through the seam", () => {
		writeGlobal({ startupFetch: { mode: "cycle", style: "octant", height: 22 } });
		expect(atCwd(projCwd, () => readConfig())).toMatchObject({ mode: "cycle", style: "octant", height: 22 });
	});
});

describe("pickImage (agent dir with images/)", () => {
	const agent = () => {
		const base = mkdtempSync(join(os.tmpdir(), "sf-agent-"));
		mkdirSync(join(base, "images"));
		for (const f of ["b.jpg", "a.png", "c.gif", "notes.txt", ".hidden.png"]) writeFileSync(join(base, "images", f), "");
		mkdirSync(join(base, "images", "sub.png"));
		return base;
	};
	const cfg = (o: object) => ({ mode: "fixed" as const, style: "half" as const, height: 13, ...o });
	test("fixed: named, missing, default first, absolute", () => {
		const base = agent();
		expect(pickImage(cfg({ image: "c.gif" }), base).path).toBe(join(base, "images", "c.gif"));
		expect(pickImage(cfg({ image: "zzz.png" }), base).problem).toContain("zzz.png");
		expect(pickImage(cfg({}), base).path).toBe(join(base, "images", "a.png"));
		expect(pickImage(cfg({ image: "/abs/x.png" }), base).path).toBe("/abs/x.png");
	});
	test("cycle advances across starts and wraps; state persists", () => {
		const base = agent();
		const seq = [1, 2, 3, 4].map(() => basename(pickImage(cfg({ mode: "cycle" }), base).path!));
		expect(seq).toEqual(["a.png", "b.jpg", "c.gif", "a.png"]);
	});
	test("random never repeats back to back", () => {
		const base = agent();
		let prev = "";
		for (let i = 0; i < 20; i++) {
			const p = basename(pickImage(cfg({ mode: "random" }), base, () => 0).path!);
			expect(p).not.toBe(prev);
			prev = p;
		}
	});
	test("off / empty folder", () => {
		expect(pickImage(cfg({ mode: "off" }), agent())).toEqual({});
		const empty = mkdtempSync(join(os.tmpdir(), "sf-empty-"));
		expect(pickImage(cfg({ mode: "cycle" }), empty)).toEqual({}); // quiet ASCII fallback
		expect(pickImage(cfg({ image: "duck.png" }), empty).problem).toContain("duck.png");
	});
	test("a broken symlink hides only itself; numeric sort", () => {
		const base = agent();
		symlinkSync("/nonexistent/x.png", join(base, "images", "broken.png"));
		for (const f of ["img10.png", "img2.png"]) writeFileSync(join(base, "images", f), "");
		expect(listImages(join(base, "images"))).toEqual(["a.png", "b.jpg", "c.gif", "img2.png", "img10.png"]);
	});
});

describe("chooseImage edge cases", () => {
	test("cycle resumes after the last-shown image was deleted", () => {
		expect(chooseImage(["a.png", "c.png"], "cycle", { last: "b.png" }).image).toBe("c.png");
		expect(chooseImage(["a.png", "c.png"], "cycle", { last: "z.png" }).image).toBe("a.png");
	});
	test("fixed is case-insensitive as a fallback; single-image random", () => {
		expect(chooseImage(["Duck.PNG"], "fixed", { fixed: "duck.png" }).image).toBe("Duck.PNG");
		expect(chooseImage(["only.png"], "random", { last: "only.png", rand: () => 0.9 }).image).toBe("only.png");
	});
});

describe("cleanCatimg", () => {
	test("strips cursor control, keeps SGR, resets each line, drops blanks", () => {
		const raw = "\x1b[s\x1b[?25l\x1b[48;2;1;2;3m\x1b[38;2;4;5;6m▄\x1b[m\n\x1b[38;2;1;1;1m▀\x1b[m\n\x1b[?25h";
		const out = cleanCatimg(raw);
		expect(out).toHaveLength(2);
		expect(out[0]).toBe("\x1b[48;2;1;2;3m\x1b[38;2;4;5;6m▄\x1b[m\x1b[0m");
		expect(out.join("")).not.toMatch(/\x1b\[(s|\?25[lh])/);
	});
});

describe("distro logos", () => {
	test("pickLogo: id, derivative alias, ID_LIKE, fallback", () => {
		expect(pickLogo(["arch"])).toBe("arch");
		expect(pickLogo(["EndeavourOS"])).toBe("arch");
		expect(pickLogo(["weirdos", "debian"])).toBe("debian");
		expect(pickLogo(["nope", "linux"])).toBe("linux");
		expect(pickLogo([])).toBe("linux");
	});
	test("every logo renders, width matches, colors reset per line", () => {
		for (const k of LOGO_KEYS) {
			const plain = renderLogo(k, false);
			expect(Math.max(...plain.lines.map((l) => l.length))).toBe(plain.width);
			for (const l of renderLogo(k, true, true).lines) expect(l.endsWith("\x1b[39m")).toBe(true);
			expect(renderLogo(k, true, false).lines.join("")).not.toContain("38;2;");
		}
	});
	test("truecolor detection", () => {
		expect(truecolor({ COLORTERM: "truecolor" })).toBe(true);
		expect(truecolor({ WT_SESSION: "x" })).toBe(true);
		expect(truecolor({ TERM: "xterm-256color" })).toBe(false);
	});
});

describe("style setting", () => {
	test("parse, default, write keeps other keys", () => {
		expect(parseStyle("sextant")).toBe("sextant");
		expect(parseStyle("bogus")).toBe("half");
		expect(readConfig({ style: "braille" }).style).toBe("braille");
		writeGlobal({ other: 1, startupFetch: { mode: "cycle" } });
		expect(writeSetting("style", "quad")).toBe(true);
		expect(globalJson()).toEqual({ other: 1, startupFetch: { mode: "cycle", style: "quad" } });
		// The file just written is what `readConfig()` reads next: no path in between.
		expect(atCwd(projCwd, () => readConfig().style)).toBe("quad");
	});

	test("startupFetch is project-overridable end to end", () => {
		// Nothing in this extension knows about the project layer: the seam merges
		// `<cwd>/.pi/settings.json` over the agent file per key, whole-object, so a repo
		// pin replaces the user's whole `startupFetch`, not just the field it names.
		writeGlobal({ startupFetch: { style: "half", height: 30 } });
		writeProject({ startupFetch: { style: "braille" } });
		const seen = atCwd(projCwd, () => readConfig());
		expect(seen.style).toBe("braille");
		expect(seen.height).toBe(13); // the global `height` is replaced, not merged into
	});

	test("writeSetting never promotes a project field into the global file", () => {
		// The accepted consequence of a global-only write: the repo keeps its own pin
		// untouched, and none of its fields are copied into the user's configuration.
		writeGlobal({ startupFetch: { mode: "cycle" } });
		const pinned = writeProject({ startupFetch: { style: "braille", image: "duck.png" } });
		expect(atCwd(projCwd, () => writeSetting("style", "quad"))).toBe(true);
		expect(globalJson()).toEqual({ startupFetch: { mode: "cycle", style: "quad" } });
		expect(globalJson().startupFetch).not.toHaveProperty("image");
		expect(readFileSync(pinned, "utf-8")).toBe(JSON.stringify({ startupFetch: { style: "braille", image: "duck.png" } }));
		// And the pin still shadows what was written: `/fetch style` there has no visible effect.
		expect(atCwd(projCwd, () => readConfig().style)).toBe("braille");
	});
});

describe("renderArt (fake exec)", () => {
	const img = () => {
		const f = join(mkdtempSync(join(os.tmpdir(), "sf-img-")), "x.png");
		writeFileSync(f, "");
		return f;
	};
	const row = (n: number) => "\x1b[38;2;1;2;3m" + "▀".repeat(n);
	test("animated catimg output keeps the first frame only", () => {
		expect(firstFrame("A\nB\x1b[uC\nD\x1b[uE")).toBe("A\nB");
	});
	test("catimg: -r 2 doubles -H; wide output re-renders width-capped; killed = failure", async () => {
		const calls: string[][] = [];
		const exec = async (_b: string, a: string[]) => {
			calls.push(a);
			const wide = a.includes("-H");
			return { stdout: Array(3).fill(row(wide ? 90 : MAX_IMAGE_COLS)).join("\n"), code: 0 };
		};
		const art = (await renderArt(exec, img(), "half", 13, () => {})) as Art;
		expect(calls[0]).toContain("26");
		expect(calls[1].slice(-3, -1)).toEqual(["-w", String(MAX_IMAGE_COLS * 2)]);
		expect(art.width).toBe(MAX_IMAGE_COLS);
		const killed = async () => ({ stdout: row(5), code: 0, killed: true });
		expect(await renderArt(killed, img(), "block", 13, () => {})).toBeUndefined();
	});
	test("missing image warns; pixels without kitty falls back to half (named reason)", async () => {
		const warns: string[] = [];
		expect(await renderArt(async () => undefined, "/nope.png", "half", 13, (m) => warns.push(m))).toBeUndefined();
		expect(warns[0]).toContain("not found");
		const exec = async () => ({ stdout: row(4), code: 0 });
		const base = { trueColor: true, hyperlinks: false };
		try {
			setCapabilities({ ...base, images: null });
			expect((await renderArt(exec, img(), "pixels", 13, (m) => warns.push(m)))?.width).toBe(4);
			expect(warns.at(-1)).toContain("no Kitty graphics");
			setCapabilities({ ...base, images: "iterm2" });
			await renderArt(exec, img(), "pixels", 13, (m) => warns.push(m));
			expect(warns.at(-1)).toContain("iTerm2");
			setCapabilities({ ...base, images: "kitty" });
			const bmp = join(mkdtempSync(join(os.tmpdir(), "sf-img-")), "x.bmp");
			writeFileSync(bmp, "");
			await renderArt(exec, bmp, "pixels", 13, (m) => warns.push(m));
			expect(warns.at(-1)).toContain(".bmp");
		} finally {
			resetCapabilitiesCache();
		}
	});
	test("pixels on kitty: sequence alone on row 0, blank rows below", async () => {
		// 1x1 red PNG
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
		const f = join(mkdtempSync(join(os.tmpdir(), "sf-img-")), "x.png");
		writeFileSync(f, png);
		try {
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
			const a = await renderArt(async () => undefined, f, "pixels", 4, () => {});
			expect(a?.graphic).toBe(true);
			expect(a!.lines[0].startsWith("\x1b_G")).toBe(true);
			expect(a!.lines.slice(1).every((l) => l === "")).toBe(true);
		} finally {
			resetCapabilitiesCache();
		}
	});
	test("chafa: args, failure and missing binary fall back to half with a warning", async () => {
		const calls: [string, string[]][] = [];
		const warns: string[] = [];
		const exec = async (b: string, a: string[]) => {
			calls.push([b, a]);
			return b.endsWith("chafa") ? { stdout: "", code: 2 } : { stdout: row(6), code: 0 };
		};
		const a = await renderArt(exec, img(), "sextant", 13, (m) => warns.push(m));
		const chafa = calls.find(([b]) => b.endsWith("chafa"));
		if (chafa) {
			expect(chafa[1]).toEqual(expect.arrayContaining(["-f", "symbols", "--symbols=block+border+sextant", `--size=${MAX_IMAGE_COLS}x13`, "--polite=on", "--animate=off"]));
			expect(warns.at(-1)).toContain("chafa could not draw");
		} else expect(warns.at(-1)).toContain("chafa is not installed");
		expect(a?.width).toBe(6); // catimg half fallback
	});
});

describe("layoutRows", () => {
	test("text art: info beside art, truncated", () => {
		const rows = layoutRows(["AA", "BB"], ["one", "two", "three"], 4, false, 80);
		expect(rows).toEqual(["AA  one", "BB  two", "    three"]);
		expect(layoutRows(["AA"], ["x".repeat(50)], 4, false, 10).every((r) => visibleWidth(r) <= 10)).toBe(true);
	});
	test("graphic: row 0 is the sequence only, info shifted down one row", () => {
		const seq = "\x1b_Ga=T;AAAA\x1b\\";
		const rows = layoutRows([seq, "", ""], ["title", "rule", "pi"], 5, true, 12);
		expect(rows[0]).toBe(seq);
		expect(rows.slice(1)).toEqual(["     title", "     rule", "     pi"]);
	});
});

describe("warnOnce", () => {
	test("each message once per pick; a new pick warns again", () => {
		const seen: string[] = [];
		const pick = { key: "k", warned: new Set<string>() };
		for (const m of ["a", "a", "b"]) warnOnce(pick, (x) => seen.push(x), m);
		expect(seen).toEqual(["a", "b"]);
		warnOnce({ key: "k", warned: new Set() }, (x) => seen.push(x), "a");
		expect(seen).toEqual(["a", "b", "a"]);
	});
});

describe("gpu / disk / updates", () => {
	test("parseGpus per platform", () => {
		const lspci = "00:02.0 VGA compatible controller: Intel Corporation UHD Graphics 630 (rev 02)\n01:00.0 3D controller: NVIDIA Corporation GA107M [GeForce RTX 3050 Mobile] (rev a1)\n00:1f.3 Audio device: Intel Corporation Foo";
		expect(parseGpus("linux", lspci)).toEqual(["Intel UHD Graphics 630", "NVIDIA GA107M [GeForce RTX 3050 Mobile]"]);
		expect(parseGpus("linux", "01:00.0 VGA compatible controller: NVIDIA Corporation X (rev a1)\n02:00.0 VGA compatible controller: NVIDIA Corporation X (rev a1)")).toEqual(["NVIDIA X ×2"]);
		expect(parseGpus("darwin", "      Chipset Model: Apple M2\n")).toEqual(["Apple M2"]);
		expect(parseGpus("win32", "NVIDIA GeForce RTX 4070\r\n\r\n")).toEqual(["NVIDIA GeForce RTX 4070"]);
	});
	test("diskUsage formats, bad path is undefined", () => {
		expect(diskUsage("/")).toMatch(/^[\d.]+ [GT]iB \/ [\d.]+ [GT]iB \(\d+%\)$/);
		expect(diskUsage("/definitely/not/here")).toBeUndefined();
	});
	test("size switches to TiB", () => {
		expect(size(2 * 1024 ** 3)).toBe("2.0 GiB");
		expect(size(4 * 1024 ** 4)).toBe("4.00 TiB");
	});
	test("AMD vendor shortened", () => {
		expect(parseGpus("linux", "03:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 21 (rev c1)")).toEqual(["AMD Navi 21"]);
	});
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
	test("updateLines: empty while checking / current, rows when pending", () => {
		expect(updateLines(theme, { update: { kind: "checking" }, notices: {} })).toEqual([]);
		expect(updateLines(theme, { update: { status: "current", currentVersion: "1" }, notices: {} })).toEqual([]);
		const l = updateLines(theme, { update: { kind: "checking" }, notices: { release: { version: "9.9.9", note: "Big release\nmore" }, packages: ["superpowers"] } });
		const t = l.join("\n");
		expect(l[1]).toStartWith("Updates");
		expect(t).toContain("→ 9.9.9 · run pi update");
		expect(t).toContain("Big release");
		expect(t).not.toContain("more");
		expect(t).toContain("superpowers · run pi update --extensions");
	});
	test("updateLines: packages only has no changelog; npm check fills pi row", () => {
		expect(updateLines(theme, { update: { kind: "checking" }, notices: { packages: ["x"] } }).join("\n")).not.toContain("changelog");
		expect(updateLines(theme, { update: { status: "available", currentVersion: "1", latestVersion: "2.0.0" }, notices: {} }).join("\n")).toContain("2.0.0");
	});
	test("updateLines: under Pi-Bolt the arrow follows auto-update's verdict, not a 'current' status", () => {
		// The release row's `latest` is a Pi-Bolt version while `current` may be Pi's.
		// A "current" npm verdict therefore must not print Pi's number beside a
		// Pi-Bolt release: the arrow is dropped instead. An "available" verdict is
		// auto-update's own current, so that one is shown.
		const notices = { release: { version: "9.9.9" } };
		const currentStatus = { status: "current", currentVersion: "1.2.3" } as const;
		const available = { status: "available", currentVersion: "1.2.3", latestVersion: "2.0.0" } as const;
		expect(updateLines(theme, { update: currentStatus, notices }, true).join("\n")).not.toContain("1.2.3");
		expect(updateLines(theme, { update: available, notices }, true).join("\n")).toContain("v1.2.3 →");
		// Not compiled: the arrow falls back to VERSION, as it always has.
		expect(updateLines(theme, { update: currentStatus, notices }, false).join("\n")).toContain("→");
	});
	test("captureNotices: captures with a listener, falls through without one", () => {
		const drawn: unknown[] = [];
		const proto: Record<string, unknown> = {
			showNewVersionNotification(r: unknown) { drawn.push(["v", r]); },
			showPackageUpdateNotification(p: unknown) { drawn.push(["p", p]); },
		};
		const store = newNoticeStore();
		expect(captureNotices({}, store)).toBe(false);
		expect(captureNotices(proto, store)).toBe(true);
		expect(captureNotices(proto, store)).toBe(true); // idempotent
		(proto.showPackageUpdateNotification as (p: unknown) => void)(["a"]);
		expect(drawn).toEqual([["p", ["a"]]]);
		const seen: unknown[] = [];
		const off = onNotices((n) => seen.push(n), store);
		(proto.showNewVersionNotification as (r: unknown) => void)({ version: "2.0.0", note: "n" });
		(proto.showPackageUpdateNotification as (p: unknown) => void)(["b"]);
		expect(drawn).toHaveLength(1);
		expect(seen.at(-1)).toEqual({ release: { version: "2.0.0", note: "n" }, packages: ["b"] });
		off();
		const late: unknown[] = [];
		onNotices((n) => late.push(n), store);
		expect(late).toEqual([{ release: { version: "2.0.0", note: "n" }, packages: ["b"] }]);
	});
});

describe("modelRowText — the Model row names the model, not only the router", () => {
	const CHAIN: ChainEntry[] = [{ ref: "a/1" }, { ref: "b/2", thinking: "low" }];
	const ROUTER = { provider: FALLBACK_PROVIDER, modelId: FALLBACK_MODEL_ID };

	test("a router selection names the chain primary, behind the router", () => {
		expect(modelRowText({ selection: ROUTER, chain: CHAIN })).toBe("fallback/auto → a/1");
	});
	test("a pinned thinking level is shown and an unpinned one is not", () => {
		expect(modelRowText({ selection: ROUTER, chain: [CHAIN[1]!] })).toBe("fallback/auto → b/2 (thinking: low)");
		expect(modelRowText({ selection: ROUTER, chain: [CHAIN[0]!] })).toBe("fallback/auto → a/1");
	});
	test("a physical selection prints provider/id and ignores the chain", () => {
		expect(modelRowText({ selection: { provider: "litellm", modelId: "gpt-5.6-sol" }, chain: CHAIN })).toBe("litellm/gpt-5.6-sol");
	});
	test("a gateway id containing a slash prints as a canonical provider/id ref", () => {
		// `litellm/qwen/qwen3.8-27b` is the canonical ref pi resolves on its first
		// rule, and byte-identical to what this row printed before the fix, so the
		// two slashes are correct rather than a wart. The footer shows only the id.
		expect(modelRowText({ selection: { provider: "litellm", modelId: "qwen/qwen3.8-27b" }, chain: CHAIN })).toBe(
			"litellm/qwen/qwen3.8-27b",
		);
	});
	test("an unreachable primary is walked past, as route() does", () => {
		expect(modelRowText({ selection: ROUTER, chain: CHAIN, isReachable: (i) => i === 1 })).toBe("fallback/auto → b/2 (thinking: low)");
	});
	test("nothing reachable still names the primary rather than nothing", () => {
		// `walkToReachable` keeps its start index when no entry is reachable, which is
		// also what a registry that is not populated yet looks like.
		expect(modelRowText({ selection: ROUTER, chain: CHAIN, isReachable: () => false })).toBe("fallback/auto → a/1");
	});
	test("with no router registered, a router selection prints the bare ref", () => {
		expect(modelRowText({ selection: ROUTER, chain: [] })).toBe("fallback/auto");
	});
	test("no selection prints none even when a router is registered", () => {
		// A snapshot must not guess: the footer assumes the router here because it is
		// redrawn after every response, but this row is drawn once.
		expect(modelRowText({ chain: CHAIN })).toBe("none");
		expect(modelRowText({ chain: [] })).toBe("none");
	});
});

describe("modelRow — the live wiring: published chain, router's resolver, no throw", () => {
	const CHAIN: ChainEntry[] = [{ ref: "a/1" }, { ref: "b/2" }];
	const ROUTER_MODEL = { provider: FALLBACK_PROVIDER, id: FALLBACK_MODEL_ID };

	/** Only the fields `modelRow` touches; the cast is the test's, not the code's. */
	const ctx = (model?: { provider: string; id: string }) => ({ model }) as unknown as Parameters<typeof modelRow>[0];

	/** A published router whose `isReachable` records what it was asked. */
	function served(reachable: (index: number) => boolean): ServedRouter & { asked: number[]; seenCtx: unknown[] } {
		const asked: number[] = [];
		const seenCtx: unknown[] = [];
		return {
			chain: CHAIN,
			asked,
			seenCtx,
			isReachable: (c, index) => {
				seenCtx.push(c);
				asked.push(index);
				return reachable(index);
			},
		};
	}

	test("names the published chain's entry, walked by the router's own predicate", () => {
		const router = served((i) => i === 1);
		const live = ctx(ROUTER_MODEL);
		expect(modelRow(live, router)).toBe("fallback/auto → b/2");
		// It must ask the router (not resolve on its own), with this session's ctx.
		expect(router.asked).toEqual([0, 1]);
		expect(router.seenCtx[0]).toBe(live);
	});
	test("with no router published, prints the bare selection", () => {
		expect(modelRow(ctx(ROUTER_MODEL), undefined)).toBe("fallback/auto");
		expect(modelRow(ctx(undefined), undefined)).toBe("none");
	});
	test("a physical selection never consults the router", () => {
		const router = served(() => true);
		expect(modelRow(ctx({ provider: "litellm", id: "gpt-5.6-sol" }), router)).toBe("litellm/gpt-5.6-sol");
		expect(router.asked).toEqual([]);
	});
	test("a throwing resolver degrades to the bare selection instead of losing the header", () => {
		const router = served(() => {
			throw new Error("registry not ready");
		});
		expect(modelRow(ctx(ROUTER_MODEL), router)).toBe("fallback/auto");
	});
	test("defaults to what model-fallback published on globalThis", () => {
		// This is the cross-extension path: pi imports each extension with
		// `moduleCache: false`, so the value has to survive a separate module copy.
		const prior = servedRouter();
		try {
			publishServedRouter({ chain: [{ ref: "z/9" }], isReachable: () => true });
			expect(modelRow(ctx(ROUTER_MODEL))).toBe("fallback/auto → z/9");
			publishServedRouter(undefined);
			expect(modelRow(ctx(ROUTER_MODEL))).toBe("fallback/auto");
		} finally {
			publishServedRouter(prior);
		}
	});
});
