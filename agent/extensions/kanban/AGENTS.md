# kanban — the orchestrator's board: single-writer state, settle guard, read-only side-pane viewer

Inventory row and the "not the old `plan` extension" rule live in `../AGENTS.md`; this file
covers what you need to know to change the module itself. Every `:NNN` below is a line number
measured 2026-10-28 in a file that is edited constantly: treat it as a hint, and grep for the
exported name when it misses.

## WHERE TO LOOK

| Question | Answer |
|---|---|
| Op semantics, id minting, note rules, caps | `lib.ts` `applyOp` (`:206`; pure reducer; `KanbanError` on refusal). Caps (`lib.ts:94-105`): `MAX_CARDS` 200, `MAX_TITLE` 200, `MAX_NOTE` 500, `MAX_RUNS_PER_CARD` 8, `MAX_ADD_PER_CALL` 20 — the last is restated **by hand** in `dynamic-prompt.ts`'s prose ("up to 20 titles per call") with nothing tying them at test time, so change both. (A test *does* pin the prose string — `lib/dynamic-prompt.test.ts:544` asserts the literal sentence, with the numeral hardcoded — so raising the cap fails nothing: it just makes that assertion's string stale-looking, which is exactly why prose and code drift here.) |
| How state survives reload/rewind | `lib.ts` `reconstructFromEntries` — replays the session branch (`kanban-state` custom entries + tool-result `details`) |
| Settle guard (holds the turn while cards are unaccounted for) | `lib.ts` `nudgeFor`/`settleSignature`/`actionableCards`; wired at `index.ts` `agent_before_settle` (`:761`), which stands down when `personaDenies("kanban")` is true (`:763`) — a profile that withholds the board withholds its enforcement with it, so an unaccounted board no longer holds the turn open |
| Pane open/adopt/close, projection publish | `index.ts` (`publish`, `replaceSync`, `findBun`) |
| The viewer process | `board.ts` (shebang, plain bun; args via `lib.ts` `parseBoardArgs`) |
| Linked-run badges | `runs.ts` — the only reader of `subagent-runs/<id>/meta.json`, via `../subagent-herdr/rundir.ts`, plus a bounded tail read of the run's session JSONL (32 KB → 512 KB → 4 MB ladder on a miss — the 4 MB top rung is the shared `EVIDENCE_TAIL_BYTES` from `../subagent-herdr/rundir.js`, the same cap the wake path's evidence read passes — a step that covers the file stops it — `size:mtimeMs`-stamped cache, dropped on both terminal paths incl. the `.exit` sidecar; every ladder miss arms a per-transcript `scannedTo` memo (offset + `size:mtimeMs` stamp) at a newline boundary: append-only growth re-scans only the appended region — a chunked read at `REGION_CHUNK_BYTES` (4 MB, equal to the cap by test), cut ONLY at newlines with a raw-byte carry so the boundary offset stays byte-exact (a lossy string carry drifts: replacement-char over-count moves the boundary backward, the safe bias, an under-count of invalid bytes forward — which would skip a snapshot line), peak memory bounded while lines fit ~3 chunks — the carry caps at 2 chunks and a longer line stops the scan at its start, so a line of at most 12 MiB - 1 is found once it closes while a line AT 12 MiB or beyond puts the newline outside the 12 MiB window and a snapshot behind it is invisible forever (measured max line 985 KiB (1,008,398 B), 2026-10-30); a snapshot deeper than the 4 MiB tail is visible for one poll per stamp change before the re-armed memo puts it off-board (recorded max gap from EOF ~2.7 MB, measured 2026-10-30, keeps that unreachable), and a zero-length read STOPS the scan at the line in flight — the loop cannot spin in a reader's loop (the board viewer at 1 s; pi on flush/liveness events) — and torn tails — including one line spanning several 4 MB chunks, whose start the offset keeps through the span — re-read whole from their line start; a SHRUNK file or a stamp that moves without the size moving (an equal-size sync restore) invalidates it; a restore that lands LONGER is indistinguishable from an append, so bytes below the offset are not re-scanned; bytes farther from EOF than the first read's 4 MB tail are never reached (recorded max gap from EOF ~2.7 MB, measured 2026-10-30)) for the child's live `todo` counts (`RunInfo.todos`), rendered under a live run's line by `lib.ts` `cardLines`/`compactLines` — advisory progress, never moves a card |
| Pane geometry (which side, how wide) | `lib.ts` `decideSplit` (`:977`) from the pane rect |
| `/kanban` argument parsing | `lib.ts` `parseCommand` (`:1095`) → `opFromParams` (`:1144`); board-process args `parseBoardArgs` (`:1206`, returns a `string` usage error) |
| What the pane draws (TUI + widget fallback) | `lib.ts` `renderFrame` (`:888`), `compactLines` (`:921`, capped at 8 cards), `fit`; the viewer contract is `board.ts`: watches the **directory** + polls at 1 s, alternate screen/raw mode/autowrap off, exits on `q`/Ctrl-C, on the owner pid dying, or when the runtime dir is removed (`board.ts:15-16`) — every exit path runs `restore()` (`board.ts:148`) |

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
