#
# Install the npm dependencies of everything in this repo that declares them.
#
# node_modules/ is git-ignored, so a fresh clone has sources without their
# dependencies. Two kinds of tree declare some:
#
#   - an extension (`agent\extensions\<name>\`), where what is left is dev-only
#     (typescript + @types/node for the typecheck scope) since MCP moved to pi's
#     built-in extension -- every extension LOADS without this script. It is
#     still run automatically so `tsc -p` works in a fresh clone.
#   - a skill (`agent\skills\<category>\<name>\`), where the dependency is what
#     the skill's own tool imports at run time, so a missing tree is a skill that
#     fails when invoked rather than one that merely cannot be type-checked.
#
# Both roots are scanned because the interface this script advertises is "install
# every dependency set this repo declares". The bash twin (setup-deps.sh) is the
# Linux/macOS entry point; this is the native Windows one.
#
# Called three ways, all best-effort and quiet on success:
#   - .githooks\post-checkout and .githooks\post-merge (bash, via Git Bash) with
#     --force — the lockfile may have just changed, so the installed tree is
#     re-verified against it
#   - agent\extensions\git-hooks.ts at pi startup — covers the initial clone,
#     which no git hook sees; a no-op when everything is already installed
#   - by hand, when an install went missing: powershell scripts\setup-deps.ps1
param([string[]]$args)

$force = $false
if ($args -contains "--force") { $force = $true }

# Resolve THIS repo, not the caller's. git-hooks.ts runs this at every pi
# startup, in whatever workspace pi was opened in -- so a bare `git rev-parse`
# answers about that workspace instead: in another git repo it would resolve to
# that repo's root, the globs would match nothing, and the found==0 guard below
# would cry "no package.json found" on every startup outside this clone.
# Anchoring git to the script's own directory asks the question that was always
# meant: where is the repo containing this script?
$here = Split-Path -Parent $PSCommandPath
$root = & git -C $here rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $root) { $root = Split-Path -Parent $here }
Set-Location $root

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "setup-deps: npm not found on PATH; skipping dependency install"
    exit 0
}

# Every tracked package.json under the two roots that own one. `git ls-files`
# rather than a find: it excludes the vendored checkouts under agent\git\ (whose
# own manifests are not ours to install) and every generated node_modules tree,
# without this script having to restate either exclusion. The Get-ChildItem
# fallback keeps a non-git export working, and prunes the same two shapes.
$manifests = @()
$gitList = & git ls-files -- 'agent/extensions/*/package.json' 'agent/skills/*/package.json' 'agent/skills/*/*/package.json' 2>$null
if ($gitList) {
    $manifests = @($gitList | ForEach-Object { Join-Path $root $_ })
} else {
    $manifests = @(
        Get-ChildItem -Path (Join-Path $root "agent\extensions"), (Join-Path $root "agent\skills") `
            -Recurse -Filter "package.json" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch [regex]::Escape("node_modules") } |
        Where-Object { $_.FullName -notmatch [regex]::Escape("agent\git\") } |
        Select-Object -ExpandProperty FullName
    )
}

$status = 0
$found = 0

foreach ($pkg in $manifests) {
    if (-not (Test-Path $pkg)) { continue }
    $found++
    $dir = Split-Path -Parent $pkg
    # Skip trees that are present and non-empty (an empty node_modules is a
    # leftover of an interrupted install, and must be retried).
    $nm = Join-Path $dir "node_modules"
    if (-not $force -and (Test-Path $nm) -and
        (Get-ChildItem $nm -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) {
        continue
    }
    Write-Host "setup-deps: npm install in $dir"
    Push-Location $dir
    npm install --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) {
        Write-Host "setup-deps: dependency install failed for $dir"
        $status = 1
    }
    Pop-Location
}

# A run that discovered nothing means the globs stopped matching the tree -- the
# exact silent failure the bash twin had when it looked at extensions only.
# Report it instead of exiting 0 on an empty loop.
if ($found -eq 0) {
    Write-Host "setup-deps: no package.json found under agent/extensions or agent/skills"
    $status = 1
}
exit $status
