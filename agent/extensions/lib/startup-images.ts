/**
 * Image selection for startup-fetch.ts: which file in `agent/images/` the
 * startup panel shows.
 *
 * Modes (`settings.json` `startupFetch.mode`):
 *   - "fixed"  — always `startupFetch.image` (a file name inside images/)
 *   - "cycle"  — the next image (sorted by name) on each pi start, wrapping
 *   - "random" — a random image on each pi start, avoiding an immediate repeat
 *   - "off"    — no image; the ASCII distro logo
 *
 * Pure apart from `listImages` / the state helpers, which take explicit paths
 * so tests can point them at a temp dir.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

export type ImageMode = "fixed" | "cycle" | "random" | "off";
export const IMAGE_MODES: readonly ImageMode[] = ["fixed", "cycle", "random", "off"];

/** What catimg (stb_image) can decode. */
const EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tga", ".psd", ".pnm", ".ppm", ".pgm"]);

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/** Image file names in `dir`, sorted (case-insensitive) — the cycle order. */
export function listImages(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((f) => !f.startsWith(".") && EXTS.has(extname(f).toLowerCase()))
			.filter((f) => {
				try {
					return statSync(join(dir, f)).isFile(); // a broken symlink only hides itself
				} catch {
					return false;
				}
			})
			.sort(byName);
	} catch {
		return [];
	}
}

/** Persisted between pi starts: the last image shown (by name, so adding or
 *  removing files does not derail the cycle). */
export interface ImageState {
	last?: string;
}

export function readState(file: string): ImageState {
	try {
		const s = JSON.parse(readFileSync(file, "utf-8"));
		return typeof s?.last === "string" ? { last: s.last } : {};
	} catch {
		return {};
	}
}

export function writeState(file: string, state: ImageState): void {
	try {
		writeFileSync(file, JSON.stringify(state) + "\n");
	} catch {
		// Read-only agent dir: cycling degrades to "first image", never an error.
	}
}

export interface Choice {
	/** File name inside images/, or undefined for "show the ASCII logo". */
	image?: string;
	/** Why there is no image, for a one-line notice. */
	problem?: string;
}

/**
 * Pick the image for this start. `rand` is injectable for tests
 * (returns [0, 1) like Math.random).
 */
export function chooseImage(
	images: string[],
	mode: ImageMode,
	opts: { fixed?: string; last?: string; rand?: () => number } = {},
): Choice {
	if (mode === "off") return {};
	// Empty folder: quiet ASCII fallback, except when a specific file was asked for.
	if (images.length === 0) return mode === "fixed" && opts.fixed ? { problem: `startupFetch.image "${opts.fixed}" is not in the images/ folder` } : {};

	if (mode === "fixed") {
		if (!opts.fixed) return { image: images[0] };
		const hit = images.find((f) => f === opts.fixed) ?? images.find((f) => f.toLowerCase() === opts.fixed!.toLowerCase());
		return hit ? { image: hit } : { problem: `startupFetch.image "${opts.fixed}" is not in the images/ folder` };
	}

	if (mode === "cycle") {
		const i = opts.last ? images.indexOf(opts.last) : -1;
		if (i >= 0) return { image: images[(i + 1) % images.length] };
		// Last one was deleted (or first run): continue from where it would sort.
		const next = opts.last ? images.findIndex((f) => byName(f, opts.last!) > 0) : 0;
		return { image: images[next < 0 ? 0 : next] };
	}

	// random — never the same image twice in a row when there is a choice.
	const rand = opts.rand ?? Math.random;
	const pool = images.length > 1 && opts.last ? images.filter((f) => f !== opts.last) : images;
	return { image: pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))] };
}

export function parseMode(raw: unknown): ImageMode {
	return typeof raw === "string" && (IMAGE_MODES as readonly string[]).includes(raw) ? (raw as ImageMode) : "fixed";
}
