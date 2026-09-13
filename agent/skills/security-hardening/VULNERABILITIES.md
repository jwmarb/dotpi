# Vulnerability Database API Reference

## 1. OSV.dev — Primary (batch package queries, no auth)

### Query single package

```bash
curl -s -X POST "https://api.osv.dev/v1/query" \
  -H "Content-Type: application/json" \
  -d '{"package": {"name": "PACKAGE", "ecosystem": "ECOSYSTEM"}, "version": "VERSION"}'
```

**Ecosystems:** `npm`, `PyPI`, `Go`, `Maven`, `NuGet`, `RubyGems`, `crates.io`, `Debian`, `Ubuntu`, `Alpine`, `GitHub Actions`

**PURL variant:**
```bash
curl -s -X POST "https://api.osv.dev/v1/query" \
  -d '{"package": {"purl": "pkg:pypi/jinja2@2.4.1"}}'
```

**Response:** Full vulnerability objects with `id`, `summary`, `details`, `aliases` (CVE IDs), `affected[].ranges[].events` (introduced/fixed versions).

### Batch query (up to 1,000 packages)

```bash
curl -s -X POST "https://api.osv.dev/v1/querybatch" \
  -H "Content-Type: application/json" \
  -d '{
    "queries": [
      {"package": {"purl": "pkg:npm/lodash@4.17.20"}},
      {"package": {"purl": "pkg:pypi/flask@1.0"}},
      {"package": {"ecosystem": "Go", "name": "golang.org/x/net"}, "version": "0.0.0-20220225172249-27dd8689420f"}
    ]
  }'
```

**Response:** Array of `{vulns: [{id, modified}]}` — IDs only. Fetch full details with:

```bash
curl -s "https://api.osv.dev/v1/vulns/GHSA-xxxx-xxxx-xxxx"
```

### Rate limits: None enforced. No API key needed.

---

## 2. GitHub Advisory Database — Cross-reference (GHSA ↔ CVE)

### Search by CVE ID

```bash
curl -s "https://api.github.com/advisories?cve_id=CVE-2021-44228" \
  -H "Accept: application/vnd.github+json"
```

### Search by affected package

```bash
curl -s "https://api.github.com/advisories?affects=lodash@4.17.20" \
  -H "Accept: application/vnd.github+json"
```

### Search by ecosystem + severity

```bash
curl -s "https://api.github.com/advisories?ecosystem=npm&severity=critical" \
  -H "Accept: application/vnd.github+json"
```

### Get single advisory

```bash
curl -s "https://api.github.com/advisories/GHSA-462w-v97r-4m45" \
  -H "Accept: application/vnd.github+json"
```

### Using gh CLI

```bash
# Search advisories
gh api /advisories --jq '.[].ghsa_id' -f cve_id=CVE-2021-44228

# Get advisory details
gh api /advisories/GHSA-462w-v97r-4m45
```

**Response fields:** `ghsa_id`, `cve_id`, `severity`, `summary`, `description`, `cwes[]`, `affected[].package`, `affected[].ranges[]`

**Useful parameters:** `ecosystem`, `severity`, `cve_id`, `affects`, `type` (reviewed|malware), `cwes`, `modified` (date filter)

### Rate limits: 60/hour unauthenticated, 5,000/hour with token.

---

## 3. NVD — CVSS scores and detailed CVE metadata

### Query by CVE ID

```bash
curl -s "https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2021-44228"
```

### Search by keyword

```bash
curl -s "https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=Apache+Log4j"
```

### Filter by severity

```bash
curl -s "https://services.nvd.nist.gov/rest/json/cves/2.0?cvssV3Severity=CRITICAL"
```

### Filter by CWE

```bash
curl -s "https://services.nvd.nist.gov/rest/json/cves/2.0?cweId=CWE-89"
```

### CISA KEV (Known Exploited Vulnerabilities) only

```bash
curl -s "https://services.nvd.nist.gov/rest/json/cves/2.0?hasKev"
```

**Response fields:** `vulnerabilities[].cve.id`, `.descriptions[]`, `.metrics.cvssMetricV31[].cvssData` (baseScore, baseSeverity, vectorString), `.weaknesses[]`, `.configurations[]`

### Rate limits: 5 requests/30s without key, 50/30s with key.

---

## Recommended Query Strategy

```
1. Parse lockfile → extract package names + versions
2. Batch-query OSV.dev (up to 1,000 at once) → get vuln IDs
3. For each vuln ID → fetch full details from OSV.dev
4. Cross-reference via GitHub Advisory → get GHSA details, CWEs, fix versions
5. For critical findings → query NVD for CVSS vector, exploitability metrics
6. Check CISA KEV → flag actively exploited vulnerabilities
```

## PURL Format Reference

Package URLs for OSV.dev batch queries:

| Ecosystem | PURL format |
|-----------|-------------|
| npm | `pkg:npm/PACKAGE@VERSION` |
| PyPI | `pkg:pypi/PACKAGE@VERSION` |
| Go | `pkg:golang/MODULE@VERSION` |
| Maven | `pkg:maven/GROUP/ARTIFACT@VERSION` |
| NuGet | `pkg:nuget/PACKAGE@VERSION` |
| RubyGems | `pkg:gem/PACKAGE@VERSION` |
| crates.io | `pkg:cargo/PACKAGE@VERSION` |
