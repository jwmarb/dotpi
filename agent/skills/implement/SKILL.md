---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /test-driven-development where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Before claiming any of it works, use /verification-before-completion: run the
commands and read the output, rather than asserting success.

Once done, use /code-review to review the work.

Commit your work to the current branch.
