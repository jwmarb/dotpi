/**
 * Small neofetch-style ASCII distro logos for startup-fetch.ts.
 *
 * Art uses `${c1}` / `${c2}` markers to switch between a logo's two brand
 * colors (truecolor RGB). Pure: no fs, no theme — the caller picks the key
 * (from /etc/os-release `ID` / `ID_LIKE`, or `os.platform()`).
 */

type RGB = [number, number, number];

interface Logo {
	colors: [RGB, RGB];
	art: string[];
}

const LOGOS: Record<string, Logo> = {
	arch: {
		colors: [[23, 147, 209], [23, 147, 209]],
		art: [
			"${c1}       /\\",
			"${c1}      /  \\",
			"${c1}     /\\   \\",
			"${c1}    /      \\",
			"${c1}   /   ,,   \\",
			"${c1}  /   |  |  -\\",
			"${c1} /_-''    ''-_\\",
		],
	},
	debian: {
		colors: [[215, 10, 83], [215, 10, 83]],
		art: [
			"${c1}  _____",
			"${c1} /  __ \\",
			"${c1}|  /    |",
			"${c1}|  \\___-",
			"${c1}-_",
			"${c1}  --_",
		],
	},
	ubuntu: {
		colors: [[233, 84, 32], [255, 255, 255]],
		art: [
			"${c1}         _",
			"${c1}     ---(_)",
			"${c1} _/  ---  \\",
			"${c1}(_) |   |",
			"${c1}  \\  --- _/",
			"${c1}     ---(_)",
		],
	},
	fedora: {
		colors: [[81, 162, 218], [255, 255, 255]],
		art: [
			"${c1}      _____",
			"${c1}     /   __)${c2}\\",
			"${c1}     |  /  ${c2}\\ \\",
			"${c2}  __${c1}_|  |_${c2}_/ /",
			"${c2} / ${c1}(_    _)${c2}_/",
			"${c2}/ /  ${c1}|  |",
			"${c2}\\ \\${c1}__/  |",
			"${c2} \\${c1}(_____/",
		],
	},
	nixos: {
		colors: [[126, 186, 228], [82, 119, 195]],
		art: [
			"${c1}  \\\\  \\\\ //",
			"${c1} ==\\\\__\\\\/ ${c2}//",
			"${c2}   //   \\\\${c2}//",
			"${c2}==//     //==",
			"${c1} //\\\\${c1}___${c2}//",
			"${c1}// /\\\\  \\\\==",
			"${c1}  // \\\\  \\\\",
		],
	},
	gentoo: {
		colors: [[84, 72, 135], [221, 218, 236]],
		art: [
			"${c1} _-----_",
			"${c1}(       \\",
			"${c1}\\    0   \\",
			"${c2} \\        )",
			"${c2} /      _/",
			"${c2}(     _-",
			"${c2}\\____-",
		],
	},
	linux: {
		colors: [[200, 200, 200], [240, 190, 0]],
		art: [
			"${c1}    ___",
			"${c1}   (${c2}.. ${c1}\\",
			"${c1}   (${c2}<> ${c1}|",
			"${c1}  /${c2}/  \\ ${c1}\\",
			"${c1} ( ${c2}|  | ${c1}/|",
			"${c2}_${c1}/\\ ${c2}__)${c1}/${c2}_${c1})",
			"${c2}\\/${c1}-____${c2}\\/",
		],
	},
	macos: {
		colors: [[95, 185, 80], [165, 70, 160]],
		art: [
			"${c1}        .:'",
			"${c1}    __ :'__",
			"${c1} .'`  `-'  ``.",
			"${c2}:          .-'",
			"${c2}:         :",
			"${c2} :         `-;",
			"${c2}  `.__.-.__.'",
		],
	},
	windows: {
		colors: [[0, 120, 215], [0, 120, 215]],
		art: [
			"${c1}################  ################",
			"${c1}################  ################",
			"${c1}################  ################",
			"",
			"${c1}################  ################",
			"${c1}################  ################",
			"${c1}################  ################",
		].map((l) => l.replace(/#{16}/g, "#######")),
	},
};

/** Distro aliases → logo key (derivatives share their parent's logo). */
const ALIASES: Record<string, string> = {
	endeavouros: "arch",
	manjaro: "arch",
	cachyos: "arch",
	garuda: "arch",
	"linuxmint": "ubuntu",
	pop: "ubuntu",
	raspbian: "debian",
	darwin: "macos",
	win32: "windows",
};

/** First candidate with a logo wins; falls back to Tux. */
export function pickLogo(candidates: string[]): string {
	for (const raw of candidates) {
		const k = raw.toLowerCase();
		const key = LOGOS[k] ? k : ALIASES[k];
		if (key && LOGOS[key]) return key;
	}
	return "linux";
}

/**
 * Truecolor support, shared by the ASCII logo and the catimg image so both
 * agree. COLORTERM is the standard signal; Windows Terminal (WT_SESSION) and
 * the common truecolor terminals don't always export it.
 */
export function truecolor(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return true;
	if (env.WT_SESSION) return true;
	return /^(iTerm\.app|WezTerm|vscode|ghostty)$/.test(env.TERM_PROGRAM ?? "") || /kitty|alacritty|foot|ghostty/.test(env.TERM ?? "");
}

/** Nearest xterm-256 cube color, for terminals without truecolor. */
function to256([r, g, b]: RGB): number {
	const c = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
	return 16 + 36 * c(r) + 6 * c(g) + c(b);
}

const fg = (rgb: RGB, tc: boolean) => (tc ? `\x1b[38;2;${rgb.join(";")}m` : `\x1b[38;5;${to256(rgb)}m`);
const RESET = "\x1b[39m";

/**
 * Colored logo lines plus their visible width. `color: false` strips markers
 * (for NO_COLOR). Every line ends with a foreground reset so color never
 * leaks into the info column.
 */
export function renderLogo(key: string, color = true, tc = truecolor()): { lines: string[]; width: number } {
	const logo = LOGOS[key] ?? LOGOS.linux;
	const plain = logo.art.map((l) => l.replace(/\$\{c[12]\}/g, ""));
	const width = Math.max(...plain.map((l) => l.length));
	if (!color) return { lines: plain, width };
	const lines = logo.art.map(
		(l) => l.replace(/\$\{c1\}/g, fg(logo.colors[0], tc)).replace(/\$\{c2\}/g, fg(logo.colors[1], tc)) + RESET,
	);
	return { lines, width };
}

export const LOGO_KEYS = Object.keys(LOGOS);
