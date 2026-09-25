---
name: create-readme
description: Write a project README in the house style — the project name centered in HTML over a one-line subtitle that names the problem it solves, then emoji-tagged sections. Use when the user wants a README written, rewritten, or brought in line with the house style, or wants a mermaid diagram added to a README.
---

# README House Style

A **house style** is one consistent way of building a README across every project, so each one reads as a sibling of the others rather than a new design. Ours has a signature: the name centered in HTML, and immediately under it a one-line subtitle that frames the project as the solution to a problem.

Every README passes the same steps and draws on the same block vocabulary. Only the middle sections vary with the project's shape.

## Steps

1. **Write the subtitle before anything else.** One sentence, `<category noun> that <removes a stated obstacle>` — the project's reason to exist, not its technology. Keep it to roughly 6–20 words so it reads as a subtitle, not a paragraph. _Completion:_ the subtitle names both what the thing is and the problem it removes, and no sentence in it describes the implementation.

2. **Assemble the header block.** Emit exactly this shape, in this order:

   ```html
   <p align="center">
     <img src="assets/logo.png" width="128" height="128">
   </p>

   <h1 align="center">
     ProjectName 🔌
   </h1>
   <p align="center">
     A <strong>Category</strong> that <em>removes the obstacle</em> for <audience>.
   </p>

   <div align="center">
     <img src="assets/preview1.png" width="33%">
     <img src="assets/preview2.png" width="33%">
     <img src="assets/preview3.png" width="33%">
   </div>

   <br>
   <br>
   ```

   `align="center"` on the `h1` and the subtitle is the constant — a plain Markdown `#` title is a style break. The logo block, the preview strip, and the `<br>` spacer are each optional; drop them when the project has no art. **`<div align="center">` is for the media strip, `<p align="center">` for the title and subtitle** — that split is what the existing READMEs do. One emoji may ride at the end of the name (🔌, 📄🔍), and badge rows, when the project has a package or license to advertise, go centered under the subtitle. _Completion:_ a reader who scrolls only the header can tell what the project is and why it would help them.

3. **Expand the subtitle into the need.** Add `## What is <Name>?` for what the thing is, and `## Why use <Name>?` (or `## Why Use This? 🤔`) for the gap it closes. One short paragraph each, written for someone who has never heard of the project. _Completion:_ the "why" paragraph states a problem the reader recognizes — extra steps, missing cross-device sync, a limit the upstream imposes — not a list of features. Skip both when the project is small enough that the subtitle already discharges them.

4. **List features by capability.** Heading `## Features 🚀`, then `- 🎮 **Three Game Modes:**` — emoji, bold lead-in, colon, indented detail. Describe what the user can now _do_, never the library that does it. _Completion:_ every feature bullet is phrased as an outcome the user gets.

5. **Give runnable install and usage.** Heading `## How to Install ⚡` with `### Prerequisites 📦`, then numbered steps whose commands sit in ```sh fences. Link each prerequisite tool on its name. _Completion:_ a reader with only the README open can go from clone to running program with no guesswork.

6. **Add the sections the project actually has.** Draw from the vocabulary below; use a table for anything with repeated fields (env vars, endpoints, keybindings, supported sources). _Completion:_ every section present is one the project has content for — no placeholder headings, no "todo".

7. **Diagram what the prose can't say.** Architecture, a request flowing through more than one service, a pipeline with stages, or a state machine earns a visual. Read [`MERMAID.md`](MERMAID.md) for the recipes and the house diagram conventions. Screenshots of a UI stay as centered raster images in the header strip instead. _Completion:_ each diagram names every component or stage it depicts, and the README still makes sense to someone who cannot see it.

8. **Close with the footer.** `## License 📜` — _"This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details."_ Add `## Contributing 🙌` pointing at `CONTRIBUTING.md` when one exists, then optionally a `---` and a credit line: _"Created with ❤️ by Joseph Marbella"_. _Completion:_ the license section names the actual license and links the actual file.

9. **Verify against the checklist.** Confirm: header matches step 2's shape; subtitle is one sentence; H2 headings carry trailing emoji; commands are in fenced blocks; every link and image path resolves; no heading is left empty. _Completion:_ all six checks hold.

## Section vocabulary

Reuse these headings and emoji verbatim so the same idea is named the same way in every repo.

| Heading                                        | Holds                                                  |
| ---------------------------------------------- | ------------------------------------------------------ |
| `## What is <Name>?`                           | What the thing is, in plain language                   |
| `## Why use <Name>?` / `## Why Use This? 🤔`   | The problem it removes                                 |
| `## Architecture 🏗️`                           | Diagram + one line of orientation (see `MERMAID.md`)   |
| `## Features 🚀`                               | Capability bullets                                     |
| `## OS Compatibility`                          | Supported platforms                                    |
| `## How to Install ⚡`                         | Prerequisites + steps                                  |
| `### Prerequisites 📦`                         | Tools, with links                                      |
| `### Environment Variables 🔧`                 | `\| Variable \| Required \| Default \| Description \|` |
| `### Quick Start (Local) 💻` / `### <Tool> 🐳` | Install variants                                       |
| `## API Endpoints 🌐`                          | `\| Endpoint \| Method \| Description \|`              |
| `## Testing 🧪`                                | Unit vs integration, with the commands                 |
| `## Performance & Benchmarks`                  | Measured numbers, with the hardware named              |
| `## Known Limitations ⚠️`                      | Honest bounds and sharp edges                          |
| `## License 📜`                                | License + link                                         |
| `## Contributing 🙌`                           | Pointer to `CONTRIBUTING.md`                           |

Projects that predate this style — `nurl`, `studentvue.js`, `mangascraper` — use plain `#` headings and left-aligned prose. Read them for content ideas, not for formatting.

## Rules

- **Centered HTML header, always.** `<h1 align="center">` over `<p align="center">`, even when the rest of the file is Markdown.
- **Emoji trails the heading** (`## How to Install ⚡`), never leads it. Bullets take a leading emoji _and_ a bold lead-in.
- **Bold the load-bearing noun** in a subtitle or bullet — the thing the sentence is about — and let the rest stay plain.
- **Never `<div align="center">` the title.** That tag is for media strips; the title and subtitle use `<p align="center">`.
- **Add `width` to every image** in a strip — `33%` for a row of game screenshots, `~200px` for phone screenshots, `128` for a square logo — or the strip overflows.
