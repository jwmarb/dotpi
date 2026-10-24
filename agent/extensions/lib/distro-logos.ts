/**
 * Neofetch-style ASCII distro logos for startup-fetch.ts.
 *
 * The art is generated with ascii-silhouettify
 * (https://meatfighter.com/ascii-silhouettify/) from the Simple Icons SVGs
 * (Windows: a hand-drawn 4-pane SVG): `npx ascii-silhouettify -i <svg> -m -s 8`
 * on a viewBox padded to -1 -1 26 26, trailing blanks/indent trimmed.
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
			"${c1}          ,",
			"${c1}         gg",
			"${c1}        @@@@",
			"${c1}       @@@@@L",
			"${c1}     ,[@@@@@@g",
			"${c1}    .[@@@@@@@@@_",
			"${c1}    g@@@@F B@@@@g",
			"${c1}   @@@@@\"   @@@@@j",
			"${c1}  @@@@@@    J@@@@A,",
			"${c1}g@D=            ==@_",
			"${c1}\"",
		],
	},
	debian: {
		colors: [[215, 10, 83], [215, 10, 83]],
		art: [
			"${c1}    _g@@@@@ggg_",
			"${c1}  J@@\"\"     \"@@@!",
			"${c1} @B      ~~   B@B",
			"${c1}@P    _y'      @|",
			"${c1}@     @]       @|",
			"${c1}@_    mg_____g@\"",
			"${c1} @L     \"\"%P\"",
			"${c1} \"@L",
			"${c1}  'Qg_",
			"${c1}    \"\"@j_",
		],
	},
	ubuntu: {
		colors: [[233, 84, 32], [233, 84, 32]],
		art: [
			"${c1}      _ggg@P _@@@g;",
			"${c1}    J@@@W\"\" |@@@@@|",
			"${c1}   BBB       T@@@F ~",
			"${c1}_gggg_            @@",
			"${c1}@@@@@@             @",
			"${c1}B@@@@B            _@",
			"${c1}  __]         ,_  @@",
			"${c1}   @@@__    |@@@@F\"\"",
			"${c1}    'Q@@@g__@@@@@@'",
			"${c1}       \"\"\"\" '[@@W\"",
		],
	},
	fedora: {
		colors: [[81, 162, 218], [81, 162, 218]],
		art: [
			"${c1}    _g@@@@@@@@@gg",
			"${c1}  _@@@@@@@@@@@@@@@1",
			"${c1} @@@@@@@@@T    B@@@@",
			"${c1}@@@@@@@@@] g@@@ @@@@",
			"${c1}@@@@@@@@@] @@@@@@@@@",
			"${c1}@@@@  _g@] ggg@@@@@@",
			"${c1}@@@ !@@@@] @@@@@@@@@",
			"${c1}@@@l '[@N\"_@@@@@@@@@",
			"${c1}@@@@@gggg@@@@@@@@@'",
			"${c1}@@@@@@@@@@@@@@@\"\"",
		],
	},
	nixos: {
		colors: [[126, 186, 228], [126, 186, 228]],
		art: [
			"${c1}    :gg   gg_ ;g",
			"${c1}    '[@@, \"@@@@@\"",
			"${c1}   @@@@@@@@@@@@  ~,",
			"${c1}    .[@@*   '4@gg@@",
			"${c1}@@@@@@@\"     '9@@@@@",
			"${c1}BB@@@@@g     ;g@@BBB",
			"${c1}  @@P\"9@g___!@@@___",
			"${c1}   \" ,&@@@@@@@@@@@!",
			"${c1}    :g@=@@g  'Q@g",
			"${c1}     '\"  \"\"   \"\"",
		],
	},
	gentoo: {
		colors: [[150, 140, 220], [150, 140, 220]],
		art: [
			"${c1}   __g@@@@@@gg_",
			"${c1}  @@@@@@@@@@@@@@_,",
			"${c1} @@@@@@@ @@@@@@@@@a",
			"${c1} @@@@@@@@@@@@@@@@@@@",
			"${c1}  \"\"@@@@@@@@@@@@@@f\"",
			"${c1}   _|@@@@@@@@@@@@@@B",
			"${c1} _@@@@@@@@@@@@\"_@P'",
			"${c1}_@@@@@@@@@@\".[@@\"",
			"${c1}@@D4P=Q@_ggP=",
			"${c1} \"@@@@@@\"\"'",
		],
	},
	linux: {
		colors: [[240, 190, 0], [240, 190, 0]],
		art: [
			"${c1}      _gggg_",
			"${c1}     @@@@@@@",
			"${c1}     @@BBB@@",
			"${c1}     @@gg=4@@",
			"${c1}   ,&@\"   '[@@,",
			"${c1}  :g@       [@@]",
			"${c1}  @@@       ,@@@!",
			"${c1} _\"[@_     [@@N\"|",
			"${c1}|    @g    [",
			"${c1}1___  @@@@@   _P\"",
		],
	},
	macos: {
		colors: [[220, 220, 220], [220, 220, 220]],
		art: [
			"${c1}         _g@@",
			"${c1}         @@@",
			"${c1}  .~~@~~~@L[@@~,",
			"${c1}_g@@@@@@@@@@@@@P'",
			"${c1}@@@@@@@@@@@@@@g\"",
			"${c1}@@@@@@@@@@@@@@g",
			"${c1}@@@@@@@@@@@@@@@j,",
			"${c1} @@@@@@@@@@@@@@@@",
			"${c1}  4@@@@@@@@@@@@@'",
			"${c1}  '[@@@@F\\@@@@W\"",
		],
	},
	windows: {
		colors: [[0, 120, 215], [0, 120, 215]],
		art: [
			"${c1}   _____  ggggg@@@@@",
			"${c1}@@@@@@@@g @@@@@@@@@@",
			"${c1}@@@@@@@@g @@@@@@@@@@",
			"${c1}@@@@@@@@g @@@@@@@@@@",
			"${c1}@@@@@@@@g @@@@@@@@@@",
			"${c1}@@@@@@@@g @@@@@@@@@@",
			"${c1}@@@@@@@@g @@@@@@@@@@",
			"${c1}@@@@@@@@g @@@@@@@@@@",
			"${c1}==4@@@@@g @@@@@@@@@@",
			"${c1}          \"\"\"\"\"@@@@@",
		],
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
