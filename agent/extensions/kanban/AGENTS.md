# kanban — the orchestrator's board: single-writer state, settle guard, read-only side-pane viewer

The inventory row is in `../AGENTS.md`. This file covers what you need to change the module itself.
Line refs were checked on 2026-10-31. The files change often, so grep for the exported name if a ref misses.

## WHERE TO LOOK

| Question | Answer |
|---|---|
| Op semantics, id minting, note rules | `lib.ts` `applyOp` (`:212`, pure: never mutates `prev`, throws `KanbanError` to refuse). Ops: add/move/note/rename/link/unlink/drop/clear_done/show. Column aliases (`todo`, `wip`, `doing`, …) are accepted for humans |
| Caps | `lib.ts:100-111`: `MAX_CARDS` 200, `MAX_TITLE` 200, `MAX_NOTE` 500, `MAX_RUNS_PER_CARD` 8, `MAX_ADD_PER_CALL` 20. The last is also written out by hand in `dynamic-prompt.ts:576` ("up to 20 titles per call"). The only link between them is a literal-string assertion in `lib/dynamic-prompt.test.ts:549`, so raising the cap fails nothing. Change all three together |
| How state survives reload/rewind | `lib.ts` `reconstructFromEntries` (`:392`) replays the session branch: tool-result `details.state` plus `kanban-state` custom entries from `/kanban`. A malformed newest snapshot is skipped in favour of the previous one. `index.ts` `repair()` re-appends when the digest differs |
| Settle guard | `lib.ts` `SETTLE_DISPOSITION` (`:587`, the one rule table) → `settleDisposition`/`actionableCards`/`settleSignature`/`nudgeFor` (`:686`). The nudge's move clauses come from `NUDGE_MOVE_TARGETS` (`:650`; a non-exempt target is a compile error), and the prompt sentence is `SETTLE_GUIDELINE` (`:613`), hand-written but tested against the table. Wired at `index.ts:762` (`agent_before_settle`). It acts only when `outcome === "completed"`, dedupes by signature (columns **and** run statuses), and stands down when `personaDenies("kanban")` (`:764`) |
| Who owes an action | Read `SETTLE_DISPOSITION`; in prose: done/blocked are exempt. A card whose linked run is positively `running` is exempt. in_progress is always actionable. backlog/review are exempt only while something else is waiting |
| Pane open/adopt/close, projection publish | `index.ts` (`publish`, `replaceSync`, `findBun`). The pane registry is process-global (`Symbol.for("pi.kanban.boards")`), so it survives `/reload` |
| No-pane fallback | `index.ts` uses a compact widget (no herdr, tiny pane, no bun, failed launch). `deactivateTool()` (`:403`) handles print/json sessions |
| The viewer process | `board.ts`: shebang, plain bun, args from `lib.ts` `parseBoardArgs` (`:1317`, returns a usage `string`, exit 2) |
| Linked-run badges + child `todo` counts | `runs.ts` is the only reader of `subagent-runs/<id>/meta.json` (through `../subagent-herdr/rundir.js`). `readRunTodos` opens the transcript once and `fstat`s it once; every decision uses that one fd and size. The pure steps are exported and tested directly: `memoDecision` (`:139`), `eofBoundary` (`:217`), `scanRegion` (`:278`), `readLadder` (`:377`, 32 KB → 512 KB → `EVIDENCE_TAIL_BYTES` 4 MB). It keeps a `size:mtimeMs` cache and an append-only `scannedTo` memo, and the counts come from `lib/todo.ts` `latestTodoCounts`. A `meta.json` whose status is not in `RUN_STATUSES` reads as `unknown`. The counts are advisory and never move a card |
| Pane geometry | `lib.ts` `decideSplit` (`:1088`) |
| `/kanban` parsing | `lib.ts` `parseCommand` (`:1206`) → `opFromParams` (`:1255`). Pane verbs: show/open/close/restart/help |
| What the pane draws | `lib.ts` `renderFrame` (`:994`), `compactLines` (`:1027`, max 8 cards). `board.ts` restores the terminal in `restore()` (`:148`) on every exit |
| Cross-extension events | `changed-files.ts` ↔ `CHANGED_FILES_EVENT`, `kanban:pane` (live flag), `lib/todo.ts` `RUN_TODOS_EVENT` |

## CONVENTIONS

- **One writer.** Only `index.ts` (the orchestrator's pi) mutates state. `board.ts` only reads a disposable
  `projection.json` in `$XDG_RUNTIME_DIR/pi-kanban/<pid>-*` (tmpdir fallback). It never lives under `agent/`,
  because that directory is synced by Nextcloud. User edits go through `/kanban`, never through the pane.
- **Parallel calls compose in call order.** Ops apply to the in-memory state synchronously, before any `await`.
  `/kanban` edits made while a response is streaming are deferred to the `turn_end` repair.
- **Orchestrator only.** The factory returns immediately when `PI_SUBAGENT_RUN_ID` is set, and `gate.test.ts`
  pins this. That gate is also what keeps `dynamic-prompt.ts`'s board section out of a child's prompt.
- **No WIP limit.** Several cards may be `in_progress` (unlike `lib/todo.ts`).
- **Refuse, don't repair.** `add` cannot target `blocked`. `move` to blocked requires a note. A blank note on
  `move` keeps the existing note, and leaving `blocked` drops the blocker note. Cards are never auto-moved.
  `nextId` only increases, so ids are never reused.
- **`cleanText` strips C0/C1 control characters (including ESC and `U+009B`)** from titles, notes and agent
  names, because they are drawn into a raw terminal.
- The run-id pattern `/^sub-[0-9a-f]{4}$/` (`lib.ts:91`) duplicates `subagent-herdr`'s and must stay strict,
  because it is joined into a path.
- `lib.ts` imports only `@earendil-works/pi-tui` width helpers plus a *type* from `../subagent-herdr/rundir.js`.

## COMMANDS

```sh
bun test agent/extensions/kanban/lib.test.ts agent/extensions/kanban/gate.test.ts
bun test agent/extensions/kanban/publish.test.ts   # alone: mock.module("node:fs") is process-wide
cd agent/extensions/kanban && ../subagent-herdr/node_modules/.bin/tsc -p tsconfig.json   # tests not in include
```

## ANTI-PATTERNS

- Giving `board.ts` any write path (inbox, marker, lock). That second writer is why the old `plan` extension was deleted.
- File-watching `projection.json`. An atomic rename replaces the inode, so the viewer watches the **directory** and also polls every 1 s.
- Replacing `replaceSync` with a bare `rename`. On Windows, `rename` throws EPERM while the target exists.
- Gating the settle guard on `event.context.canContinue`. It reads `false` at handler time.
- Treating a lower `revision` as stale in the viewer. A rewind lowers it legitimately, so only a lower projection `seq` is stale.
- Launching the pane with `execPath` under Pi-Bolt without `BUN_BE_BUN=1`. Pi-Bolt then parses the board's flags as its own and dies.
- Exiting `board.ts` without restoring the terminal (alt screen, cursor, raw mode, autowrap).
