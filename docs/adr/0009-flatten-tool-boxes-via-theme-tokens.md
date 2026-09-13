# Extensions cannot restyle built-in tool boxes, so we flatten them via theme tokens

pi renders every built-in tool call inside a `Box(1, 1, ...)` whose background comes from
the `toolPendingBg` / `toolSuccessBg` / `toolErrorBg` theme tokens
(`dist/modes/interactive/components/tool-execution.js`). The extension API exposes
`registerMessageRenderer` only for *custom* message types — there is no hook to replace the
built-in tool renderer. To get OpenCode's flat, box-free tool lines without forking pi, we set
those three tokens to `""`, which `bgAnsi()` compiles to `\x1b[49m` (the terminal's default
background), making the box blend into the page.

The `Box`'s padding of 1 is hardcoded in the constructor and is *not* themeable, so flattened
tool calls remain indented by one column. We accept that one-column offset as the cost of
staying extension-only.

Do not "fix" this by hunting for a tool-renderer hook: there isn't one at 0.85.1. The only
alternatives are forking pi or upstreaming a themeable-padding change.
