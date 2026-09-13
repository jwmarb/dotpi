# Replacing the footer means reimplementing everything the built-in showed

`ctx.ui.setFooter()` replaces pi's built-in footer wholesale rather than
composing with it, so `agent/extensions/opencode-footer.ts` must reproduce every
field the built-in rendered: cwd, git branch, session name, token totals, cost,
context percent (with its >70% / >90% severity colors), model id, and thinking
level. We took that cost deliberately, to fold live subagent progress into the
footer alongside an OpenCode-style keybind-hint row.

Extension statuses are read from `footerData.getExtensionStatuses()`, which is
how *other* extensions' output (`LSP: idle`, update notices) and our own
subagent progress all reach the footer. Do not hardcode subagent progress here:
it arrives generically via `ctx.ui.setStatus()` from the subagent extension.

Width degradation is ordered deliberately: the keybind hints are decorative and
drop first (below 60 columns), then the left stats truncate, and the model is
sacrificed last. A hint the user already knows is worth less than a context
percentage they cannot otherwise see.

The footer is opt-in behind `/oc-footer` rather than installed on load, so a bug
in it can never make pi unusable — toggle it off and the built-in returns.
