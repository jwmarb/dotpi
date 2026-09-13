# Headless mode drains Tasks before exit

In non-interactive runs (`pi -p`), `subagent` still registers a background **Task**, but the process waits for all active **Tasks** to reach a terminal state before exiting.

Interactive backgrounding exists so the user is not blocked. Headless has no user to unblock, and ADR-0001 makes **Tasks** die with the process — so pure always-background would mean a headless caller launches a **Task** and instantly kills it. This matters beyond scripting: subagents are themselves spawned with `--mode json -p`, so any subagent that delegates would otherwise be silently unable to.

## Consequences

Headless runs take as long as their slowest **Task**, and an interactive session and a `-p` session running the same prompt now differ in timing though not in results. **Reminders** in headless mode are moot: the drain already delivers every **Result** before exit.
