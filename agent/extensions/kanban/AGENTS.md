# kanban — the orchestrator's board: single-writer state, settle guard, read-only side-pane viewer

Inventory row and the "not the old `plan` extension" rule live in `../AGENTS.md`; this file
covers what you need to know to change the module itself.

## WHERE TO LOOK

| Question | Answer |
|---|---|
| Op semantics, id minting, note rules, caps | `lib.ts` `applyOp` (pure reducer; `KanbanError` on refusal) |
| How state survives reload/rewind | `lib.ts` `reconstructFromEntries` — replays the session branch (`kanban-state` custom entries + tool-result `details`) |
| Settle guard (holds the turn while cards are unaccounted for) | `lib.ts` `nudgeFor`/`settleSignature`/`actionableCards`; wired at `index.ts` `agent_before_settle` |
| Pane open/adopt/close, projection publish | `index.ts` (`publish`, `replaceSync`, `findBun`) |
| The viewer process | `board.ts` (shebang, plain bun; args via `lib.ts` `parseBoardArgs`) |
| Linked-run badges | `runs.ts` — the only reader of `subagent-runs/<id>/meta.json`, via `../subagent-herdr/rundir.ts` |
| Pane geometry | `lib.ts` `decideSplit` |

## CONVENTIONS

- **One writer.** `index.ts` (the orchestrator's pi) is the only thing that mutates state. `board.ts`
  only reads a disposable `projection.json` in `$XDG_RUNTIME_DIR/pi-kanban/<pid>-*` (tmpdir
  fallback). Never under `agent/`, because that is Nextcloud-synced. User edits go through `/kanban`, never through the pane.
- **Orchestrator only.** The factory returns immediately when `PI_SUBAGENT_RUN_ID` is set (children
  get `todo`); `gate.test.ts` pins it.
  `dynamic-prompt.ts`'s `## Kanban Board` section is gated on the tool being *offered* — this
  registration gate is what keeps the section out of a child's prompt, which is why the prompt
  adds no `isSubagent` check of its own.
- **No WIP limit.** Several cards may be `in_progress` (the opposite of `lib/todo.ts`).
- **Refuse, don't repair.** A blank note on `move` keeps the existing note (only the `note` op clears it);
  leaving `blocked` drops the stale blocker note. Run links are advisory badges. A card is never
  auto-moved.
- **`cleanText` strips C0/C1 (incl. ESC)** from titles/notes/agent names: they are model- or
  disk-originated and drawn into a raw terminal.
- `lib.ts` imports no pi runtime, only `@earendil-works/pi-tui` width helpers (via this dir's
  `tsconfig.json` `paths`; `typeRoots` borrows `../subagent-herdr/node_modules/@types`).

## COMMANDS

```sh
bun test agent/extensions/kanban/lib.test.ts agent/extensions/kanban/gate.test.ts
bun test agent/extensions/kanban/publish.test.ts   # alone: mock.module("node:fs") is process-wide
cd agent/extensions/kanban && ../subagent-herdr/node_modules/.bin/tsc -p tsconfig.json
```

## ANTI-PATTERNS

- Giving `board.ts` any write path (inbox, marker file, lock). That is the second writer the deleted
  `plan` extension needed, and it is the reason that extension is gone.
- File-watching `projection.json`. An atomic rename replaces the inode, so `board.ts` watches the
  **directory** and also polls every 1 s.
- Replacing `replaceSync` with a bare `rename`. Windows `fs.rename` throws EPERM while the target
  exists. `publish.test.ts` emulates that.
- Gating the settle guard on `event.context.canContinue` (it reads `false` at handler time).
- Treating a lower `revision` as stale in the viewer. A rewind lowers it legitimately. Only a lower
  projection `seq` is stale.
- Launching the pane with `execPath` under Pi-Bolt without `BUN_BE_BUN=1` (`findBun()`): the
  compiled pi parses the board's flags as its own and dies.
- Exiting `board.ts` without restoring the terminal (alt screen, cursor, raw mode, autowrap). A
  stranded alt screen looks like a dead pane.
