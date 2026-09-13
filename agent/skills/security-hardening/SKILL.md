---
name: security-hardening
description: "Security audit, code hardening, and CVE research for any codebase. Performs static analysis for vulnerability patterns (injection, auth bypass, deserialization, path traversal, SSRF), audits dependencies against OSV/GitHub Advisory/NVD databases, and patches known CVEs. Use when user mentions 'security', 'CVE', 'vulnerability', 'audit', 'harden', 'OWASP', 'injection', 'XSS', 'CSRF', 'supply chain', 'dependency audit', 'security review', or reports a security advisory."
---

# Security Hardening

## Quick Start

```
# Audit current project
1. Read .security/learned.md if it exists (project-local knowledge base)
2. Identify language/framework from project files
3. Scan source for patterns from PATTERNS.md + learned patterns
4. Audit dependencies against OSV.dev (see VULNERABILITIES.md)
5. Produce severity-ranked findings report
6. Update .security/learned.md with new findings (MANDATORY)
```

## Workflows

### Workflow 1: Full Security Audit

Run when user says "audit", "security review", or "find vulnerabilities".

- [ ] **Load knowledge base** — read `.security/learned.md` if it exists
- [ ] **Detect stack** — identify languages, frameworks, package managers from config files
- [ ] **Source scan** — search for patterns from PATTERNS.md + learned patterns matching detected stack
- [ ] **Dependency audit** — extract deps from lockfiles, batch-query OSV.dev
- [ ] **Secrets scan** — check for hardcoded credentials, API keys, tokens
- [ ] **Configuration review** — check for insecure defaults (CORS *, debug mode, permissive CSP)
- [ ] **Cross-reference suppressions** — skip findings marked as false positives in learned.md
- [ ] **Report** — produce findings sorted by severity (Critical > High > Medium > Low > Info)
- [ ] **Learn** — update `.security/learned.md` with new discoveries (see Self-Learning section)

**Report format:**
```markdown
## Security Audit Report

### Critical
- [CVE-XXXX-XXXXX] Package `foo@1.2.3` — RCE via deserialization
  - Fix: Upgrade to `foo@1.2.4`
  - File: package.json line 15

### High
- [CWE-89] SQL Injection in `src/db/users.ts:42`
  - Pattern: String concatenation in query
  - Fix: Use parameterized query
```

### Workflow 2: Harden During Development

Run when reviewing PRs or user says "check this for security".

- [ ] **Diff-focused scan** — only analyze changed/added files
- [ ] **Input validation** — verify all user inputs are validated at boundaries
- [ ] **Auth/authz checks** — verify access control on new endpoints
- [ ] **Output encoding** — verify proper escaping for context (HTML, SQL, shell, URL)
- [ ] **Error handling** — verify no sensitive data in error responses
- [ ] **Comment inline** — annotate specific lines with issue + fix
- [ ] **Learn** — update `.security/learned.md` with new discoveries

### Workflow 3: CVE Research + Patching

Run when user provides a CVE ID, mentions a vulnerability advisory, or says "patch CVE".

- [ ] **Lookup CVE** — query GitHub Advisory → NVD for full details (see VULNERABILITIES.md)
- [ ] **Assess exposure** — check if affected package/version exists in project
- [ ] **Find affected code** — locate usage of vulnerable API/function in codebase
- [ ] **Determine fix** — check advisory for patch version or mitigation
- [ ] **Apply fix** — upgrade dependency or apply code-level mitigation
- [ ] **Verify** — confirm vulnerable pattern no longer reachable
- [ ] **Regression test** — ensure fix doesn't break existing functionality
- [ ] **Learn** — record CVE, affected code location, and fix applied to `.security/learned.md`

## Severity Classification

| Severity | Criteria |
|----------|----------|
| Critical | RCE, auth bypass, data exfiltration with no user interaction |
| High | Injection (SQLi/XSS/SSRF), privilege escalation, hardcoded secrets |
| Medium | CSRF, open redirect, information disclosure, missing rate limiting |
| Low | Verbose errors, missing security headers, outdated but unexploitable deps |
| Info | Best practice suggestions, defense-in-depth recommendations |

## Dependency Lockfile Locations

| Ecosystem | Files to parse |
|-----------|----------------|
| npm | `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` |
| Python | `requirements.txt`, `Pipfile.lock`, `poetry.lock`, `uv.lock` |
| Go | `go.sum` |
| Rust | `Cargo.lock` |
| Ruby | `Gemfile.lock` |
| Java | `pom.xml`, `gradle.lockfile` |
| .NET | `packages.lock.json`, `*.csproj` (PackageReference) |

## Self-Learning (MANDATORY after every workflow)

After completing ANY workflow, update `.security/learned.md` in the project root. Create the file and directory if they don't exist.

### What to record

| Section | What goes in | Example |
|---------|-------------|---------|
| `## Suppressions` | False positives with justification | `- src/test/mock.ts:12 — CWE-798: Test-only hardcoded credential, not shipped` |
| `## Discovered Patterns` | Project-specific vulnerability patterns not in PATTERNS.md | `- This project uses `db.unsafe()` for raw SQL — grep for it` |
| `## Resolved CVEs` | CVEs found and fixed, with date and fix summary | `- CVE-2024-1234 — lodash@4.17.20 → 4.17.21 (2025-03-15)` |
| `## Project Context` | Security-relevant architecture notes | `- Auth via JWT in httpOnly cookies, refresh token rotation enabled` |
| `## Custom Rules` | Grep patterns unique to this codebase | `- `dangerousQuery(` — internal wrapper that bypasses ORM sanitization` |

### File format

```markdown
# Security Knowledge Base
<!-- Auto-maintained by security-hardening skill. Do not delete sections. -->
<!-- Last updated: YYYY-MM-DD -->

## Project Context
- [architecture notes, auth mechanisms, trust boundaries]

## Custom Rules
- [project-specific patterns to always check]

## Suppressions
- [file:line — CWE-XXX: justification for why this is not a real finding]

## Discovered Patterns
- [new vulnerability patterns found in this codebase]

## Resolved CVEs
- [CVE-XXXX-XXXXX — package@old → package@fixed (date)]
```

### Rules

1. **Always read first** — load `.security/learned.md` at workflow start before scanning
2. **Append, never overwrite** — add new entries, never remove existing ones
3. **Skip suppressed** — do not re-report findings listed in Suppressions
4. **Use custom rules** — always grep for patterns in Custom Rules section
5. **Deduplicate** — don't add entries that already exist
6. **Timestamp** — update the `Last updated` comment on every write
7. **User confirmation for suppressions** — never auto-suppress; ask user before adding to Suppressions

## Key Principles

1. **Fix root cause, not symptom** — sanitize at input boundary, not at every usage
2. **Defense in depth** — multiple layers (validation + encoding + CSP + parameterized queries)
3. **Least privilege** — minimize permissions, scope, and surface area
4. **Fail secure** — deny by default, errors must not leak internals
5. **Never suppress** — don't mark vulnerabilities as false positives without justification

## References

- [VULNERABILITIES.md](VULNERABILITIES.md) — API endpoints for OSV.dev, GitHub Advisory, NVD
- [PATTERNS.md](PATTERNS.md) — Language-specific vulnerability patterns to scan for
