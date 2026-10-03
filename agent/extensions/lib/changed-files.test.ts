/**
 * The `git status --porcelain` grammar behind the session change widget.
 *
 * `changed-files.ts` is a top-level extension, so its tests live here (pi
 * auto-loads every top-level `*.ts`, and a `bun:test` import there is
 * startup-fatal). Importing it from `lib/` is fine and always was — see the
 * CONVENTIONS note in `agent/extensions/AGENTS.md`.
 *
 * Only the decoder is exported. Invocation stays private on purpose: the four
 * `git` call sites in this repo share no error contract worth unifying (see that
 * file's ANTI-PATTERNS), but a *grammar* is exactly the kind of thing that wants
 * tests, and this one was carrying two real bugs when these were written:
 *
 *   1. **The XY field was read as one code.** Porcelain's status is two columns
 *      (X = index, Y = worktree), so a staged delete is `"D "`. The map is keyed
 *      on the single letter `"D"`, and the lookup passed `line.slice(0, 2)`.
 *      Every key except `??` missed, and the `?? "modified"` fallback swallowed
 *      it: staged adds, deletes and renames all rendered as "modified" with
 *      nothing anywhere to suggest a bug.
 *   2. **` -> ` was treated as a rename delimiter.** It is also a legal
 *      substring of a filename, and the newline form quotes paths with spaces or
 *      non-ASCII bytes, so both the split and the path were ambiguous.
 *
 * Both are fixed by reading `-z` records instead of lines. The fixtures below are
 * byte-for-byte what git emits (verified against a real repository), because a
 * hand-tidied fixture is how a parser passes its tests and fails in production.
 *
 * Run: `bun test agent/extensions/lib/changed-files.test.ts`
 */
import { describe, expect, test } from "bun:test";

import { parseGitStatusOutput } from "../changed-files.js";

/** Build `-z` output: every record is NUL-*terminated*, as git writes it. */
function z(...records: string[]): string {
  return records.map((r) => `${r}\0`).join("");
}

/** `status:path` pairs in report order — the shape assertions read best against. */
function decode(output: string): string[] {
  return [...parseGitStatusOutput(output).values()].map((f) => `${f.status}:${f.path}`);
}

describe("the XY status field", () => {
  // The regression that motivated this file. Each of these rendered as
  // "modified" before the decoder read X and Y as separate columns.
  test("a staged delete is deleted, not modified", () => {
    expect(decode(z("D  a.txt"))).toEqual(["deleted:a.txt"]);
  });

  test("a staged add is created, not modified", () => {
    expect(decode(z("A  d.txt"))).toEqual(["created:d.txt"]);
  });

  test("a staged modification is modified", () => {
    expect(decode(z("M  m.txt"))).toEqual(["modified:m.txt"]);
  });

  test("an unstaged modification is modified", () => {
    expect(decode(z(" M e.txt"))).toEqual(["modified:e.txt"]);
  });

  test("an unstaged delete is deleted", () => {
    // Y carries the status when X is blank.
    expect(decode(z(" D gone.txt"))).toEqual(["deleted:gone.txt"]);
  });

  test("untracked is untracked", () => {
    expect(decode(z("?? c.txt"))).toEqual(["untracked:c.txt"]);
  });

  test("the index column wins when both columns are set", () => {
    // `AM` = added to the index, then modified in the worktree. A commit now
    // records an addition, so that is what the widget should say.
    expect(decode(z("AM both.txt"))).toEqual(["created:both.txt"]);
    expect(decode(z("MD half.txt"))).toEqual(["modified:half.txt"]);
  });

  test("a type change reads as modified", () => {
    expect(decode(z("T  link.txt"))).toEqual(["modified:link.txt"]);
  });

  test("an unmerged file reads as modified rather than vanishing", () => {
    // `UU` is a conflict. Any unknown code degrades to modified by design: a
    // file the user changed must appear, even if its label is imprecise.
    expect(decode(z("UU conflict.txt"))).toEqual(["modified:conflict.txt"]);
  });
});

describe("renames and copies", () => {
  test("a rename reports the new path and consumes the old record", () => {
    // `-z` spends a second record on the source path. Reporting it too would
    // show a file the user does not have.
    expect(decode(z("R  new.txt", "old.txt"))).toEqual(["renamed:new.txt"]);
  });

  test("a copy behaves the same way", () => {
    expect(decode(z("C  copy.txt", "source.txt"))).toEqual(["copied:copy.txt"]);
  });

  test("a rename does not swallow the record that follows it", () => {
    // Off-by-one in the skip would eat the next real change.
    expect(decode(z("R  new.txt", "old.txt", "?? after.txt"))).toEqual([
      "renamed:new.txt",
      "untracked:after.txt",
    ]);
  });

  test("two renames in a row each consume exactly their own source", () => {
    expect(decode(z("R  n1.txt", "o1.txt", "R  n2.txt", "o2.txt"))).toEqual([
      "renamed:n1.txt",
      "renamed:n2.txt",
    ]);
  });
});

describe("paths that broke the line-based parser", () => {
  test("a path containing a space is kept whole and unquoted", () => {
    // The newline form would have emitted `"a b.txt"`, quotes included.
    expect(decode(z("A  a b.txt"))).toEqual(["created:a b.txt"]);
  });

  test("a path containing the literal rename delimiter survives", () => {
    // ` -> ` is legal in a filename. The old parser split on it.
    expect(decode(z("A  weird -> name.txt"))).toEqual(["created:weird -> name.txt"]);
  });

  test("a path containing a double quote is kept verbatim", () => {
    expect(decode(z('A  say"hi".txt'))).toEqual(['created:say"hi".txt']);
  });

  test("a path containing a tab is kept verbatim", () => {
    expect(decode(z("A  tab\there.txt"))).toEqual(["created:tab\there.txt"]);
  });

  test("a non-ASCII path is not escaped", () => {
    expect(decode(z("A  café/ünïcode–ok.txt"))).toEqual(["created:café/ünïcode–ok.txt"]);
  });

  test("a renamed path containing the delimiter still resolves to the new name", () => {
    expect(decode(z("R  new -> real.txt", "old -> fake.txt"))).toEqual([
      "renamed:new -> real.txt",
    ]);
  });

  test("a nested path keeps its separators", () => {
    expect(decode(z("M  src/deep/nested/file.ts"))).toEqual([
      "modified:src/deep/nested/file.ts",
    ]);
  });
});

describe("the degenerate inputs", () => {
  test("empty output is an empty map, not an error", () => {
    expect(parseGitStatusOutput("").size).toBe(0);
  });

  test("a lone trailing NUL produces nothing", () => {
    // Every record is NUL-terminated, so a clean repo's output can be just that.
    expect(parseGitStatusOutput("\0").size).toBe(0);
  });

  test("a record too short to hold a path is skipped, not half-parsed", () => {
    expect(parseGitStatusOutput(z("M", "M ", "M  ")).size).toBe(0);
  });

  test("a short record does not derail the records after it", () => {
    expect(decode(z("M", "?? real.txt"))).toEqual(["untracked:real.txt"]);
  });
});

describe("the record contract", () => {
  test("every entry starts with unknown line counts", () => {
    // `enrichWithCounts` fills these in from --numstat; -1 means "not known
    // yet", and 0 would be a lie the widget would render as a real count.
    const files = [...parseGitStatusOutput(z("M  a.txt")).values()];
    expect(files[0]).toEqual({
      path: "a.txt",
      status: "modified",
      added: -1,
      removed: -1,
      binary: false,
    });
  });

  test("entries are keyed by path, so a repeated path collapses", () => {
    const map = parseGitStatusOutput(z("M  a.txt", "?? a.txt"));
    expect(map.size).toBe(1);
    // Last writer wins, which is also git's own ordering semantics here.
    expect(map.get("a.txt")!.status).toBe("untracked");
  });

  test("report order is preserved", () => {
    expect(decode(z("M  b.txt", "A  a.txt", "?? c.txt"))).toEqual([
      "modified:b.txt",
      "created:a.txt",
      "untracked:c.txt",
    ]);
  });
});
