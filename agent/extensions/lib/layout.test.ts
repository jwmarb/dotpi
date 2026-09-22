/**
 * Tests for the repo layout module.
 *
 * The behaviour worth pinning is that there is now exactly ONE answer to "where
 * is the agent directory": six modules used to answer it four ways, and the
 * copies had already drifted (one resolved a relative override against the cwd,
 * which its own notes warned against, and expanded `~user` as if it were
 * home-relative). These tests fix the resolution against pi's own.
 */

import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import {
	agentDir,
	agentsDir,
	ENV_AGENT_DIR,
	envExampleFile,
	envFile,
	mcpConfigFile,
	repoRoot,
	runsDir,
	settingsFile,
	skillsDir,
} from "./layout.js";

const original = process.env[ENV_AGENT_DIR];

afterEach(() => {
	if (original === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = original;
});

describe("agentDir", () => {
	test("defaults to ~/.pi/agent", () => {
		delete process.env[ENV_AGENT_DIR];
		expect(agentDir()).toBe(path.join(os.homedir(), ".pi", "agent"));
	});

	test("honours an absolute override", () => {
		process.env[ENV_AGENT_DIR] = "/srv/pi/agent";
		expect(agentDir()).toBe("/srv/pi/agent");
	});

	test("expands a bare tilde and a ~/ prefix, exactly as pi does", () => {
		process.env[ENV_AGENT_DIR] = "~";
		expect(agentDir()).toBe(os.homedir());
		process.env[ENV_AGENT_DIR] = "~/elsewhere/agent";
		expect(agentDir()).toBe(path.join(os.homedir(), "elsewhere", "agent"));
	});

	test("leaves ~user alone rather than treating it as home-relative", () => {
		// pi's expandTildePath only handles `~` and `~/`. The old hand-rolled copy
		// in dotenv.ts sliced one character and so turned `~bob` into
		// `<home>/bob` — a real directory, silently the wrong one.
		process.env[ENV_AGENT_DIR] = "~bob/agent";
		expect(agentDir()).toBe("~bob/agent");
	});

	test("does not resolve a relative override against the cwd", () => {
		// This repo is a config directory that pi is launched from OTHER
		// projects, so the cwd is never the repo: resolving against it produced a
		// path that changed depending on where pi started.
		process.env[ENV_AGENT_DIR] = "rel/agent";
		expect(agentDir()).toBe("rel/agent");
		expect(agentDir()).not.toContain(process.cwd());
	});

	test("an empty override falls back rather than yielding an empty path", () => {
		process.env[ENV_AGENT_DIR] = "";
		expect(agentDir()).toBe(path.join(os.homedir(), ".pi", "agent"));
	});

	test("never throws, because top-level extension code imports this", () => {
		// pi's own getAgentDir() throws on an unset environment, which is why
		// dotenv.ts refused to use it: a throw at import time is a dead pi.
		for (const v of ["", "~", "/x", "rel"]) {
			process.env[ENV_AGENT_DIR] = v;
			expect(() => agentDir()).not.toThrow();
		}
		delete process.env[ENV_AGENT_DIR];
		expect(() => agentDir()).not.toThrow();
	});
});

describe("the files and directories inside it", () => {
	test("every path hangs off the one resolved agent directory", () => {
		process.env[ENV_AGENT_DIR] = "/srv/agent";
		expect(agentsDir()).toBe("/srv/agent/agents");
		expect(skillsDir()).toBe("/srv/agent/skills");
		expect(runsDir()).toBe("/srv/agent/subagent-runs");
		expect(envFile()).toBe("/srv/agent/.env");
		expect(envExampleFile()).toBe("/srv/agent/.env.example");
		expect(settingsFile()).toBe("/srv/agent/settings.json");
		expect(mcpConfigFile()).toBe("/srv/agent/mcp.json");
	});

	test("the repo root is the parent of the agent directory", () => {
		// `~/.pi` is the clone; `~/.pi/agent` is the configured tree.
		process.env[ENV_AGENT_DIR] = "/home/u/.pi/agent";
		expect(repoRoot()).toBe("/home/u/.pi");
	});

	test("relocating the agent directory moves every path with it", () => {
		process.env[ENV_AGENT_DIR] = "/a/one";
		const before = [agentsDir(), envFile(), runsDir()];
		process.env[ENV_AGENT_DIR] = "/b/two";
		const after = [agentsDir(), envFile(), runsDir()];
		for (const [i, p] of after.entries()) {
			expect(p).not.toBe(before[i]);
			expect(p.startsWith("/b/two")).toBe(true);
		}
	});
});
