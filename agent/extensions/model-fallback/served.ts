/**
 * The router's chain as it was actually registered, for other extensions to read.
 *
 * ## Why this exists
 *
 * `startup-fetch`'s `Model` row has to name the chain the router is *serving*,
 * not a chain read from disk again. The router decides its chain once, when the
 * extension loads (`index.ts`, via `planRegistration`), and keeps it until the
 * next `/reload`. Anything that reads `settings.json` again can disagree with it:
 * after a settings edit with no reload, or while `ralph-loop`'s gate has
 * `PI_FALLBACK_CHAIN` swapped for a child it is spawning. A shared *function*
 * does not fix that, because the two sides would still call it at different
 * times. The router has to publish the value it actually used, and readers have
 * to read that value.
 *
 * ## Why `globalThis`, not a module export
 *
 * pi loads extensions with `moduleCache: false` (`core/extensions/loader.js`),
 * so every extension that imports this file gets its own copy of the module. A
 * module-level `let` would be one variable per importer, and the reader would
 * always see `undefined`. A `Symbol.for` key on `globalThis` is shared by the
 * whole process. `auto-update`'s status memo does the same thing for the same
 * reason.
 *
 * Holds only data and a predicate: no pi value at runtime (the `ExtensionContext`
 * import is type-only and erased), and nothing here can throw at load.
 *
 * @module model-fallback/served
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChainEntry } from "./lib.js";

/** The router as it was registered for this process: what it serves, and how it resolves. */
export interface ServedRouter {
	/** The chain passed to `registerVirtualModel`, in priority order. */
	readonly chain: readonly ChainEntry[];
	/**
	 * Whether the entry at `index` can serve a request on this machine. This is
	 * the router's own `resolve()`. Readers must not write their own, because a
	 * second resolver is how a display ends up naming a model pi cannot serve.
	 */
	readonly isReachable: (ctx: ExtensionContext, index: number) => boolean;
}

const KEY = Symbol.for("dotpi.model-fallback.served");
const store = globalThis as unknown as Record<symbol, ServedRouter | undefined>;

/**
 * Record what the router serves, or clear it with `undefined`.
 *
 * The router clears this at the start of every load and sets it only after
 * registering. So a `/reload` that turns the router off cannot leave the
 * previous load's chain behind for a reader to name.
 */
export function publishServedRouter(router: ServedRouter | undefined): void {
	store[KEY] = router;
}

/** What the router is serving, or `undefined` when it is not registered in this process. */
export function servedRouter(): ServedRouter | undefined {
	return store[KEY];
}
