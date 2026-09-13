---
status: amended by ADR-0028
---

# A Mirror Pane displays a Run; it never owns it

> **Amended by [0028](./0028-tabs-close-on-reminder-runs-reopen-from-index.md).** The core decision stands — a Mirror Pane displays a Run and never owns it. What changed is the pane's lifetime: panes no longer linger after their Run ends, and the "reaped when the next Task starts" rule below was never implemented. A Task's Tab now closes when its Reminder is delivered, and finished Runs are reopened from the Run Index instead of being left on screen.

Each top-level **Run** gets a **Mirror Pane** in a **Tab** named for its **Task**. The subagent extension keeps spawning and owning the child `pi` process exactly as before — `--mode json`, parsed for the **Result**. The child is allocated a PTY via the system `script` utility, and its raw bytes are re-published on a per-Run socket; the Mirror Pane runs a thin client that replays those bytes to its terminal. Closing a Mirror Pane detaches the viewport and does nothing to the Run.

**Considered.** Letting *herdr own the run* (`herdr agent start` into a pane, driven by `agent prompt --wait`) is the obvious reading of "each subagent is an agent tab" and yields native `idle`/`working`/`blocked` states for free. It was rejected because the **Result** would then have to be scraped from terminal output — which herdr's own guidance warns is unrecoverable once an agent uses the alternate screen — and every downstream guarantee (turns, cost, stop reason, `<result>` extraction) currently rests on the parsed JSON stream. *Pane tails a PTY log file* was simpler but ties the transcript to a file we then have to reap. *Rendering the parsed event stream* instead of raw bytes was more legible but not a real terminal. *node-pty* was rejected to keep the extensions dir dependency-free; `script` costs portability instead, and this is a Linux machine.

**Consequences.** The Mirror Pane shows a raw JSON event stream — faithful, live, and ugly. A pane cannot adopt a PTY that another process created, which is the whole reason for the socket-and-replay indirection; anyone simplifying this later must re-derive that constraint. Nested Runs get no pane: only top-level Runs do, which falls out of the `HERDR_ENV` gate for free since children do not inherit a pane identity. Panes linger after their Run ends so their evidence survives, and are reaped when the next Task starts.

The shared module lives at `extensions/herdr/client.ts`, deliberately **not** `index.ts`: pi's extension discovery treats `extensions/<dir>/index.ts` as an extension entry point and requires a default-exported factory function. A plain library there fails the whole session at startup with "Extension does not export a valid factory function" — which is exactly what happened on first install. Shared libraries under `extensions/` must not be named `index.ts`.
