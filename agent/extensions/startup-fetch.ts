/**
 * Startup "fetch" header — a neofetch-style panel that replaces pi's built-in
 * startup header (logo + key hints) and, together with `quietStartup: true` in
 * settings.json, the loaded-resource listing (context, skills, prompts,
 * extensions).
 *
 * Shows: pi version + update status, cwd (+ git branch), OS, kernel, host,
 * uptime, shell, terminal, CPU, GPU(s), memory, disk usage, model, and an
 * Updates block (pi + installed packages) in place of pi's boxed notices.
 *
 * The update check is auto-update's memoised `getUpdateStatus` (one shared
 * `npm view` per 4h, surviving /reload); it and the git-branch lookup run in
 * the background and the panel re-renders when they resolve, so startup never
 * waits. Values are snapshotted per header build and renders are cached per
 * width. `/fetch` rebuilds the header and forces a re-check;
 * `/builtin-header` restores pi's own.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { convertToPng, InteractiveMode, resizeImage, VERSION } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, getImageDimensions, renderImage, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, statfsSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { agentDir, settingsFile } from "./lib/layout.js";
import { pickLogo, renderLogo, truecolor } from "./lib/distro-logos.js";
import { chooseImage, IMAGE_MODES, type ImageMode, listImages, parseMode, readState, writeState } from "./lib/startup-images.js";
import { getUpdateStatus, type UpdateStatus } from "./auto-update/index.js";

type UpdateState = { kind: "checking" } | UpdateStatus;

/** GPU names from the platform's own tool (lspci / system_profiler / CIM). */
export function parseGpus(platform: NodeJS.Platform, stdout: string): string[] {
	const out: string[] = [];
	if (platform === "linux") {
		for (const l of stdout.split("\n")) {
			const m = l.match(/(?:VGA compatible controller|3D controller|Display controller)[^:]*:\s*(.+)$/);
			if (m) out.push(shortVendor(m[1].replace(/\s*\(rev [0-9a-f]+\)$/i, "")));
		}
	} else if (platform === "darwin") {
		for (const m of stdout.matchAll(/Chipset Model:\s*(.+)/g)) out.push(m[1].trim());
	} else {
		for (const l of stdout.split(/\r?\n/)) if (l.trim()) out.push(l.trim());
	}
	// Identical cards collapse to one row with a count ("… ×4").
	const counts = new Map<string, number>();
	for (const g of out) counts.set(g, (counts.get(g) ?? 0) + 1);
	return [...counts].map(([g, n]) => (n > 1 ? `${g} ×${n}` : g));
}

/** lspci vendor strings → short names. */
const VENDORS: [RegExp, string][] = [
	[/^NVIDIA Corporation\s+/, "NVIDIA "],
	[/^Advanced Micro Devices, Inc\. \[AMD\/ATI\]\s+/, "AMD "],
	[/^Advanced Micro Devices, Inc\.\s+/, "AMD "],
	[/^Intel Corporation\s+/, "Intel "],
];
const shortVendor = (s: string) => VENDORS.reduce((acc, [re, to]) => acc.replace(re, to), s.trim());

// GPUs don't change while pi runs: one probe per process (survives /reload).
const GPU_KEY = Symbol.for("dotpi.startup-fetch.gpus");
const gpuStore = globalThis as unknown as Record<symbol, Promise<string[]> | undefined>;

function gpus(pi: ExtensionAPI): Promise<string[]> {
	return (gpuStore[GPU_KEY] ??= probeGpus(pi));
}

async function probeGpus(pi: ExtensionAPI): Promise<string[]> {
	const p = process.platform;
	const [bin, args]: [string | undefined, string[]] =
		p === "linux" ? ["lspci", []]
		: p === "darwin" ? ["system_profiler", ["SPDisplaysDataType"]]
		: p === "win32" ? ["powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"]]
		: [undefined, []];
	if (!bin) return ["unavailable"];
	try {
		const r = await pi.exec(bin, args, { timeout: 4000 });
		if (r.code !== 0) return [`unavailable (${bin} failed)`];
		const g = parseGpus(p, r.stdout);
		return g.length ? g : ["none detected"];
	} catch {
		return [`unavailable (no ${bin})`];
	}
}

/** Used/total of the filesystem holding `path` (statfs; no subprocess). */
export function diskUsage(path: string): string | undefined {
	try {
		const s = statfsSync(path);
		const total = s.blocks * s.bsize;
		const used = total - s.bfree * s.bsize;
		if (!total) return undefined;
		return `${size(used)} / ${size(total)} (${Math.round((used / total) * 100)}%)`;
	} catch {
		return undefined;
	}
}

// pi's own startup notices (new pi release, package updates), captured
// instead of drawn as separate boxes. pi calls each notifier at most once,
// possibly before or after the header exists, so results are kept on
// globalThis and listeners are woken. With no panel listening (e.g. after
// /builtin-header) the original box is drawn as before.
const NOTICE_KEY = Symbol.for("dotpi.startup-fetch.notices");
export type PiRelease = { version: string; note?: string };
export type Notices = { release?: PiRelease; packages?: string[] };
type NoticeStore = { notices: Notices; listeners: Set<(n: Notices) => void>; patched: WeakSet<object> };
const noticeStore = ((globalThis as unknown as Record<symbol, NoticeStore>)[NOTICE_KEY] ??= {
	notices: {},
	listeners: new Set(),
	patched: new WeakSet(),
});

const NOTIFIERS = {
	showNewVersionNotification: (arg: unknown): Notices => {
		const r = arg as { version?: unknown; note?: unknown } | undefined;
		return typeof r?.version === "string" ? { release: { version: r.version, note: typeof r.note === "string" ? r.note : undefined } } : {};
	},
	showPackageUpdateNotification: (arg: unknown): Notices => ({ packages: Array.isArray(arg) ? arg.map(String) : [] }),
};

/**
 * Route pi's update notices into the panel. False when pi's internals moved
 * (its boxes then stay). `store` is injectable for tests.
 */
export function captureNotices(
	proto: Record<string, unknown> | undefined = (InteractiveMode as unknown as { prototype?: Record<string, unknown> } | undefined)?.prototype,
	store: NoticeStore = noticeStore,
): boolean {
	if (!proto) return false;
	if (store.patched.has(proto)) return true;
	if (!Object.keys(NOTIFIERS).every((k) => typeof proto[k] === "function")) return false;
	for (const [name, parse] of Object.entries(NOTIFIERS)) {
		const orig = proto[name] as (this: unknown, a: unknown) => unknown;
		proto[name] = function (this: unknown, arg: unknown) {
			if (!store.listeners.size) return orig.call(this, arg);
			store.notices = { ...store.notices, ...parse(arg) };
			for (const l of store.listeners) l(store.notices);
		};
	}
	store.patched.add(proto);
	return true;
}

export function newNoticeStore(): NoticeStore {
	return { notices: {}, listeners: new Set(), patched: new WeakSet() };
}

/** Subscribe to captured notices (replays what pi already reported). */
export function onNotices(cb: (n: Notices) => void, store: NoticeStore = noticeStore): () => void {
	if (store.notices.release || store.notices.packages) cb(store.notices);
	store.listeners.add(cb);
	return () => store.listeners.delete(cb);
}

function osName(): string {
	try {
		const m = readFileSync("/etc/os-release", "utf-8").match(/^PRETTY_NAME="?([^"\n]+)"?/m);
		if (m) return m[1];
	} catch {}
	return `${os.type()} ${os.release()}`;
}

async function gitBranch(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	try {
		const r = await pi.exec("git", ["-C", cwd, "branch", "--show-current"], { timeout: 2000 });
		if (r.code !== 0) return undefined;
		return r.stdout.trim() || "detached";
	} catch {
		return undefined;
	}
}

function fmtUptime(sec: number): string {
	const d = Math.floor(sec / 86400);
	const h = Math.floor((sec % 86400) / 3600);
	const m = Math.floor((sec % 3600) / 60);
	return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(" ");
}

const gib = (b: number) => (b / 1024 ** 3).toFixed(1);
/** GiB, or TiB from 1 TiB up. */
export const size = (b: number) => (b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(2)} TiB` : `${gib(b)} GiB`);

function homeRel(p: string): string {
	const home = os.homedir();
	return p === home || p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

/** Logo key from os-release ID, then ID_LIKE, then the platform. */
function logoKey(): string {
	const cands: string[] = [];
	try {
		const rel = readFileSync("/etc/os-release", "utf-8");
		const get = (k: string) => rel.match(new RegExp(`^${k}="?([^"\\n]+)"?`, "m"))?.[1];
		const id = get("ID");
		if (id) cands.push(id);
		cands.push(...(get("ID_LIKE")?.split(/\s+/) ?? []));
	} catch {}
	cands.push(process.platform);
	return pickLogo(cands);
}

interface FetchConfig {
	/** How the image is picked from `images/` (see lib/startup-images.ts). */
	mode: ImageMode;
	/** "fixed" mode: a file name inside images/ (or an absolute/~ path). */
	image?: string;
	/** How the image is drawn (see ART_STYLES). */
	style: ArtStyle;
	/** Image height in terminal rows. */
	height: number;
}

/**
 * Drawing styles, coarse to fine. `block`/`half` use catimg; `quad`,
 * `sextant`, `octant`, `braille`, `ascii` use chafa (falling back to `half`
 * when chafa is missing); `pixels` sends real pixels over the Kitty graphics
 * protocol when the terminal supports it (else `half`; iTerm2 too).
 */
export const ART_STYLES = ["block", "half", "quad", "sextant", "octant", "braille", "ascii", "pixels"] as const;
export type ArtStyle = (typeof ART_STYLES)[number];
const STYLE_HELP: Record<ArtStyle, string> = {
	block: "full blocks █, 1 pixel per cell (catimg)",
	half: "half blocks ▀, 1×2 pixels per cell, exact colors (catimg)",
	quad: "quadrants ▚, 2×2 per cell (chafa)",
	sextant: "sextants 🬗, 2×3 per cell (chafa)",
	octant: "octants, 2×4 per cell; needs a recent font (chafa)",
	braille: "braille ⣿, 2×4 dots per cell (chafa)",
	ascii: "ASCII characters only (chafa)",
	pixels: "real pixels via Kitty graphics (kitty, Ghostty, WezTerm, herdr)",
};
export const parseStyle = (raw: unknown): ArtStyle =>
	typeof raw === "string" && (ART_STYLES as readonly string[]).includes(raw) ? (raw as ArtStyle) : "half";

/** `startupFetch` in settings.json; read per header build so edits apply on /reload. */
export function readConfig(file = settingsFile()): FetchConfig {
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(readFileSync(file, "utf-8")).startupFetch ?? {};
	} catch {}
	const image = typeof raw.image === "string" && raw.image ? raw.image.replace(/^~(?=\/|$)/, os.homedir()) : undefined;
	const h = Number(raw.height);
	return {
		mode: parseMode(raw.mode),
		image,
		style: parseStyle(raw.style),
		height: Number.isInteger(h) && h >= 4 && h <= 40 ? h : 13,
	};
}

/** The user's picture folder: `<agent dir>/images/` (gitignored). */
export const imagesDir = (base = agentDir()) => join(base, "images");
const stateFile = (base = agentDir()) => join(imagesDir(base), ".startup-fetch-state.json");

/**
 * Resolve this start's image to an absolute path (or a problem to report).
 * Advances the cycle / random state; call once per pi start.
 */
export function pickImage(cfg: FetchConfig, base = agentDir(), rand?: () => number): { path?: string; problem?: string } {
	if (cfg.mode === "off") return {};
	// An absolute path in "fixed" mode bypasses the folder entirely.
	if (cfg.mode === "fixed" && cfg.image && isAbsolute(cfg.image)) return { path: cfg.image };
	const dir = imagesDir(base);
	const images = listImages(dir);
	const state = readState(stateFile(base));
	const choice = chooseImage(images, cfg.mode, { fixed: cfg.image, last: state.last, rand });
	if (!choice.image) return { problem: choice.problem && `${choice.problem} (${dir})` };
	if (cfg.mode !== "fixed") writeState(stateFile(base), { last: choice.image });
	return { path: join(dir, choice.image) };
}

// The pick for this pi process. On globalThis so /reload (which re-imports
// this module) and /new keep showing the same picture; only a fresh pi start
// or /fetch advances it.
const PICK_KEY = Symbol.for("dotpi.startup-fetch.pick");
// `key` is the mode/image the pick was made for, so editing them + /reload
// re-picks; `warned` holds notices already shown for this pick (no repeat on
// every /new).
export type ImagePick = { path?: string; problem?: string; key: string; warned: Set<string> };
const pickStore = globalThis as unknown as Record<symbol, ImagePick | undefined>;

function currentPick(advance: boolean): ImagePick {
	const cfg = readConfig();
	const key = `${cfg.mode}\0${cfg.image ?? ""}`;
	const cur = pickStore[PICK_KEY];
	if (advance || !cur || cur.key !== key) pickStore[PICK_KEY] = { ...pickImage(cfg), key, warned: new Set() };
	return pickStore[PICK_KEY]!;
}

/** Notify once per pick. */
export function warnOnce(pick: ImagePick, notify: (m: string) => void, msg: string): void {
	if (pick.warned.has(msg)) return;
	pick.warned.add(msg);
	notify(msg);
}

/** Set `startupFetch.<key>` in settings.json, keeping the rest. (No temp+rename: kanban/publish.test.ts mocks renameSync suite-wide.) */
export function writeSetting(key: string, value: unknown, file = settingsFile()): boolean {
	try {
		const d = JSON.parse(readFileSync(file, "utf-8"));
		const cur = d.startupFetch;
		d.startupFetch = { ...(cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {}), [key]: value };
		writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
		return true;
	} catch {
		return false;
	}
}

// catimg wraps its output in cursor save/hide/show (CSI s, ?25l, ?25h); only
// SGR color sequences are safe inside a TUI line. Scoped to catimg's output —
// not a general sanitizer (OSC, ESC 7/8 are not handled).
const NON_SGR = /\x1b\[[0-9;?]*[A-Za-ln-z]/g;

/** catimg stdout → TUI-safe lines, each ending in a full SGR reset. */
export function cleanCatimg(stdout: string): string[] {
	return stdout
		.replace(NON_SGR, "")
		.split("\n")
		.filter((l) => visibleWidth(l) > 0)
		.map((l) => l + "\x1b[0m");
}

/** `name` on PATH, else ~/.local/bin (where scripts/install-*.sh put it; PATH may predate it). */
function findBin(name: string, prefixEnv: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (dir && existsSync(join(dir, name))) return name;
	}
	const local = join(process.env[prefixEnv] ?? join(os.homedir(), ".local"), "bin", name);
	return existsSync(local) ? local : undefined;
}

/** Max image width in columns, so a wide image cannot starve the info column. */
export const MAX_IMAGE_COLS = 40;

/** Rendered art: text lines (SGR only) or one graphics-protocol line. */
export interface Art {
	lines: string[];
	width: number;
	/** lines[0] carries a Kitty/iTerm2 image; the rest are blank rows under it. */
	graphic?: boolean;
}

const textArt = (lines: string[]): Art | undefined =>
	lines.length ? { lines, width: Math.max(...lines.map((l) => visibleWidth(l))) } : undefined;

/** First animation frame only: catimg redraws frames after CSI u (cursor restore). */
export const firstFrame = (stdout: string) => stdout.split("\x1b[u")[0];

type Exec = (bin: string, args: string[]) => Promise<{ stdout: string; code: number; killed?: boolean } | undefined>;

async function catimgArt(exec: Exec, image: string, rows: number, full: boolean): Promise<Art | undefined> {
	const bin = findBin("catimg", "CATIMG_PREFIX");
	if (!bin) throw new MissingTool("catimg", "scripts/install-catimg.sh");
	// -r 2: one cell = 1×2 pixels, -r 1: 1×1. -w/-H count pixels; catimg
	// honors the last size flag, so render by height, then width-capped if too wide.
	const px = full ? 1 : 2;
	const base = ["-l", "0", "-r", String(px), ...(truecolor() ? [] : ["-t"])];
	const run = async (size: string[]) => {
		const r = await exec(bin, [...base, ...size, image]);
		return r && r.code === 0 && !r.killed ? cleanCatimg(firstFrame(r.stdout)) : undefined;
	};
	let lines = await run(["-H", String(rows * px)]);
	if (lines?.some((l) => visibleWidth(l) > MAX_IMAGE_COLS)) lines = await run(["-w", String(MAX_IMAGE_COLS * px)]);
	return lines && textArt(lines);
}

async function chafaArt(exec: Exec, image: string, rows: number, symbols: string): Promise<Art | undefined> {
	const bin = findBin("chafa", "CHAFA_PREFIX");
	if (!bin) throw new MissingTool("chafa", "scripts/install-chafa.sh");
	const r = await exec(bin, [
		"-f", "symbols", `--symbols=${symbols}`, `--size=${MAX_IMAGE_COLS}x${rows}`,
		"--polite=on", "--animate=off", "-c", truecolor() ? "full" : "256", image,
	]);
	return r && r.code === 0 && !r.killed ? textArt(cleanCatimg(r.stdout)) : undefined;
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** Why `pixels` could not be used, for the fallback warning. */
type PixelResult = Art | { reason: string };

/**
 * Kitty-protocol image, downscaled to the panel size first (a photo would
 * otherwise be MBs of base64 per paint). iTerm2 is refused: its inline images
 * move the cursor and are erased by the text rows beside them, so the
 * side-by-side layout cannot hold one.
 */
async function pixelArt(image: string, rows: number, imageId: number): Promise<PixelResult> {
	const caps = getCapabilities();
	if (caps.images !== "kitty") {
		return { reason: caps.images === "iterm2" ? "iTerm2 inline images cannot sit beside the panel text" : "this terminal has no Kitty graphics support" };
	}
	const mime = MIME[extname(image).toLowerCase()];
	if (!mime) return { reason: `${extname(image)} cannot be sent as pixels (png, jpg, gif, webp only)` };
	const cell = getCellDimensions();
	const resized = await resizeImage(new Uint8Array(readFileSync(image)), mime, {
		maxWidth: MAX_IMAGE_COLS * cell.widthPx,
		maxHeight: rows * cell.heightPx,
	});
	if (!resized) return { reason: `could not decode ${basename(image)}` };
	let { data, mimeType } = resized;
	if (mimeType !== "image/png") {
		const png = await convertToPng(data, mimeType); // Kitty only takes PNG
		if (!png) return { reason: `could not convert ${basename(image)} to PNG` };
		({ data, mimeType } = png);
	}
	const dims = getImageDimensions(data, mimeType);
	const r = dims && renderImage(data, dims, { maxWidthCells: MAX_IMAGE_COLS, maxHeightCells: rows, imageId, moveCursor: false });
	if (!r) return { reason: "pi-tui could not encode the image" };
	// The sequence alone on row 0 (C=1: cursor stays, image paints downward);
	// the header puts no text on that row (see render), so pi's crop/redraw of
	// image lines never duplicates or clobbers info text.
	return { lines: [r.sequence, ...Array.from({ length: r.rows - 1 }, () => "")], width: r.columns, graphic: true };
}

class MissingTool extends Error {
	constructor(readonly tool: string, readonly script: string) {
		super(`${tool} is not installed — run: bash ${script}`);
	}
}

const CHAFA_SYMBOLS: Partial<Record<ArtStyle, string>> = {
	quad: "block+border+quad", sextant: "block+border+sextant", octant: "block+border+octant",
	braille: "braille", ascii: "ascii",
};

/**
 * Draw `image` in `style`. Falls back to catimg half blocks when the chosen
 * renderer is missing or unsupported here; reports why via `warn`. Undefined
 * means "keep the ASCII logo".
 */
export async function renderArt(
	exec: Exec,
	image: string,
	style: ArtStyle,
	rows: number,
	warn: (msg: string) => void,
	// Fixed on purpose: re-drawing reuses the id, so Kitty replaces the old upload.
	imageId = 0x5f7e7c,
): Promise<Art | undefined> {
	if (!existsSync(image)) {
		warn(`startup image not found: ${image}`);
		return undefined;
	}
	const half = () => catimgArt(exec, image, rows, false);
	try {
		if (style === "pixels") {
			const a: PixelResult = await pixelArt(image, rows, imageId).catch(() => ({ reason: `could not read ${basename(image)}` }));
			if ("lines" in a) return a;
			warn(`style "pixels": ${a.reason} — using half blocks`);
			return (await half()) ?? (warn(`could not draw ${basename(image)}`), undefined);
		}
		const sym = CHAFA_SYMBOLS[style];
		if (sym) {
			try {
				const a = await chafaArt(exec, image, rows, sym);
				if (a) return a;
				warn(`style "${style}": chafa could not draw ${basename(image)} (format not built in?) — using half blocks`);
			} catch (e) {
				if (!(e instanceof MissingTool)) throw e;
				warn(`style "${style}": ${e.message} — using half blocks`);
			}
			return (await half()) ?? (warn(`could not draw ${basename(image)}`), undefined);
		}
		const a = await catimgArt(exec, image, rows, style === "block");
		if (!a) warn(`could not draw ${basename(image)}`);
		return a;
	} catch (e) {
		warn(e instanceof MissingTool ? `a startup image is configured but ${e.message}` : `could not draw ${basename(image)}`);
		return undefined;
	}
}

/** Values captured once per header build, so render() stays cheap and the
 *  top-of-transcript lines don't change under the differential renderer. */
interface Snapshot {
	user: string;
	host: string;
	os: string;
	kernel: string;
	uptime: string;
	shell: string;
	terminal: string;
	cpu: string;
	memory: string;
	gpus?: string[];
	disks: [string, string][];
	cwd: string;
	model: string;
	branch?: string;
	update: UpdateState;
	/** pi's own startup notices (release + package updates), as of startup. */
	notices: Notices;
}

function snapshot(ctx: ExtensionContext): Snapshot {
	const cpus = os.cpus();
	const total = os.totalmem();
	const used = total - os.freemem();
	return {
		user: os.userInfo().username,
		host: os.hostname(),
		os: `${osName()} ${os.arch()}`,
		kernel: os.release(),
		uptime: fmtUptime(os.uptime()),
		shell: basename(process.env.SHELL ?? "unknown"),
		terminal: process.env.TERM_PROGRAM ?? process.env.TERM ?? "unknown",
		cpu: cpus.length ? `${cpus[0].model.replace(/\s+/g, " ").trim()} (${cpus.length})` : os.arch(),
		memory: `${gib(used)} GiB / ${gib(total)} GiB (${Math.round((used / total) * 100)}%)`,
		disks: diskRows(ctx.cwd),
		cwd: homeRel(ctx.cwd),
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none",
		update: { kind: "checking" },
		notices: {},
	};
}

/** Disk rows: the root filesystem, plus the cwd's when it is a different one. */
function diskRows(cwd: string): [string, string][] {
	const root = process.platform === "win32" ? (process.env.SystemDrive ?? "C:") + "\\" : "/";
	const rows: [string, string][] = [];
	const r = diskUsage(root);
	if (r) rows.push([`Disk (${root})`, r]);
	try {
		if (statSync(cwd).dev !== statSync(root).dev) {
			const c = diskUsage(cwd);
			if (c) rows.push([`Disk (${basename(cwd) || cwd})`, c]);
		}
	} catch {}
	return rows;
}

function updateText(theme: Theme, u: UpdateState): string {
	if ("kind" in u) return theme.fg("dim", "checking…");
	switch (u.status) {
		case "current":
			return theme.fg("success", "up to date");
		case "available":
			return theme.fg("warning", `⬆ ${u.latestVersion} available (see Updates)`);
		case "error":
			return theme.fg("dim", "unknown (check failed)");
	}
}

/**
 * The "Updates" block that replaces pi's own boxed update notices: a
 * section header, then one row per pending update. The pi row comes from
 * pi's own release check (with its release note), else from auto-update's
 * npm check. Empty when nothing is pending (or still checking).
 */
export function updateLines(theme: Theme, s: Pick<Snapshot, "update" | "notices">): string[] {
	const rows: string[] = [];
	const bullet = theme.fg("warning", "⬆");
	const cmd = (c: string) => `${theme.fg("dim", "· run")} ${theme.fg("accent", c)}`;
	const latest = s.notices.release?.version ?? (!("kind" in s.update) && s.update.status === "available" ? s.update.latestVersion : undefined);
	if (latest) {
		rows.push(`${bullet} ${theme.bold("pi")} ${theme.fg("dim", `v${VERSION} →`)} ${theme.fg("warning", latest)} ${cmd("pi update")}`);
		const note = s.notices.release?.note?.trim().split("\n")[0];
		if (note) rows.push(`  ${theme.fg("dim", truncateToWidth(note, 60))}`);
		rows.push(`  ${theme.fg("dim", "changelog: pi.dev/changelog")}`);
	}
	for (const p of s.notices.packages ?? []) rows.push(`${bullet} ${theme.bold(p)} ${cmd("pi update --extensions")}`);
	if (!rows.length) return [];
	return ["", `${theme.fg("warning", theme.bold("Updates"))} ${theme.fg("dim", "─".repeat(12))}`, ...rows];
}

function infoLines(theme: Theme, s: Snapshot): string[] {
	const title = `${theme.fg("accent", theme.bold(s.user))}@${theme.fg("accent", theme.bold(s.host))}`;
	const rule = theme.fg("dim", "─".repeat(visibleWidth(`${s.user}@${s.host}`)));
	const rows: [string, string][] = [
		["pi", `v${VERSION}`],
		["Update", updateText(theme, s.update)],
		["CWD", s.cwd + (s.branch ? theme.fg("dim", ` (${s.branch})`) : "")],
		["Model", s.model],
		["OS", s.os],
		["Kernel", s.kernel],
		["Uptime", s.uptime],
		["Shell", s.shell],
		["Terminal", s.terminal],
		["CPU", s.cpu],
		...(s.gpus ?? [undefined]).map((g, i, a): [string, string] => [a.length > 1 ? `GPU ${i + 1}` : "GPU", g ?? theme.fg("dim", "detecting…")]),
		["Memory", s.memory],
		...s.disks,
	];
	const swatch = [1, 2, 3, 4, 5, 6].map((c) => `\x1b[4${c}m   `).join("") + "\x1b[0m";
	return [
		title,
		rule,
		...rows.map(([k, v]) => `${theme.fg("accent", theme.bold(k))}${theme.fg("dim", ":")} ${v}`),
		...updateLines(theme, s),
		...(process.env.NO_COLOR ? [] : ["", swatch]),
	];
}


/**
 * Art beside info. A graphic (Kitty) row 0 carries only the image sequence —
 * pi-tui treats a line containing one as an image line (no clamp, cropped
 * when scrolled), so text there would be duplicated or lost; info starts on
 * row 1. Truncation applies to the text after the zero-width sequence only.
 */
export function layoutRows(art: string[], info: string[], gutter: number, graphic: boolean, width: number): string[] {
	const off = graphic ? 1 : 0;
	const out: string[] = [];
	for (let i = 0; i < Math.max(art.length, info.length + off); i++) {
		const l = art[i] ?? "";
		const text = info[i - off] ?? "";
		if (graphic) out.push(i === 0 ? l : truncateToWidth(" ".repeat(gutter) + text, width));
		else out.push(truncateToWidth(l + " ".repeat(Math.max(1, gutter - visibleWidth(l))) + text, width));
	}
	return out;
}

function setFetchHeader(pi: ExtensionAPI, ctx: ExtensionContext, force = false, advance = false): void {
	const pick = currentPick(advance);
	ctx.ui.setHeader((tui, theme) => {
		const snap = snapshot(ctx);
		const cfg = readConfig();
		const warn = (m: string) => warnOnce(pick, (x) => ctx.ui.notify(`startup-fetch: ${x}`, "warning"), m);
		if (pick.problem) warn(pick.problem);
		const ascii = renderLogo(logoKey(), !process.env.NO_COLOR);
		let art = ascii.lines;
		let gutter = ascii.width + 3;
		let graphic = false;
		let cache: { width: number; lines: string[] } | undefined;
		let disposed = false;
		const refresh = () => {
			if (disposed) return;
			cache = undefined;
			tui.requestRender();
		};
		// The image replaces the ASCII logo after first paint (it can change the
		// header's height; acceptable, like the update/branch fills).
		if (pick.path && !process.env.NO_COLOR) {
			const exec: Exec = (bin, args) => pi.exec(bin, args, { timeout: 3000 });
			renderArt(exec, pick.path, cfg.style, cfg.height, warn).then((img) => {
				if (!img || disposed) return;
				art = img.lines;
				graphic = !!img.graphic;
				gutter = img.width + 3;
				refresh();
			});
		}
		getUpdateStatus(pi, force).then((u) => {
			snap.update = u;
			refresh();
		});
		const offNotices = onNotices((n) => {
			snap.notices = n;
			refresh();
		});
		gpus(pi).then((g) => {
			snap.gpus = g;
			refresh();
		});
		gitBranch(pi, ctx.cwd).then((b) => {
			if (!b) return;
			snap.branch = b;
			refresh();
		});
		return {
			render(width: number): string[] {
				if (cache?.width === width) return cache.lines;
				const info = infoLines(theme, snap);
				let body: string[];
				if (width < gutter + 20) {
					// Too narrow: text only (a graphic would be overdrawn by it).
					body = info.map((r) => truncateToWidth(r, width));
				} else {
					body = layoutRows(art, info, gutter, graphic, width);
				}
				const lines = ["", ...body, ""];
				cache = { width, lines };
				return lines;
			},
			invalidate() {
				cache = undefined;
			},
			dispose() {
				disposed = true;
				offNotices();
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	// pi's boxed "Update Available" / "Package Updates Available" notices are
	// captured into the panel's Updates block. Patched at load time: pi starts
	// those checks right after extensions load (InteractiveMode.run).
	if (!process.env.PI_SUBAGENT_RUN_ID) captureNotices();
	pi.on("session_start", async (_event, ctx) => {
		// Subagent panes are fresh pi processes: they would advance the cycle and
		// run catimg for a header nobody looks at.
		if (ctx.mode !== "tui" || process.env.PI_SUBAGENT_RUN_ID) return;
		setFetchHeader(pi, ctx);
	});

	pi.registerCommand("fetch", {
		description:
			"Rebuild the startup header (next image, fresh update check). `/fetch list` · `/fetch style [name]` · `/fetch mode [fixed|cycle|random|off]`",
		getArgumentCompletions: (prefix: string) => {
			const words = [
				"list", "style", "mode",
				...ART_STYLES.map((s) => `style ${s}`),
				...IMAGE_MODES.map((m) => `mode ${m}`),
			];
			const items = words.filter((w) => w.startsWith(prefix)).map((w) => ({ value: w, label: w }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const [sub, arg] = args.trim().split(/\s+/);
			if (sub === "list") {
				const imgs = listImages(imagesDir());
				const cur = currentPick(false).path;
				const cfg = readConfig();
				const body = imgs.map((f) => (cur && basename(cur) === f ? `▸ ${f}` : `  ${f}`)).join("\n");
				ctx.ui.notify(
					imgs.length ? `${imagesDir()}  (mode ${cfg.mode}, style ${cfg.style}):\n${body}` : `no images in ${imagesDir()}`,
					"info",
				);
				return;
			}
			if (sub === "style" || sub === "mode") {
				const options: readonly string[] = sub === "style" ? ART_STYLES : IMAGE_MODES;
				let value = arg;
				if (!value) {
					const cur = readConfig()[sub];
					const labels = options.map((o) => `${o === cur ? "● " : "  "}${o}${sub === "style" ? ` — ${STYLE_HELP[o as ArtStyle]}` : ""}`);
					const chosen = await ctx.ui.select(`Startup image ${sub}`, labels);
					if (!chosen) return;
					value = options[labels.indexOf(chosen)];
				}
				if (!options.includes(value)) {
					ctx.ui.notify(`unknown ${sub} "${value}" — one of: ${options.join(", ")}`, "warning");
					return;
				}
				if (!writeSetting(sub, value)) {
					ctx.ui.notify(`could not write ${settingsFile()}`, "error");
					return;
				}
				setFetchHeader(pi, ctx, false, sub === "mode");
				ctx.ui.notify(`startupFetch.${sub} = ${value} (saved; scroll to top)`, "info");
				return;
			}
			if (sub) {
				ctx.ui.notify(`unknown /fetch argument "${sub}" — use: /fetch, /fetch list, /fetch style [name], /fetch mode [name]`, "warning");
				return;
			}
			setFetchHeader(pi, ctx, true, true);
			const p = currentPick(false).path;
			ctx.ui.notify(`Startup header refreshed${p ? ` — ${basename(p)}` : ""} (scroll to top)`, "info");
		},
	});

	pi.registerCommand("builtin-header", {
		description: "Restore pi's built-in startup header",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
		},
	});
}
