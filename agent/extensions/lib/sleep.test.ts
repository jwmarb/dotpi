import { describe, expect, test } from "bun:test";
import { MAX_TIMEOUT_SECONDS, sleepTool, validateTimeout } from "../sleep.js";

/** Real-time wait helper (this bun has no Bun.fakeTimers). */
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("validateTimeout", () => {
	test("returns ordinary positive values unchanged", () => {
		expect(validateTimeout(30)).toBe(30);
	});

	test("returns fractional seconds unchanged", () => {
		expect(validateTimeout(0.5)).toBe(0.5);
	});

	test("returns the exact upper boundary unchanged", () => {
		expect(validateTimeout(MAX_TIMEOUT_SECONDS)).toBe(MAX_TIMEOUT_SECONDS);
	});

	test("rejects undefined", () => {
		expect(() => validateTimeout(undefined)).toThrow();
	});

	test("rejects non-number values", () => {
		expect(() => validateTimeout("30")).toThrow();
		expect(() => validateTimeout(null)).toThrow();
	});

	test("rejects NaN and infinities", () => {
		expect(() => validateTimeout(Number.NaN)).toThrow();
		expect(() => validateTimeout(Number.POSITIVE_INFINITY)).toThrow();
		expect(() => validateTimeout(Number.NEGATIVE_INFINITY)).toThrow();
	});

	test("rejects zero and negative values", () => {
		expect(() => validateTimeout(0)).toThrow();
		expect(() => validateTimeout(-1)).toThrow();
	});

	test("rejects values above the limit", () => {
		expect(() => validateTimeout(MAX_TIMEOUT_SECONDS + 0.001)).toThrow();
	});
});

describe("sleepTool schema", () => {
	test("declares timeout as required, bounded (0, 3600]", () => {
		const schema = sleepTool.parameters as {
			properties: Record<string, { exclusiveMinimum?: number; maximum?: number }>;
			required?: string[];
		};
		expect(schema.properties.timeout).toBeDefined();
		expect(schema.required).toContain("timeout");
		expect(schema.properties.timeout.exclusiveMinimum).toBe(0);
		expect(schema.properties.timeout.maximum).toBe(MAX_TIMEOUT_SECONDS);
	});
});

describe("sleepTool.execute", () => {
	test("waits the full timeout, then terminates the turn", async () => {
		const start = Date.now();
		const promise = sleepTool.execute("call-1", { timeout: 0.1 }, undefined, undefined, {} as any);

		let settled = false;
		const done = promise.then((result) => {
			settled = true;
			return result;
		});
		await wait(40);
		expect(settled).toBe(false);

		const result = await done;
		expect(settled).toBe(true);
		expect(Date.now() - start).toBeGreaterThanOrEqual(95);
		expect(result.terminate).toBe(true);
		expect(result.isError).toBeUndefined();
		expect(result.details).toEqual({ timeout: 0.1, status: "completed" });
		const text = result.content[0] as { type: string; text: string };
		expect(text.type).toBe("text");
		expect(text.text).toContain("0.1");
	});

	test("settles promptly when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await sleepTool.execute("call-2", { timeout: 3600 }, controller.signal, undefined, {} as any);
		expect(result.isError).toBe(true);
		expect(result.terminate).toBeUndefined();
		expect(result.details).toEqual({ timeout: 3600, status: "interrupted" });
	});

	test("settles promptly when the signal aborts during the wait", async () => {
		const controller = new AbortController();
		const start = Date.now();
		const promise = sleepTool.execute(
			"call-3",
			{ timeout: 3600 },
			controller.signal,
			undefined,
			{} as any,
		);
		await wait(100);
		controller.abort();
		const result = await promise;
		expect(Date.now() - start).toBeLessThan(2000);
		expect(result.isError).toBe(true);
		expect(result.terminate).toBeUndefined();
		expect(result.details).toEqual({ timeout: 3600, status: "interrupted" });
	});

	test("rejects out-of-range timeouts before waiting", async () => {
		await expect(
			sleepTool.execute("call-4", { timeout: 0 } as any, undefined, undefined, {} as any),
		).rejects.toThrow();
		await expect(
			sleepTool.execute("call-5", { timeout: MAX_TIMEOUT_SECONDS + 1 } as any, undefined, undefined, {} as any),
		).rejects.toThrow();
		await expect(
			sleepTool.execute("call-6", { timeout: "30" } as any, undefined, undefined, {} as any),
		).rejects.toThrow();
	});
});

describe("sleepTool.renderResult", () => {
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

	const render = (result: { content: { type: string; text?: string }[]; details?: unknown }) =>
		(sleepTool.renderResult as any)(result, {}, theme).render(80).map((line: string) => line.trimEnd()).join(" ");

	test("shows raw text for pi's own error results (details: {})", () => {
		const out = render({
			content: [{ type: "text", text: "timeout must be at most 3600 seconds, got 7200" }],
			details: {},
		});
		expect(out).toBe("timeout must be at most 3600 seconds, got 7200");
	});

	test("shows raw text when details is missing", () => {
		const out = render({ content: [{ type: "text", text: "boom" }], details: undefined });
		expect(out).toBe("boom");
	});

	test("falls back to raw text for an unknown details shape", () => {
		const out = render({ content: [{ type: "text", text: "odd" }], details: { status: "weird" } });
		expect(out).toBe("odd");
	});

	test("styles a completed result", () => {
		const out = render({ content: [], details: { timeout: 30, status: "completed" } });
		expect(out).toContain("slept 30s");
		expect(out).toContain("turn ended");
	});

	test("styles an interrupted result", () => {
		const out = render({ content: [], details: { timeout: 5, status: "interrupted" } });
		expect(out).toContain("interrupted");
		expect(out).toContain("5s");
	});
});

describe("sleepTool.execute cleanup", () => {
	test("removes the abort listener after a natural finish", async () => {
		let registered = 0;
		let removed = 0;
		const signal = {
			aborted: false,
			addEventListener: () => {
				registered += 1;
			},
			removeEventListener: () => {
				removed += 1;
			},
		} as any;
		const result = await sleepTool.execute("call-7", { timeout: 0.05 }, signal, undefined, {} as any);
		expect(result.terminate).toBe(true);
		expect(registered).toBe(1);
		expect(removed).toBe(1);
	});

	test("removes the abort listener after an abort", async () => {
		const controller = new AbortController();
		let registered = 0;
		let removed = 0;
		const signal = {
			get aborted() {
				return controller.signal.aborted;
			},
			addEventListener: (ev: string, fn: () => void) => {
				registered += 1;
				controller.signal.addEventListener(ev, fn);
			},
			removeEventListener: (ev: string, fn: () => void) => {
				removed += 1;
				controller.signal.removeEventListener(ev, fn);
			},
		} as any;
		const promise = sleepTool.execute("call-8", { timeout: 3600 }, signal, undefined, {} as any);
		await wait(50);
		controller.abort();
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(registered).toBe(1);
		expect(removed).toBe(1);
	});

	test("clears the timer on both outcomes", async () => {
		const clearedIds: unknown[] = [];
		const realSetTimeout = globalThis.setTimeout;
		const realClearTimeout = globalThis.clearTimeout;
		let nextId = 0;
		const live = new Map<unknown, ReturnType<typeof realSetTimeout>>();
		const spySet = ((fn: () => void, ms?: number) => {
			const id = ++nextId;
			live.set(id, realSetTimeout(fn, ms));
			return id;
		}) as typeof setTimeout;
		const spyClear = ((id?: unknown) => {
			if (id !== undefined) clearedIds.push(id);
			const real = live.get(id);
			if (real !== undefined) {
				live.delete(id);
				realClearTimeout(real);
			}
		}) as typeof clearTimeout;
		globalThis.setTimeout = spySet;
		globalThis.clearTimeout = spyClear;
		try {
			// Natural finish clears its timer.
			const result = await sleepTool.execute("call-9", { timeout: 0.05 }, undefined, undefined, {} as any);
			expect(result.terminate).toBe(true);
			const afterFinish = [...clearedIds];
			expect(afterFinish).toHaveLength(1);

			// An abort clears the same timer instead of letting it run out.
			const controller = new AbortController();
			const promise = sleepTool.execute("call-10", { timeout: 3600 }, controller.signal, undefined, {} as any);
			realSetTimeout(() => controller.abort(), 50);
			const aborted = await promise;
			expect(aborted.isError).toBe(true);
			expect(clearedIds).toHaveLength(2);
			expect(clearedIds[1]).not.toBe(afterFinish[0]);
		} finally {
			globalThis.setTimeout = realSetTimeout;
			globalThis.clearTimeout = realClearTimeout;
		}
	});
});
