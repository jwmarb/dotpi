#
# dotpi installer (Windows) — turns a bare Windows machine into a working pi config.
#
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/jwmarb/dotpi/master/install.ps1 | iex"
#
# Prefer downloading and reading it first; piping a script from the internet
# straight into a shell is a habit worth not having:
#
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/jwmarb/dotpi/master/install.ps1 -OutFile install.ps1"
#   .\install.ps1
#
# What it does, in order:
#   1. checks git, curl and npm are present (and pi, installing it if absent)
#   2. clones the repo to ~\.pi, or to --dir with ~\.pi junctioned at it
#   3. arms the git hooks (core.hooksPath -> .githooks)
#   4. installs the one extension that has real npm dependencies
#   5. installs the firecrawl CLI, which the librarian agent researches with
#   5b. installs the agent-browser CLI, which the agent-browser skill drives
#   5c. offers to install the herdr CLI, which the subagent tool delegates through
#   5d. adds ~\.bun\bin to the user PATH, when missing
#   6. copies agent\.env.example to agent\.env for you to fill in
#
# It never writes credentials. Step 6 leaves placeholders; you edit the file.
#
# Flags:
#   --dir <path>   clone here and junction ~\.pi at it (default: clone to ~\.pi)
#   --ref <ref>    branch or tag to check out (default: master)
#   --yes          assume yes for the backup and herdr prompts (unattended installs)
#   --no-pi        do not install pi even if it is missing
#   --help
#
# Exit codes: 0 ok · 1 usage/precondition · 2 refused to touch an existing ~\.pi
#
# This is the Windows counterpart of install.sh (bash, for Linux/macOS). The two
# scripts do the same thing in the idiom each OS expects: install.sh writes a
# shell-rc PATH export and a symlink; this one writes the user-registry PATH and
# a directory junction. Everything the config *loads* — the JSON/TS/Markdown —
# is identical and platform-agnostic; only the plumbing differs.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# ---------------------------------------------------------------------------
# Output. Colour only when stdout is a real terminal, so a piped log stays
# readable — the same rule install.sh follows with `[ -t 1 ]`.
# ---------------------------------------------------------------------------
$script:UseColor = -not [Console]::IsOutputRedirected

function Step([string]$msg) {
    if ($script:UseColor) {
        Write-Host "==> " -NoNewline -ForegroundColor White
        Write-Host $msg -ForegroundColor White
    } else {
        Write-Host "==> $msg"
    }
}

function Ok([string]$msg) {
    if ($script:UseColor) {
        Write-Host "  " -NoNewline
        Write-Host "✓" -NoNewline -ForegroundColor Green
        Write-Host " $msg"
    } else {
        Write-Host "  ✓ $msg"
    }
}

function Warn([string]$msg) {
    if ($script:UseColor) {
        Write-Host "  " -NoNewline
        Write-Host "!" -NoNewline -ForegroundColor Yellow
        Write-Host " $msg"
    } else {
        Write-Host "  ! $msg"
    }
}

# Write to stderr and end the script. `exit` inside a function ends the whole
# script (the equivalent of bash `die ...; exit`), which is what we want.
function Die([string]$msg, [int]$code = 1) {
    if ($script:UseColor) {
        Write-Host "error: " -NoNewline -ForegroundColor Red
        Write-Host $msg
    } else {
        Write-Host "error: $msg"
    }
    exit $code
}

function Show-Help {
    $help = @'
dotpi installer (Windows) — turns a bare Windows machine into a working pi config.

  powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/jwmarb/dotpi/master/install.ps1 | iex"

Flags:
  --dir <path>   clone here and junction ~\.pi at it (default: clone to ~\.pi)
  --ref <ref>    branch or tag to check out (default: master)
  --yes          assume yes for the backup and herdr prompts (unattended installs)
  --no-pi        do not install pi even if it is missing
  --help         show this help

Exit codes: 0 ok · 1 usage/precondition · 2 refused to touch an existing ~\.pi
'@
    Write-Host $help
    exit 0
}

# ---------------------------------------------------------------------------
# Configuration / argument parsing.
# ---------------------------------------------------------------------------
$REPO_URL = if ($env:DOTPI_REPO) { $env:DOTPI_REPO } else { "https://github.com/jwmarb/dotpi.git" }
$PI_HOME  = Join-Path $HOME ".pi"
$CLONE_DIR = ""
$REF = "master"
$ASSUME_YES = $false
$INSTALL_PI = $true

for ($i = 0; $i -lt $args.Count; $i++) {
    $a = $args[$i]
    if ($a -eq "--dir") {
        if ($i + 1 -ge $args.Count) { Die "--dir needs a path" }
        $CLONE_DIR = $args[$i + 1]; $i++
    } elseif ($a -eq "--ref") {
        if ($i + 1 -ge $args.Count) { Die "--ref needs a ref" }
        $REF = $args[$i + 1]; $i++
    } elseif ($a -eq "--yes" -or $a -eq "-y") {
        $ASSUME_YES = $true
    } elseif ($a -eq "--no-pi") {
        $INSTALL_PI = $false
    } elseif ($a -eq "--help" -or $a -eq "-h") {
        Show-Help
    } else {
        Die "unknown argument: $a (try --help)"
    }
}

# Expand a leading ~ in --dir: typing ~ on the command line is common and would
# otherwise create a literal '.\~\...' directory.
if ($CLONE_DIR -eq "~") {
    $CLONE_DIR = $HOME
} elseif ($CLONE_DIR -like "~\*" -or $CLONE_DIR -like "~/*") {
    $CLONE_DIR = Join-Path $HOME $CLONE_DIR.Substring(2)
}

# ---------------------------------------------------------------------------
# Prompting. When a script is piped (CI, a detached host) there is no console to
# ask through, so "no terminal" means "no consent" rather than an assumed yes —
# exactly how install.sh treats a missing /dev/tty.
# ---------------------------------------------------------------------------
function Confirm([string]$prompt) {
    if ($ASSUME_YES) { return $true }
    if ([Console]::IsInputRedirected) { return $false }
    $reply = ""
    try { $reply = Read-Host "$prompt [y/N]" } catch { return $false }
    return ($reply -eq "y" -or $reply -eq "Y" -or $reply -eq "yes" -or $reply -eq "Yes")
}

# Find a command on PATH (the Windows stand-in for bash `command -v`).
function Get-Cmd([string]$name) {
    $c = Get-Command $name -CommandType Application,ExternalScript -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
}

# ---------------------------------------------------------------------------
# 1. Preconditions
# ---------------------------------------------------------------------------
Step "Checking prerequisites"

foreach ($cmd in @("git", "curl")) {
    if (-not (Get-Cmd $cmd)) { Die "$cmd is required but not on PATH." }
}
Ok "git, curl"

if (-not (Get-Cmd "bun")) {
    Die @"
bun is required but not on PATH.
    Install it:  powershell -c "irm bun.sh/install.ps1|iex"
    Then reopen your terminal and re-run this script.
"@
}
Ok "bun $(bun --version 2>$null)"

$npmPath = Get-Cmd "npm"
if (-not $npmPath) {
    Warn "npm not found. Only the dev-only typecheck deps need it (tsc);"
    Warn "pi itself runs fine without them. Install Node.js, then: powershell scripts\setup-deps.ps1"
} else {
    Ok "npm $(npm --version 2>$null)"
}

# pi must come from bun's global bin (~\.bun\bin). An older pi on PATH has no
# @earendil-works/* aliases, so every extension fails at startup with a
# misleading "Cannot find module '@earendil-works/pi-tui'".
$piPath = Get-Cmd "pi"
if ($piPath) {
    Ok "pi $(pi --version 2>$null) ($piPath)"
    $expected = Join-Path (Join-Path $HOME ".bun\bin") "pi"
    if ((Resolve-Path -ErrorAction SilentlyContinue $piPath).Path -ne (Resolve-Path -ErrorAction SilentlyContinue $expected).Path) {
        Warn "pi is not from ~\.bun\bin. If extensions fail to load at startup,"
        Warn "that is why — put ~\.bun\bin first on PATH."
    }
}
elseif ($INSTALL_PI) {
    Step "Installing pi"
    bun install -g @earendil-works/pi-coding-agent
    if ($LASTEXITCODE -ne 0) {
        Die "failed to install pi. Install it by hand, then re-run with --no-pi."
    }
    if (-not (Get-Cmd "pi")) {
        Warn "pi installed but not on PATH. Add ~\.bun\bin to PATH and reopen your terminal."
    }
    Ok "pi installed"
}
else {
    Warn "pi is not installed and --no-pi was given; install it yourself before running pi"
}

# ---------------------------------------------------------------------------
# 2. Decide where the clone goes
# ---------------------------------------------------------------------------
$TARGET = if ($CLONE_DIR) { $CLONE_DIR } else { $PI_HOME }

# An existing ~\.pi may be someone's real config, with the only copy of their
# sessions and credentials in it. Never clobber it silently.
function Handle-Existing([string]$path, [string]$desc) {
    $gitDir = Join-Path $path ".git"
    if (Test-Path $gitDir) {
        $origin = & git -C $path remote get-url origin 2>$null
        if ($origin -and ($origin | Select-String "dotpi" -Quiet)) {
            Step "Existing dotpi clone at $desc — updating instead"
            & git -C $path fetch --quiet origin
            if ($LASTEXITCODE -ne 0) { Die "fetch failed" }
            $dirty = & git -C $path status --porcelain 2>$null
            if ($dirty) {
                Warn "local changes present; leaving them alone and not switching refs"
                Warn "run 'git -C `"$path`" pull' yourself once the tree is clean"
            } else {
                & git -C $path checkout --quiet $REF 2>$null
                & git -C $path pull --quiet --ff-only origin $REF 2>$null
                if ($LASTEXITCODE -ne 0) {
                    Warn "could not fast-forward; resolve by hand in $path"
                }
                Ok "updated to $(git -C $path rev-parse --short HEAD)"
            }
            return $true
        }
    }

    # Something else lives here. Offer a timestamped backup; refuse otherwise.
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backup = "$path.backup.$stamp"
    Write-Host ""
    Warn "$desc already exists and is not a dotpi clone."
    Write-Host "  It would be moved to: $backup"
    Write-Host ""
    if (Confirm "  Back it up and continue?") {
        Move-Item -Path $path -Destination $backup -ErrorAction Stop
        Ok "moved to $backup"
        return $false
    }
    Write-Host ""
    Die @"
refusing to touch $desc. Either move it yourself, or install elsewhere:
    powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/jwmarb/dotpi/master/install.ps1 | iex -Args '--dir C:\src\dotpi'"

  (If you meant to accept the backup but saw no prompt, there is no terminal to
   ask through — re-run with --yes, or download the script and run it.)
"@ 2
}

$CLONED = $false
if (Test-Path $TARGET) {
    if (Handle-Existing $TARGET $TARGET) {
        $CLONED = $true   # updated in place; nothing to clone
    }
}

if (-not $CLONED) {
    Step "Cloning $REPO_URL"
    $parent = Split-Path $TARGET -Parent
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop | Out-Null
    }
    & git clone --quiet --branch $REF $REPO_URL $TARGET
    if ($LASTEXITCODE -ne 0) {
        Die "clone failed (is '$REF' a real branch?)"
    }
    Ok "cloned to $TARGET at $(git -C $TARGET rev-parse --short HEAD)"
}

# ---------------------------------------------------------------------------
# 3. Junction ~\.pi when the clone lives elsewhere
#
# pi resolves its agent dir as ~\.pi\agent, so that path has to exist even when
# the checkout is somewhere else. A directory junction (mklink /J) is the
# Windows stand-in for install.sh's `ln -s`: it needs no elevation and no
# Developer Mode, unlike a full symbolic link.
# ---------------------------------------------------------------------------
if ($TARGET -ne $PI_HOME) {
    Step "Pointing ~\.pi at $TARGET"
    $linkOk = $false
    if (Test-Path $PI_HOME) {
        $item = Get-Item $PI_HOME
        if ($item.LinkType -and $item.Target) {
            # Already a junction/symlink: good if it points at $TARGET.
            if ((Resolve-Path -ErrorAction SilentlyContinue $item.Target).Path -eq (Resolve-Path $TARGET).Path) {
                $linkOk = $true
            } else {
                # Points somewhere else: back it up, then re-point below.
                Handle-Existing $PI_HOME "~\.pi" | Out-Null
            }
        } elseif (-not $item.LinkType) {
            # A real directory (not a link) occupies ~\.pi: back it up first.
            Handle-Existing $PI_HOME "~\.pi" | Out-Null
        }
    }
    if ($linkOk) {
        Ok "~\.pi already points at $TARGET"
    } else {
        & cmd /c mklink /J "`"$PI_HOME`"" "`"$TARGET`""
        if ($LASTEXITCODE -ne 0) { Die "could not junction ~\.pi -> $TARGET" }
        Ok "~\.pi -> $TARGET"
    }
}

Set-Location $TARGET

# ---------------------------------------------------------------------------
# 4. Arm the git hooks
#
# A hook in .git\hooks\ is not version controlled, so it does not exist on a
# fresh clone. Pointing core.hooksPath at the tracked directory is what makes
# the guard survive cloning. pi self-arms this at startup too; doing it here
# means the very first commit is covered.
# ---------------------------------------------------------------------------
Step "Arming git hooks"
& git config core.hooksPath .githooks
if ($LASTEXITCODE -eq 0) {
    Ok "core.hooksPath -> .githooks"
} else {
    Warn "could not set core.hooksPath; run: git -C `"$TARGET`" config core.hooksPath .githooks"
}

# ---------------------------------------------------------------------------
# 5. Extension dependencies
#
# node_modules/ is gitignored, so a fresh clone has extension sources without
# their dependencies. These are dev-only now (typescript for the typecheck
# scope): every extension loads without them. setup-deps.ps1 is the native
# Windows stand-in for setup-deps.sh; a Git Bash install.sh-style fallback
# keeps a machine without PowerShell-native npm from being blocked.
# ---------------------------------------------------------------------------
Step "Installing extension dependencies"
$depsPs = Join-Path $PWD "scripts\setup-deps.ps1"
$depsSh = Join-Path $PWD "scripts\setup-deps.sh"
if (Test-Path $depsPs) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $depsPs
    if ($LASTEXITCODE -eq 0) {
        Ok "dependencies installed"
    } else {
        Warn "dependency install reported a failure; re-run: powershell scripts\setup-deps.ps1"
    }
} elseif ((Get-Cmd "bash") -and (Test-Path $depsSh)) {
    & bash $depsSh
    if ($LASTEXITCODE -eq 0) {
        Ok "dependencies installed (via Git Bash)"
    } else {
        Warn "dependency install reported a failure; re-run: bash scripts\setup-deps.sh"
    }
} else {
    Warn "scripts\setup-deps.ps1 missing — unexpected; skipping"
}

# ---------------------------------------------------------------------------
# 5b. The firecrawl CLI
#
# The librarian agent researches by running `firecrawl`, so without this binary
# that agent launches and then cannot do its job. Optional on purpose: pi and
# every other agent work without it.
# ---------------------------------------------------------------------------
Step "Installing the firecrawl CLI"
if (Get-Cmd "firecrawl") {
    Ok "firecrawl $(firecrawl --version 2>$null)"
} elseif (-not (Get-Cmd "npm")) {
    Warn "npm not found, so the firecrawl CLI was not installed."
    Warn "The librarian agent needs it: install Node.js, then: npm install -g firecrawl-cli"
} else {
    npm install -g firecrawl-cli
    if ($LASTEXITCODE -eq 0 -and (Get-Cmd "firecrawl")) {
        Ok "firecrawl $(firecrawl --version 2>$null)"
    } else {
        Warn "could not install firecrawl-cli."
        Warn "The librarian agent needs it; install it yourself: npm install -g firecrawl-cli"
    }
}

# ---------------------------------------------------------------------------
# 5c. The agent-browser CLI
#
# The agent-browser skill drives browser automation through this CLI, and the
# browser binary it downloads is the other half of the install. Optional on
# purpose, like the firecrawl CLI. `agent-browser install` is idempotent.
# ---------------------------------------------------------------------------
Step "Installing the agent-browser CLI"
if (Get-Cmd "agent-browser") {
    Ok "agent-browser $(agent-browser --version 2>$null)"
} elseif (-not (Get-Cmd "npm")) {
    Warn "npm not found, so the agent-browser CLI was not installed."
    Warn "The agent-browser skill needs it: install Node.js, then: npm i -g agent-browser"
} else {
    npm install -g agent-browser
    if ($LASTEXITCODE -eq 0 -and (Get-Cmd "agent-browser")) {
        Ok "agent-browser installed"
    } else {
        Warn "could not install agent-browser."
        Warn "The agent-browser skill needs it; install it yourself: npm i -g agent-browser"
    }
}

if (Get-Cmd "agent-browser") {
    agent-browser install
    if ($LASTEXITCODE -eq 0) {
        Ok "browser binaries"
    } else {
        Warn "could not download the browser binaries; run: agent-browser install"
    }
}

# ---------------------------------------------------------------------------
# 5c. The herdr CLI
#
# The subagent/subagent_tasks tools delegate by opening a herdr tab and running
# pi inside it, so without this binary that entire surface is inert. On Windows
# the distribution is the release binary from herdr.dev (NOT an npm package —
# `npm install -g herdr` is an unrelated placeholder), installed by herdr's own
# PowerShell script, which adds a versioned release directory to the user PATH.
#
# Prompted rather than automatic, because this pipes a third-party script into
# PowerShell: --yes accepts it unattended, and no terminal means no consent.
# Missing herdr is a warning, never fatal.
# ---------------------------------------------------------------------------
Step "Installing the herdr CLI"
$herdrBin = Get-Cmd "herdr"
if ($herdrBin) {
    Ok "herdr $(herdr --version 2>$null)"
} else {
    Write-Host ""
    Write-Host "  The subagent tool spawns every child agent in a herdr tab, so without"
    Write-Host "  herdr that one tool cannot run. pi and every skill work without it."
    Write-Host "  This runs:  irm https://herdr.dev/install.ps1 | iex"
    Write-Host "  which downloads the Windows binary and adds it to your user PATH."
    Write-Host ""
    if (Confirm "  Install herdr now?") {
        & powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"
        if ($LASTEXITCODE -eq 0) {
            if (Get-Cmd "herdr") {
                Ok "herdr $(herdr --version 2>$null)"
            } else {
                # herdr's installer adds a PATH entry that this process does not
                # see until a new shell; the binary is on disk.
                Ok "herdr installed (add its PATH entry in a new terminal)"
            }
        } else {
            Warn "could not install herdr. Install it yourself:"
            Warn "  powershell -c `"irm https://herdr.dev/install.ps1 | iex`""
        }
    } else {
        Warn "skipping herdr; the subagent tool stays unavailable until you install it:"
        Warn "  powershell -c `"irm https://herdr.dev/install.ps1 | iex`"      (or re-run with --yes)"
    }
}

# ---------------------------------------------------------------------------
# 5d. PATH — the ~\.bun\bin entry in the user registry
#
# pi lives in ~\.bun\bin, a directory a fresh machine often has not got on
# PATH. herdr manages its own PATH entry on Windows, so the one thing this
# script must add is bun's bin. Idempotent: it matches the directory
# case-insensitively against the existing user PATH, so an entry already there
# is not duplicated.
# ---------------------------------------------------------------------------
Step "Checking user PATH"
$PATH_ADDED = $false

function Add-ToUserPath([string]$dir, [string]$display) {
    $script:PATH_ADDED = $false
    $cur = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @()
    if ($cur) { $parts = @($cur -split ";" | Where-Object { $_ -ne "" }) }
    foreach ($p in $parts) {
        if ($p -ieq $dir) {
            Ok "~\$display already on the user PATH"
            return
        }
    }
    $new = if ($cur) { "$cur;$dir" } else { $dir }
    [Environment]::SetEnvironmentVariable("Path", $new, "User")
    $script:PATH_ADDED = $true
    Ok "added ~\$display to the user PATH"
}

Add-ToUserPath (Join-Path $HOME ".bun\bin") "bun\bin"

# ---------------------------------------------------------------------------
# 6. Credentials
#
# The template only. Writing real keys is the user's job: a script that prompts
# for secrets puts them in shell history and process listings, and this one is
# often run piped from the internet where stdin is not even the user.
# ---------------------------------------------------------------------------
Step "Setting up credentials"
$ENV_WAS_CREATED = $false
$envFile = Join-Path $PWD "agent\.env"
$envExample = Join-Path $PWD "agent\.env.example"
if (Test-Path $envFile) {
    Ok "agent\.env already exists — left untouched"
} elseif (Test-Path $envExample) {
    Copy-Item $envExample $envFile -ErrorAction Stop
    $ENV_WAS_CREATED = $true
    Ok "created agent\.env from the template (placeholders)"
} else {
    Warn "agent\.env.example missing — create agent\.env by hand"
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
if ($script:UseColor) {
    Write-Host "Installed." -NoNewline -ForegroundColor Green
    Write-Host "  $TARGET"
} else {
    Write-Host "Installed.  $TARGET"
}
Write-Host ""

if ($ENV_WAS_CREATED) {
    if ($script:UseColor) {
        Write-Host "One step left — pi will not reach a model until you do it." -ForegroundColor White
    } else {
        Write-Host "One step left — pi will not reach a model until you do it."
    }
    Write-Host "Fill in the LITELLM_* values:"
    Write-Host ""
    Write-Host "    notepad.exe `"$envFile`""
    Write-Host ""
    Write-Host "  LITELLM_API_KEY    provider key   (Authorization: Bearer <key>)"
    Write-Host "  LITELLM_BASE_URL   provider URL"
    Write-Host ""
    Write-Host "Optional — the librarian agent researches through this:"
    Write-Host "  FIRECRAWL_API_URL  your Firecrawl endpoint, e.g. http://firecrawl.lan:3002"
    Write-Host "  No API key: a self-hosted URL makes the CLI skip key validation."
    Write-Host ""
}

if ($PATH_ADDED) {
    if ($script:UseColor) {
        Write-Host "PATH updated — open a NEW terminal before running pi:" -ForegroundColor White
    } else {
        Write-Host "PATH updated — open a NEW terminal before running pi:"
    }
    Write-Host ""
}

Write-Host "Then start it:"
Write-Host ""
Write-Host "    pi"
Write-Host ""
Write-Host "Verify it works:"
Write-Host "    pi /mcp            # are the MCP servers reachable with your keys?"
Write-Host "    pi /sessions       # extensions loaded (this one is an extension)"
Write-Host ""
Write-Host "If pi starts and /mcp shows its servers connected, the install is good."
Write-Host "Extension load errors surface at startup, not later."
Write-Host ""
