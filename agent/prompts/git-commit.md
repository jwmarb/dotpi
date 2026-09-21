---
name: git-commits
description: 'Execute git commits using the Conventional Commits specification. Analyze diffs to generate semantic commit messages following the <type>[scope]: description format. Enables automated changelogs, semantic versioning, and CI/CD triggering.'
---

# Git Commit with Conventional Commits

## Overview

Create standardized, semantic git commits following the Conventional Commits specification (v1.0.0). Analyze the actual diff to determine appropriate type, scope, and message. This convention dovetails with [SemVer](http://semver.org), enabling automated CHANGELOG generation, semantic version bumps, and streamlined release processes.

## Commit Message Structure

```

<type>[optional scope]: <description>

[optional body]

[optional footer(s)]

```

### Structural Elements

1. **Header** — `<type>[scope]: <description>` (mandatory)
2. **Body** — Explains "why" (mandatory except for `docs` commits)
3. **Footer** — Metadata like `BREAKING CHANGE`, issue references (optional)

## Commit Types

| Type       | Purpose                                 | SemVer Impact |
| ---------- | --------------------------------------- | ------------- |
| `feat`     | New feature                             | MINOR         |
| `fix`      | Bug fix                                 | PATCH         |
| `docs`     | Documentation only                      | —             |
| `style`    | Formatting/style (no logic change)      | —             |
| `refactor` | Code refactor (neither fix nor feature) | —             |
| `perf`     | Performance improvement                 | —             |
| `test`     | Add/update tests                        | —             |
| `build`    | Build system / external dependencies    | —             |
| `ci`       | CI configuration / scripts              | —             |
| `chore`    | Maintenance tasks                       | —             |
| `revert`   | Revert a previous commit                | —             |

## Breaking Changes

Breaking changes MUST be indicated either in the type/scope prefix or via footer:

```bash
# Option 1: Exclamation mark after type/scope
feat!: remove deprecated endpoint
feat(api)!: send email on registration

# Option 2: BREAKING CHANGE footer
feat: allow config object to extend other configs

BREAKING CHANGE: `extends` key behavior changed
```

**Rule:** If `!` is used, the `BREAKING CHANGE:` footer may be omitted — the description serves as the explanation.

## Workflow

### Step 1: Analyze Changes

```bash
# Check what's staged vs working tree
git status --porcelain

# Inspect staged changes
git diff --staged

# Or inspect all uncommitted changes
git diff
```

### Step 2: Stage Intelligently

```bash
# Stage related changes together
git add src/auth/login.ts src/auth/session.ts

# Interactive staging for mixed changes
git add -p

# By pattern
git add *.test.*
```

⚠️ **Never commit secrets** (.env, credentials.json, private keys, API tokens).

### Step 3: Generate Commit Message

Analyze the diff to determine:

- **Type**: What kind of change? (See types table above)
- **Scope**: What area/module/file is affected?
- **Description**: Imperative present-tense summary (< 72 characters)

### Step 4: Execute Commit

```bash
# Single-line commit
git commit -m "feat(auth): add OAuth2 login flow"

# Multi-line with body and footer
git commit -m "$(cat <<'EOF'
feat(auth): add OAuth2 login flow

Implement Google and GitHub OAuth2 providers with PKCE flow.
Users can now authenticate via social providers before logging in.

Closes #123
Refs: #456
EOF
)"
```

## Writing Rules

### Header

- Use **imperative present tense**: `"add"` not `"added"` or `"adds"`
- Use **lowercase** start letter (no capitalization)
- No period at the end
- Keep under **72 characters** total

### Body

- Begins **one blank line** after header
- Explains **WHY**, not WHAT (the diff shows WHAT)
- Use imperative mood throughout
- Each paragraph separated by a blank line

### Footer

- Begins **one blank line** after body
- Tokens use hyphens instead of spaces: `Acked-by`, `Signed-off-by`
- Common conventions:
  - `Closes #123` — auto-closes issue on merge
  - `Refs #456` — reference without closing
  - `Fixes #789` — explicit fix reference
  - `BREAKING CHANGE: <description>`

## Best Practices

| Practice                      | Example                                         |
| ----------------------------- | ----------------------------------------------- |
| One logical change per commit | Split features into separate commits            |
| Atomic commits                | Each commit leaves repo in working state        |
| Link issues                   | Use `Closes #123` or `Refs #456` in footer      |
| Squash merge PRs              | Clean history even if branch uses loose commits |
| Consistent casing             | Pick lowercase or camelCase; apply uniformly    |

## Security & Safety Protocol

- **NEVER** update git config (`--global user.name`, etc.)
- **NEVER** run destructive commands (`--force`, `hard reset`) without explicit request
- **NEVER** skip hooks (`--no-verify`) unless requested
- **NEVER** force push to protected branches (`main`, `master`)
- If commit fails due to lint/pre-commit hooks: fix the code, create a NEW commit (do NOT amend)

## Examples

```bash
# Simple feature
feat(parser): add ability to parse arrays

# Bug fix with scope
fix(ui): correct button alignment on mobile

# Doc-only change
docs: update README with usage instructions

# Refactoring
refactor(data): improve processing pipeline performance

# Breaking change
feat!: switch to async validation

BREAKING CHANGE: validate() now returns Promise<boolean>

# Revert commit
revert: let us never again speak of the noodle incident

Refs: 676104e, a215868
```

## Related Resources

- [Conventional Commits v1.0.0 Specification](https://www.conventionalcommits.org/en/v1.0.0/)
- [SemVer Standard](http://semver.org/)
- [Angular Commit Guidelines (inspiration)](https://github.com/angular/angular/blob/main/contributing-docs/commit-message-guidelines.md)
- [@commitlint/config-conventional](https://github.com/conventional-changelog/commitlint/tree/master/%40commitlint/config-conventional)
