/**
 * Ralph loop — container image provisioning for the runtime gate.
 *
 * The runtime verifier executes the project's own tests, which is arbitrary
 * code, so it runs in Docker rather than on the host. That requires an image
 * with the project's toolchain. This module produces one:
 *
 *  1. If the project ships a container definition (`Dockerfile`,
 *     `Dockerfile.dev`, `docker/Dockerfile`), build that — the project's own
 *     answer to "how do I run this" beats anything generated.
 *  2. Otherwise synthesise a Dockerfile from the manifests present
 *     (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, ...) and cache
 *     it out of tree, under `agent/verify-images/<slug>/`.
 *
 * Nothing is ever written into the user's project.
 *
 * ## Staleness
 *
 * The image tag embeds a hash of the manifests and the lockfiles. Change a
 * dependency and the tag changes, so the next run builds a fresh image; leave
 * them alone and every run reuses the cached one. This is correct by
 * construction rather than by TTL: the thing that invalidates a toolchain image
 * is a dependency change, so that is what the key is made of.
 *
 * Source files are deliberately NOT in the hash. The project is bind-mounted
 * read-only at run time, so ordinary code edits need no rebuild — measured:
 * editing a file on the host changes what the next container run executes.
 *
 * @module ralph-loop/image
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../lib/layout.js";

/** Container definitions a project might ship, in preference order. */
const PROJECT_DOCKERFILES = [
	"Dockerfile",
	"Dockerfile.dev",
	"Dockerfile.test",
	"docker/Dockerfile",
	".docker/Dockerfile",
] as const;

/**
 * Files whose contents key the image.
 *
 * Manifests and lockfiles: the inputs that decide what gets installed. A
 * lockfile change is the strongest possible signal that the toolchain moved.
 */
const MANIFESTS = [
	"package.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"pyproject.toml",
	"requirements.txt",
	"requirements-dev.txt",
	"poetry.lock",
	"uv.lock",
	"Pipfile",
	"Pipfile.lock",
	"Cargo.toml",
	"Cargo.lock",
	"go.mod",
	"go.sum",
	"Gemfile",
	"Gemfile.lock",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"composer.json",
	"mix.exs",
] as const;

/** How long an image build may run. Cold builds pull a base image. */
export const BUILD_TIMEOUT_MS = 600_000;

/**
 * Tag of the tracked reference base image.
 *
 * Built from `agent/docker/verify-base.Dockerfile` — a file in this repo, not a
 * generated artifact — and carries the browser plus the agent-browser CLI.
 * Project images `FROM` this when the project has a UI.
 */
export const REFERENCE_IMAGE = "ralph-verify/base:latest";

/** Filename of the reference Dockerfile inside `agent/docker/`. */
export const REFERENCE_DOCKERFILE = "verify-base.Dockerfile";

/** How long `docker` metadata queries may take. */
const DOCKER_QUERY_TIMEOUT_MS = 20_000;

/** Result of provisioning an image. */
export type ImageResult =
	| {
			ok: true;
			image: string;
			built: boolean;
			source: "project" | "generated";
			/** True when the image carries a browser, so the UI can be driven. */
			web: boolean;
	  }
	| { ok: false; reason: string };

/** Read a file, or undefined when absent/unreadable. */
async function tryRead(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

/** What the project declares about how it is built and tested. */
export interface ProjectProfile {
	/** Relative path of the project's own Dockerfile, when it has one. */
	dockerfile?: string;
	/** Manifest basenames found, in the order listed by MANIFESTS. */
	manifests: string[];
	/** Hash of every manifest's contents, plus the Dockerfile when present. */
	digest: string;
	/**
	 * Whether the project appears to have a browser UI, so the generated image
	 * should extend the browser-capable reference base.
	 */
	web: boolean;
}

/**
 * Inspect the project: does it ship a Dockerfile, which manifests exist, and
 * what is the content hash that keys its image.
 *
 * @param cwd Absolute project path.
 */
export async function profileProject(cwd: string): Promise<ProjectProfile> {
	const hash = createHash("sha256");
	let dockerfile: string | undefined;

	for (const candidate of PROJECT_DOCKERFILES) {
		const content = await tryRead(join(cwd, candidate));
		if (content !== undefined) {
			dockerfile = candidate;
			hash.update(`${candidate}\0${content}\0`);
			break;
		}
	}

	const manifests: string[] = [];
	let packageJson: string | undefined;
	for (const name of MANIFESTS) {
		const content = await tryRead(join(cwd, name));
		if (content !== undefined) {
			manifests.push(name);
			hash.update(`${name}\0${content}\0`);
			if (name === "package.json") packageJson = content;
		}
	}

	const web = detectsWebProject(packageJson);
	// The base image choice is part of what the image IS, so it belongs in the
	// digest: flipping a project web/non-web must produce a different tag.
	hash.update(`web=${web}\0`);

	return { dockerfile, manifests, digest: hash.digest("hex").slice(0, 16), web };
}

/**
 * Frameworks/tooling that mean "this project has a UI worth driving".
 *
 * Presence of any of these in `package.json` switches the generated image to the
 * browser-capable reference base, so the verifier can actually load the app.
 */
const WEB_MARKERS = [
	"next",
	"vite",
	"react",
	"react-dom",
	"vue",
	"svelte",
	"@sveltejs/kit",
	"nuxt",
	"astro",
	"remix",
	"@remix-run/react",
	"@angular/core",
	"solid-js",
	"qwik",
	"gatsby",
	"ember-source",
	"preact",
	"htmx.org",
	"@playwright/test",
	"cypress",
] as const;

/**
 * Whether a project looks like it has a browser UI.
 *
 * Read from `package.json` dependency names rather than guessing from file
 * layout: a dependency list is a declaration of intent, whereas the presence of
 * an `index.html` proves very little.
 *
 * @param packageJson Raw `package.json` contents, when the project has one.
 */
export function detectsWebProject(packageJson: string | undefined): boolean {
	if (!packageJson) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(packageJson);
	} catch {
		// Malformed package.json: fall back to a substring scan rather than
		// claiming the project has no UI.
		return WEB_MARKERS.some((marker) => packageJson.includes(`"${marker}"`));
	}
	const pkg = parsed as {
		dependencies?: Record<string, unknown>;
		devDependencies?: Record<string, unknown>;
		peerDependencies?: Record<string, unknown>;
	};
	const names = new Set([
		...Object.keys(pkg.dependencies ?? {}),
		...Object.keys(pkg.devDependencies ?? {}),
		...Object.keys(pkg.peerDependencies ?? {}),
	]);
	return WEB_MARKERS.some((marker) => names.has(marker));
}

/**
 * Docker COPY patterns for the Node manifests this project actually has.
 *
 * Docker fails the whole build when a non-glob COPY source is missing, and most
 * projects have exactly one lockfile. A glob that matches nothing is tolerated,
 * so every pattern returned here ends up glob-shaped (`package*.json`,
 * `pnpm-lock.yaml*`) rather than naming a file that may not exist.
 *
 * Measured: `COPY package*.json pnpm-lock.yaml yarn.lock bun.lock* ./` fails with
 * `"/yarn.lock": not found` on a project that only has package-lock.json.
 */
export function lockfilePatterns(profile: ProjectProfile): string[] {
	const patterns = ["package*.json"];
	for (const lock of ["pnpm-lock.yaml", "yarn.lock", "bun.lock"]) {
		if (profile.manifests.includes(lock)) patterns.push(`${lock}*`);
	}
	// bun.lockb is binary but shares the `bun.lock` prefix, so `bun.lock*` covers it.
	if (profile.manifests.includes("bun.lockb") && !patterns.includes("bun.lock*")) {
		patterns.push("bun.lock*");
	}
	return patterns;
}

/**
 * Choose a base image and install step from the manifests present.
 *
 * Two bases are possible:
 *
 *  - `ralph-verify/base` (the tracked reference image, `agent/docker/verify-base.Dockerfile`)
 *    for web projects, because the verifier needs a browser to drive the UI. It
 *    already carries Node 24, so a Node project needs no other toolchain.
 *  - a plain language image otherwise, because pulling a browser for a library
 *    with no UI is 1.5 GB of nothing.
 *
 * Deliberately conservative: install dependencies, do not try to build. The
 * verifier runs the project's declared test command, so the image needs a
 * toolchain, not a finished artifact. A generated Dockerfile that tries to be
 * clever fails on more projects than it helps.
 *
 * @param profile The project's manifests and whether it looks web-facing.
 * @param baseImage Tag of the reference base image, for web projects.
 * @returns Dockerfile text, or undefined when the ecosystem is unrecognised.
 */
export function synthesiseDockerfile(
	profile: ProjectProfile,
	baseImage = REFERENCE_IMAGE,
): string | undefined {
	const has = (name: string): boolean => profile.manifests.includes(name);
	const header = "# generated by ralph-loop for runtime verification";

	// Node. Copy manifests first so the dependency layer caches independently of
	// the source, then install with whichever lockfile the project actually uses.
	if (has("package.json")) {
		const install = has("pnpm-lock.yaml")
			? "corepack enable && pnpm install --frozen-lockfile"
			: has("yarn.lock")
				? "corepack enable && yarn install --frozen-lockfile"
				: has("bun.lock") || has("bun.lockb")
					? "npm i -g bun && bun install --frozen-lockfile"
					: has("package-lock.json")
						? "npm ci"
						: "npm install";
		// The reference base is already Node 24, so a web project needs no extra
		// language layer — it just inherits the browser.
		return [
			header,
			profile.web ? `FROM ${baseImage}` : "FROM node:22-slim",
			"WORKDIR /project",
			...(profile.web
				? []
				: [
						"RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*",
					]),
			// Only COPY lockfiles that exist: Docker fails the build on a missing
			// non-glob source, and `yarn.lock` etc. are usually absent. Globs that
			// match nothing are tolerated, so every pattern here must be a glob.
			`COPY ${lockfilePatterns(profile).join(" ")} ./`,
			`RUN ${install} || npm install`,
			"COPY . /project",
			'CMD ["true"]',
			"",
		].join("\n");
	}

	// Python. A Python project can still serve a UI (Django, Flask, FastAPI), in
	// which case the browser base gets Python layered on top of it.
	if (has("pyproject.toml") || has("requirements.txt") || has("Pipfile")) {
		const steps: string[] = [];
		if (has("requirements.txt")) {
			steps.push("pip install --no-cache-dir -r requirements.txt || true");
		}
		if (has("requirements-dev.txt")) {
			steps.push("pip install --no-cache-dir -r requirements-dev.txt || true");
		}
		if (has("pyproject.toml")) {
			// `.[dev]` first: test extras are where pytest usually lives.
			steps.push(
				"pip install --no-cache-dir -e '.[dev]' || pip install --no-cache-dir -e '.[test]' || pip install --no-cache-dir -e . || true",
			);
		}
		// pytest last so a project pinning its own version wins.
		steps.push("pip install --no-cache-dir pytest");
		return [
			header,
			profile.web ? `FROM ${baseImage}` : "FROM python:3.12-slim",
			"WORKDIR /project",
			profile.web
				? // The base is Debian-based, so Python comes from apt. `--break-system-packages`
					// is correct here and nowhere else: the container IS the virtualenv.
					"RUN apt-get update && apt-get install -y --no-install-recommends git build-essential python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/*"
				: "RUN apt-get update && apt-get install -y --no-install-recommends git build-essential ca-certificates && rm -rf /var/lib/apt/lists/*",
			"COPY . /project",
			// One RUN per step, each its own command. Chaining these with `&&` after
			// steps that end in `|| true` makes the precedence subtle enough to be a
			// bug: `a || true && b` parses left-associatively, so whether `b` runs
			// depends on the preceding fallback. Separate lines are unambiguous.
			...steps.map((step) =>
				profile.web
					? `RUN ${step.replace(/^pip install/, "pip install --break-system-packages")}`
					: `RUN ${step}`,
			),
			'CMD ["true"]',
			"",
		].join("\n");
	}

	if (has("Cargo.toml")) {
		return [
			header,
			"FROM rust:slim",
			"WORKDIR /project",
			"COPY . /project",
			"RUN cargo fetch || true",
			'CMD ["true"]',
			"",
		].join("\n");
	}

	if (has("go.mod")) {
		return [
			header,
			"FROM golang:alpine",
			"WORKDIR /project",
			"RUN apk add --no-cache git build-base",
			"COPY . /project",
			"RUN go mod download || true",
			'CMD ["true"]',
			"",
		].join("\n");
	}

	if (has("Gemfile")) {
		return [
			header,
			"FROM ruby:slim",
			"WORKDIR /project",
			"RUN apt-get update && apt-get install -y --no-install-recommends git build-essential && rm -rf /var/lib/apt/lists/*",
			"COPY . /project",
			"RUN bundle install || true",
			'CMD ["true"]',
			"",
		].join("\n");
	}

	return undefined;
}

/**
 * Derive a filesystem- and Docker-safe slug from an absolute project path.
 *
 * Docker tags allow only `[a-z0-9._-]`, so anything else collapses to `-`. A
 * short path hash is appended because two different checkouts can share a
 * basename (`~/work/api` and `~/tmp/api` must not share an image).
 */
export function projectSlug(cwd: string): string {
	const base = (cwd.split("/").filter(Boolean).pop() ?? "project")
		.toLowerCase()
		.replace(/[^a-z0-9._-]/g, "-")
		.replace(/^[._-]+/, "")
		.slice(0, 32);
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
	return `${base || "project"}-${hash}`;
}

/** The image tag for a project + manifest digest. */
export function imageTag(cwd: string, digest: string): string {
	return `ralph-verify/${projectSlug(cwd)}:${digest}`;
}

/** Whether an image already exists locally. */
async function imageExists(pi: ExtensionAPI, tag: string): Promise<boolean> {
	try {
		const r = await pi.exec("docker", ["image", "inspect", tag], {
			timeout: DOCKER_QUERY_TIMEOUT_MS,
		});
		return r.code === 0;
	} catch {
		return false;
	}
}

/** Whether the Docker daemon is reachable. */
export async function dockerAvailable(pi: ExtensionAPI): Promise<boolean> {
	try {
		const r = await pi.exec("docker", ["version", "--format", "{{.Server.Version}}"], {
			timeout: DOCKER_QUERY_TIMEOUT_MS,
		});
		return r.code === 0 && r.stdout.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * Build the tracked reference base image if it is not already present.
 *
 * The reference Dockerfile lives in this repo (`agent/docker/`), so it is the one
 * image the gate *owns* rather than generates. It is built on demand and then
 * reused: web projects `FROM` it, so it is built once and shared across every
 * project verified on this machine.
 *
 * Never throws; returns a reason on failure so the caller can turn it into an
 * `inconclusive` verdict.
 *
 * @param pi Extension API, for `exec`.
 * @param onProgress Status callback — this build pulls Chrome and is slow cold.
 */
export async function ensureReferenceImage(
	pi: ExtensionAPI,
	onProgress?: (message: string) => void,
): Promise<{ ok: true; built: boolean } | { ok: false; reason: string }> {
	if (await imageExists(pi, REFERENCE_IMAGE)) {
		return { ok: true, built: false };
	}

	const dir = join(agentDir(), "docker");
	const dockerfile = join(dir, REFERENCE_DOCKERFILE);

	onProgress?.("building browser base image");

	try {
		const r = await pi.exec(
			"docker",
			["build", "-f", dockerfile, "-t", REFERENCE_IMAGE, "--", dir],
			{ timeout: BUILD_TIMEOUT_MS },
		);
		if (r.killed) {
			return {
				ok: false,
				reason: `the reference image build timed out after ${Math.round(BUILD_TIMEOUT_MS / 60_000)} minutes`,
			};
		}
		if (r.code !== 0) {
			return {
				ok: false,
				reason: `the reference image build failed:\n${lastMeaningfulLines(r.stderr || r.stdout, 6)}`,
			};
		}
	} catch (err) {
		return {
			ok: false,
			reason: `could not build the reference image (${err instanceof Error ? err.message : String(err)})`,
		};
	}

	return { ok: true, built: true };
}

/**
 * Ensure an image exists for this project, building one if needed.
 *
 * Reuses a cached image whenever the manifest digest is unchanged, so the cost
 * is paid once per dependency set rather than once per audit.
 *
 * Never throws: every failure is an `{ ok: false, reason }`, because the caller
 * turns that into an `inconclusive` verdict and a clean stop.
 *
 * @param pi Extension API, for `exec`.
 * @param cwd Absolute project path.
 * @param onProgress Optional status callback for the footer.
 */
export async function ensureImage(
	pi: ExtensionAPI,
	cwd: string,
	onProgress?: (message: string) => void,
): Promise<ImageResult> {
	if (!(await dockerAvailable(pi))) {
		return {
			ok: false,
			reason: "the Docker daemon is not reachable (runtime verification needs it)",
		};
	}

	const profile = await profileProject(cwd);
	const tag = imageTag(cwd, profile.digest);
	const source = profile.dockerfile ? "project" : "generated";

	if (await imageExists(pi, tag)) {
		return { ok: true, image: tag, built: false, source, web: profile.web };
	}

	// A generated web image does `FROM ralph-verify/base`, so the base has to exist
	// first. A project shipping its own Dockerfile is responsible for its own base,
	// so this is skipped there.
	if (profile.web && !profile.dockerfile) {
		const base = await ensureReferenceImage(pi, onProgress);
		if (!base.ok) return { ok: false, reason: base.reason };
	}

	// Build context is always the project; only the Dockerfile's location differs.
	let dockerfilePath: string;
	if (profile.dockerfile) {
		dockerfilePath = join(cwd, profile.dockerfile);
	} else {
		const generated = synthesiseDockerfile(profile);
		if (!generated) {
			return {
				ok: false,
				reason:
					profile.manifests.length === 0
						? "no dependency manifest found, so no image could be generated (add a Dockerfile to enable runtime verification)"
						: `no image recipe for this project type (found ${profile.manifests.join(", ")})`,
			};
		}
		// Cached out of tree: generating into the project would write a file the
		// user never asked for.
		const dir = join(agentDir(), "verify-images", projectSlug(cwd));
		try {
			await mkdir(dir, { recursive: true });
			dockerfilePath = join(dir, "Dockerfile");
			await writeFile(dockerfilePath, generated, "utf8");
		} catch (err) {
			return {
				ok: false,
				reason: `could not stage a generated Dockerfile (${err instanceof Error ? err.message : String(err)})`,
			};
		}
	}

	onProgress?.(source === "project" ? "building project image" : "building image");

	try {
		const r = await pi.exec(
			"docker",
			["build", "-f", dockerfilePath, "-t", tag, "--", cwd],
			{ cwd, timeout: BUILD_TIMEOUT_MS },
		);
		if (r.killed) {
			return {
				ok: false,
				reason: `the image build timed out after ${Math.round(BUILD_TIMEOUT_MS / 60_000)} minutes`,
			};
		}
		if (r.code !== 0) {
			const detail = lastMeaningfulLines(r.stderr || r.stdout, 6);
			return { ok: false, reason: `the image build failed:\n${detail}` };
		}
	} catch (err) {
		return {
			ok: false,
			reason: `the image build could not start (${err instanceof Error ? err.message : String(err)})`,
		};
	}

	return { ok: true, image: tag, built: true, source, web: profile.web };
}

/**
 * Last few non-blank lines of build output — where the actual error is.
 *
 * Docker build logs are long and the useful part is at the end; this keeps a
 * notification readable.
 */
export function lastMeaningfulLines(text: string, count: number): string {
	return (text ?? "")
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0)
		.slice(-count)
		.join("\n");
}
