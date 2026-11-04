#
# Set this config up to run under Pi-Bolt (https://github.com/opensec-git/Pi-Bolt), the
# ahead-of-time compiled pi, while keeping plain `pi` working. Both share
# ~/.pi/agent (settings, sessions, extensions), so you can switch between `pi`
# and `pi-bolt` at any time.
#
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\migrate-pi-bolt.ps1 [--check|--undo|--no-compile]
#
# What it does, each step idempotent:
#   1. Pi-Bolt: installs it with its signed installer when `pi-bolt` is missing
#      (PIBOLT_YES=1, no start, no optional extensions offered; the child exits
#      with $LASTEXITCODE -- sentinel 90 when unset -- because the installer
#      reports failure through $global:LASTEXITCODE, not exit).
#   2. pi stays: checks the bun-installed `pi` is still there. Pi-Bolt does not
#      replace it, and this config still needs it: the kanban board script and
#      the tests resolve @earendil-works/* through the repo-root node_modules link.
#   3. settings.json, written directly (`pi-bolt install` would put the package in
#      the shared `packages` list, which plain pi then loads too):
#        - extensions: "-builtin:herdr". Pi-Bolt's own herdr reporter calls the pane
#          `pi-bolt`, which makes `herdr agent start --kind pi` (subagents) refuse it.
#          Ignored by plain pi, which has no such built-in.
#        - piBolt.packages: "-npm:@ff-labs/pi-fff", "npm:opensec-pi-fff@<pin>". Only
#          Pi-Bolt reads this overlay: it drops pi-fff (needs bun:ffi, i.e. the JIT)
#          for OpenSec's JIT-free build. Plain pi keeps @ff-labs/pi-fff.
#      A timestamped backup is written next to the file first.
#   4. opensec-pi-fff: installed into agent/npm (where `pi install` puts packages)
#      without touching the settings `packages` list.
#   5. Compile: runs scripts\pi-bolt-compile.ps1 (verifies and rolls back on failure).
#      Upstream refuses `pi-bolt compile` on some builds (win32 in 1.0.9), so
#      the step self-detects via --status and is skipped there.
#
# The extension-side compatibility (kanban, subagents, ralph-loop, auto-update,
# pi-blackhole) lives in agent/extensions and needs no setup: it switches on only
# when it detects it is running under Pi-Bolt (agent/extensions/lib/runtime.ts).
# On Windows the pi-shim PATH trick in that file is deliberately not ported (it
# needs a POSIX shell), so subagent children keep running the bun `pi`.
$ErrorActionPreference = "Stop"

$OPENSEC_FFF = "opensec-pi-fff@0.11.1"  # keep in sync with migrate-pi-bolt.sh
$FFF_NAME = $OPENSEC_FFF -replace '@[^@]*$'  # the twin derives it too (${OPENSEC_FFF%@*})
$HERE = Split-Path -Parent $PSCommandPath
$AGENT_DIR = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME ".pi\agent" }
$SETTINGS = Join-Path $AGENT_DIR "settings.json"
# `pi` and friends live in bun's bin and the local bin dir. A registry PATH
# write is invisible to a running process, so prepend for this one.
$env:Path = (Join-Path $HOME ".local\bin") + [IO.Path]::PathSeparator + (Join-Path $HOME ".bun\bin") + [IO.Path]::PathSeparator + $env:Path

$MODE = "apply"
$COMPILE = $true

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
        Write-Host "ok" -NoNewline -ForegroundColor Green
        Write-Host " $msg"
    } else {
        Write-Host "  ok $msg"
    }
}

function Todo([string]$msg) {
    if ($script:UseColor) {
        Write-Host "  " -NoNewline
        Write-Host "*" -NoNewline -ForegroundColor Yellow
        Write-Host " $msg"
    } else {
        Write-Host "  * $msg"
    }
}

function Die([string]$msg) {
    if ($script:UseColor) {
        $prev = [Console]::ForegroundColor
        [Console]::ForegroundColor = [ConsoleColor]::Red
        [Console]::Error.WriteLine("  x $msg")
        [Console]::ForegroundColor = $prev
    } else {
        [Console]::Error.WriteLine("  x $msg")
    }
    exit 1
}

function Get-Cmd([string]$name) {
    $c = Get-Command $name -CommandType Application,ExternalScript -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
}

function Show-Help {
    # The comment header, from line 2 up to the $ErrorActionPreference line,
    # with the leading "# " stripped: the bash twin's sed pipeline, in one pass.
    $out = @()
    $printing = $false
    foreach ($l in [System.IO.File]::ReadAllLines($PSCommandPath)) {
        if (-not $printing) {
            if ($l -match '^#') { $printing = $true }
            continue
        }
        if ($l -match '^\$ErrorActionPreference') { break }
        $out += ($l -replace '^# ?', '')
    }
    Write-Output ($out -join "`n")
    exit 0
}

foreach ($a in $args) {
    switch ($a) {
        "--check" { $MODE = "check" }
        "--undo" { $MODE = "undo" }
        "--no-compile" { $COMPILE = $false }
        "-h" { Show-Help }
        "--help" { Show-Help }
        default {
            [Console]::Error.WriteLine("migrate-pi-bolt: unknown argument: $a (see --help)")
            exit 1
        }
    }
}

if (-not (Test-Path -LiteralPath $SETTINGS)) {
    Die "no ${SETTINGS}: install this config first (install.ps1)"
}

# --- settings.json edits, in one place ----------------------------------------

# The source string of a packages entry: the entry itself when it is a string,
# its `source` property when it is an object, "" when it has neither.
function Get-Src([object]$p) {
    if ($p -is [string]) { return $p }
    $q = $p.PSObject.Properties['source']
    if ($q) { return [string]$q.Value }
    return ""
}

# Serialize one JSON value the way python json.dump(obj, f, indent=2) would:
# 2-space nesting, one item per line, ensure_ascii escaping, no trailing
# newline (the caller appends it). Byte parity with the bash twin's writer is
# deliberate: agent/settings.json is tracked, and the built-in JSON writer on 5.1
# reformats and escapes the whole file into a noisy diff.
function Format-JsonString([string]$s) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $s.ToCharArray()) {
        switch ([int]$ch) {
            34 { [void]$sb.Append('\"') }
            92 { [void]$sb.Append('\\') }
            10 { [void]$sb.Append('\n') }
            13 { [void]$sb.Append('\r') }
            9  { [void]$sb.Append('\t') }
            8  { [void]$sb.Append('\b') }
            12 { [void]$sb.Append('\f') }
            default {
                $code = [int]$ch
                if ($code -lt 0x20 -or $code -ge 0x7F) {
                    [void]$sb.Append(('\u' + $code.ToString('x4')))
                } else {
                    [void]$sb.Append([string]$ch)
                }
            }
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Format-JsonValue([object]$v, [int]$indent) {
    if ($null -eq $v) { return "null" }
    if ($v -is [bool]) { return ([string]$v).ToLower() }
    if ($v -is [int] -or $v -is [long]) {
        return $v.ToString([Globalization.CultureInfo]::InvariantCulture)
    }
    if ($v -is [decimal]) {
        # 5.1's ConvertFrom-Json yields Decimal for dot-form literals (no
        # exponent); route through [double] so the output matches python
        # json.dump (which normalizes) rather than the source text.
        $v = [double]$v
    }
    if ($v -is [double]) {
        # python reprs integral floats as "1.0"; .NET ToString drops the
        # fractional part, so restore it. "R" is shortest-round-trip on Core;
        # on .NET FX 4.8 it is G15 with a G17 fallback, so a 16-significant-
        # digit double can print 17 digits (diff noise, not corruption).
        if ($v -eq [math]::Truncate($v) -and [math]::Abs($v) -lt 1e16) {
            return $v.ToString("0.0", [Globalization.CultureInfo]::InvariantCulture)
        }
        return (($v.ToString("R", [Globalization.CultureInfo]::InvariantCulture)) -replace 'E', 'e')
    }
    if ($v -is [string]) { return (Format-JsonString $v) }
    if ($v -is [System.Collections.IList]) {
        if ($v.Count -eq 0) { return "[]" }
        $pad = ' ' * ($indent + 2)
        $items = @()
        foreach ($item in $v) { $items += ($pad + (Format-JsonValue $item ($indent + 2))) }
        return ("[" + "`n" + ($items -join ",`n") + "`n" + (' ' * $indent) + "]")
    }
    if ($v -is [PSCustomObject]) {
        $props = @($v.PSObject.Properties)
        if ($props.Count -eq 0) { return "{}" }
        $pad = ' ' * ($indent + 2)
        $items = @()
        foreach ($p in $props) {
            $items += ($pad + (Format-JsonString $p.Name) + ": " + (Format-JsonValue $p.Value ($indent + 2)))
        }
        return ("{" + "`n" + ($items -join ",`n") + "`n" + (' ' * $indent) + "}")
    }
    # Refuse to write rather than corrupt: e.g. a [datetime], which PS 7's
    # ConvertFrom-Json can produce from an ISO date string.
    throw "unsupported JSON value type: $($v.GetType().FullName)"
}

function Read-Settings {
    [System.IO.File]::ReadAllText($SETTINGS) | ConvertFrom-Json
}

# Read a property by name from a PSCustomObject without tripping EAP=Stop on a
# missing member.
function Get-Prop([object]$obj, [string]$name) {
    $p = $obj.PSObject.Properties[$name]
    if ($p) { return $p.Value }
    return $null
}

# Assign a property: in place when present (keeps its position, like a python
# dict update), appended at the end when absent (like a fresh dict entry).
function Set-Prop([object]$obj, [string]$name, [object]$value) {
    if ($obj.PSObject.Properties[$name]) {
        $obj.$name = $value
    } else {
        Add-Member -InputObject $obj -NotePropertyName $name -NotePropertyValue $value -Force
    }
}

# The --check report: the entries the bash twin's python check would call
# missing.
function Test-Settings([object]$s) {
    $missing = @()

    $ext = @()
    $e = Get-Prop $s "extensions"
    if ($e) { $ext = @($e) }

    $own = @()
    $pb = Get-Prop $s "piBolt"
    if ($pb) {
        $o = Get-Prop $pb "packages"
        if ($o) { $own = @($o) }
    }
    $ownSrcs = @()
    foreach ($p in $own) { $ownSrcs += (Get-Src $p) }

    $shared = @()
    $sp = Get-Prop $s "packages"
    if ($sp) { $shared = @($sp) }

    if ($ext -cnotcontains "-builtin:herdr") {
        $missing += 'extensions: "-builtin:herdr"'
    }
    foreach ($p in @("-npm:@ff-labs/pi-fff", "npm:$OPENSEC_FFF")) {
        # "Matches" means: equals the entry, or starts with the entry minus its
        # "@0.x.y" pin. Never .Split("@0") -- on .NET Framework that splits on
        # the characters '@' or '0'.
        $base = $p
        if ($p.StartsWith("npm:opensec", [StringComparison]::Ordinal)) {
            $idx = $p.IndexOf("@0", [StringComparison]::Ordinal)
            if ($idx -ge 0) { $base = $p.Substring(0, $idx) }
        }
        $found = $false
        foreach ($o in $ownSrcs) {
            if ($o -ceq $p -or $o.StartsWith($base, [StringComparison]::Ordinal)) { $found = $true; break }
        }
        if (-not $found) { $missing += "piBolt.packages: $p" }
    }
    foreach ($p in $shared) {
        if ((Get-Src $p).StartsWith("npm:opensec-pi-fff", [StringComparison]::Ordinal)) {
            $missing += "packages (shared) lists opensec-pi-fff: plain pi would load both fff builds"
            break
        }
    }
    # No comma-wrap here: the caller collects with @( ... ), and a plain array
    # return survives that for 0, 1 and N elements alike (the comma-wrap does
    # not: it double-wraps the single-element case and loses the rest).
    return $missing
}

# $mode: apply | undo. The mutations reproduce the bash twin's python rules,
# quirks included: apply always assigns `packages` (adding [] if absent), undo
# always assigns `extensions`, undo keeps `packagesOverlay` when other
# piBolt.packages survive.
function Edit-Settings([string]$mode) {
    $s = Read-Settings
    $new = Read-Settings

    if ($mode -eq "apply") {
        $ext = @()
        $e = Get-Prop $new "extensions"
        if ($e) { $ext = @($e) }
        if ($ext -cnotcontains "-builtin:herdr") {
            Set-Prop $new "extensions" @($ext + "-builtin:herdr")
        }

        $pb = Get-Prop $new "piBolt"
        $own = @()
        if ($pb) {
            $o = Get-Prop $pb "packages"
            if ($o) { $own = @($o) }
        }
        $keep = @()
        foreach ($p in $own) {
            $src = Get-Src $p
            if (-not $src.StartsWith("npm:opensec-pi-fff", [StringComparison]::Ordinal) -and $src -cne "-npm:@ff-labs/pi-fff") {
                $keep += $p
            }
        }
        $want = @($keep + @("-npm:@ff-labs/pi-fff", "npm:$OPENSEC_FFF"))
        if ($pb) {
            Set-Prop $pb "packages" $want
            Set-Prop $pb "packagesOverlay" $true
        } else {
            Set-Prop $new "piBolt" ([PSCustomObject][ordered]@{ packages = $want; packagesOverlay = $true })
        }

        $sharedAll = @()
        $sp = Get-Prop $s "packages"
        if ($sp) { $sharedAll = @($sp) }
        $shared = @()
        foreach ($p in $sharedAll) {
            if (-not (Get-Src $p).StartsWith("npm:opensec-pi-fff", [StringComparison]::Ordinal)) { $shared += $p }
        }
        Set-Prop $new "packages" $shared
    }
    else {
        $ext = @()
        $e = Get-Prop $new "extensions"
        if ($e) { $ext = @($e) }
        $noHerdr = @()
        foreach ($x in $ext) { if ($x -cne "-builtin:herdr") { $noHerdr += $x } }
        Set-Prop $new "extensions" $noHerdr

        $pbProp = $new.PSObject.Properties["piBolt"]
        $pb = if ($pbProp) { $pbProp.Value } else { $null }
        $own = @()
        if ($pb) {
            $o = Get-Prop $pb "packages"
            if ($o) { $own = @($o) }
        }
        $keep = @()
        foreach ($p in $own) {
            $src = Get-Src $p
            if (-not $src.StartsWith("npm:opensec-pi-fff", [StringComparison]::Ordinal) -and $src -cne "-npm:@ff-labs/pi-fff") {
                $keep += $p
            }
        }
        if ($keep.Count -gt 0) {
            # {**pb, "packages": keep}: packages in place, packagesOverlay and
            # any other piBolt keys survive. ($keep non-empty implies $pb set.)
            Set-Prop $pb "packages" $keep
        }
        else {
            # keep is empty: drop packages/packagesOverlay, and remove piBolt
            # when nothing else survives -- including a present-but-null
            # piBolt, which Get-Prop reads as $null (python: new.pop("piBolt")).
            $restNames = @()
            if ($pb) {
                foreach ($prop in $pb.PSObject.Properties) {
                    if ($prop.Name -cne "packages" -and $prop.Name -cne "packagesOverlay") { $restNames += $prop.Name }
                }
            }
            if ($restNames.Count -gt 0) {
                $pb.PSObject.Properties.Remove("packages")
                $pb.PSObject.Properties.Remove("packagesOverlay")
            }
            elseif ($pbProp) {
                $new.PSObject.Properties.Remove("piBolt")
            }
        }
    }

    # Comparing two canonical serializations means source formatting cannot
    # cause a false mismatch.
    $oldText = Format-JsonValue $s 0
    $newText = Format-JsonValue $new 0
    if ($oldText -ceq $newText) { return "unchanged" }

    $backup = "$SETTINGS.$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
    Copy-Item -LiteralPath $SETTINGS -Destination $backup
    $text = $newText + "`n"
    $tmp = "$SETTINGS.tmp"
    # Write raw bytes via .NET (a UTF8 cmdlet adds a BOM on 5.1).
    [System.IO.File]::WriteAllText($tmp, $text, (New-Object System.Text.UTF8Encoding $false))

    # Semantic round-trip: re-parse what was written, re-serialize, compare.
    $round = [System.IO.File]::ReadAllText($tmp) | ConvertFrom-Json
    if ((Format-JsonValue $round 0) -cne $newText) {
        Remove-Item -LiteralPath $tmp -Force
        Die "semantic check failed; settings.json untouched (backup: $backup)"
    }
    Move-Item -LiteralPath $tmp -Destination $SETTINGS -Force
    $final = [System.IO.File]::ReadAllText($SETTINGS) | ConvertFrom-Json
    if ((Format-JsonValue $final 0) -cne $newText) {
        Copy-Item -LiteralPath $backup -Destination $SETTINGS -Force
        Die "write did not round-trip; restored $backup"
    }
    return "updated (backup: $backup)"
}

# --- check: report, change nothing --------------------------------------------
if ($MODE -eq "check") {
    Step "Pi-Bolt setup"
    $gaps = 0
    if (Get-Cmd "pi-bolt") {
        Ok "pi-bolt $(pi-bolt --version)"
    } else {
        Todo "pi-bolt not installed"
        $gaps = 1
    }
    if (Get-Cmd "pi") {
        Ok "pi $(pi --version) (kept for plain-pi use and the repo's tests)"
    } else {
        Todo "pi (bun) not found: the kanban board and tests need it"
        $gaps = 1
    }
    $missing = @(Test-Settings (Read-Settings))
    if ($missing.Count -eq 0) {
        Ok "settings.json has the Pi-Bolt entries"
    } else {
        foreach ($m in $missing) { Todo $m }
        $gaps = 1
    }
    if (Test-Path -LiteralPath (Join-Path $AGENT_DIR "npm\node_modules\$FFF_NAME") -PathType Container) {
        Ok "$FFF_NAME installed"
    } else {
        Todo "$FFF_NAME not installed"
        $gaps = 1
    }
    if (Get-Cmd "pi-bolt") {
        # 2>$null on a native command under EAP=Stop turns stderr into a
        # script-killing NativeCommandError on 5.1; Continue keeps it quiet.
        $eap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        # Drain the full output before slicing: an early-closing pipe
        # (| Select-Object -First 1) can leave $LASTEXITCODE stale on 5.1.
        $statusAll = & pi-bolt compile --status 2>$null
        $rc = $LASTEXITCODE
        $status = @($statusAll) | Select-Object -First 1
        $ErrorActionPreference = $eap
        if (-not $status) { $status = "" }
        if ($status -clike "No extensions*") {
            Todo "no extensions compiled in (optional: scripts\pi-bolt-compile.ps1)"
        }
        elseif ($rc -ne 0) {
            Todo "pi-bolt compile --status failed; this build may not compile extensions in (see: pi-bolt compile --status)"
        }
        else {
            if ($status.Length -gt 90) { $status = $status.Substring(0, 90) }
            Ok "$status..."
        }
    }
    if ($gaps -eq 0) {
        Ok "ready: run pi-bolt (or pi; both work)"
    } else {
        Todo "run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\migrate-pi-bolt.ps1"
    }
    exit 0
}

# --- undo ----------------------------------------------------------------------
if ($MODE -eq "undo") {
    Step "Removing the Pi-Bolt-only settings"
    Ok (Edit-Settings "undo")
    if (Get-Cmd "pi-bolt") {
        Step "Turning the compiled build off"
        # 2>&1 from a native command under EAP=Stop throws NativeCommandError
        # on 5.1; Continue keeps the merged stream.
        $eap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        & pi-bolt compile --off *> $null
        $rc = $LASTEXITCODE
        $ErrorActionPreference = $eap
        if ($rc -eq 0) { Ok "back to the release executable" } else { Todo "nothing to turn off" }
    }
    Ok "plain pi is unaffected. Pi-Bolt itself stays installed; to remove it, re-run its installer (it offers uninstall)"
    exit 0
}

# --- apply ---------------------------------------------------------------------
Step "Pi-Bolt"
if (Get-Cmd "pi-bolt") {
    Ok "pi-bolt $(pi-bolt --version)"
} else {
    # irm is built into PowerShell, so the bash twin's curl precheck has no
    # stand-in here. The installer signals failure by setting
    # $global:LASTEXITCODE in its top-level try/catch instead of calling exit,
    # so the appended "; exit $LASTEXITCODE" is what makes the process exit
    # code real. PIBOLT_YES=1 alone suppresses every prompt AND the "Start
    # pi-bolt now?" offer, so PIBOLT_NO_START is not set; PIBOLT_NO_PATH is
    # not set either, because we want its PATH entry.
    $env:PIBOLT_YES = "1"
    $env:PIBOLT_EXTENSIONS = "no"
    try {
        & powershell -NoProfile -ExecutionPolicy Bypass -c 'irm https://pi-bolt.opensec.in/install.ps1 | iex; if ($null -eq $LASTEXITCODE) { exit 90 } else { exit $LASTEXITCODE }'
        $rc = $LASTEXITCODE
    } finally {
        Remove-Item Env:PIBOLT_YES -ErrorAction SilentlyContinue
        Remove-Item Env:PIBOLT_EXTENSIONS -ErrorAction SilentlyContinue
    }
    if ($rc -ne 0) { Die "Pi-Bolt's installer failed (see its output above)" }
    # The installer writes PATH to HKCU\Environment as an ExpandString, which a
    # running process cannot see: rebuild ours from Machine + user, plus the
    # prepends from the top of this script.
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @()
    foreach ($p in @($machinePath, $userPath)) {
        if ($p) { $parts += @($p -split [IO.Path]::PathSeparator | Where-Object { $_ -ne "" }) }
    }
    $env:Path = (Join-Path $HOME ".local\bin") + [IO.Path]::PathSeparator + (Join-Path $HOME ".bun\bin") + [IO.Path]::PathSeparator + ($parts -join [IO.Path]::PathSeparator)
    if (-not (Get-Cmd "pi-bolt")) {
        Die "installed, but pi-bolt is not on PATH; open a new terminal and re-run"
    }
    Ok "pi-bolt $(pi-bolt --version)"
}

Step "Plain pi (kept)"
if (Get-Cmd "pi") {
    Ok "pi $(pi --version)"
} else {
    Todo 'no `pi` on PATH. This config still needs it beside Pi-Bolt: bun add -g @earendil-works/pi-coding-agent'
}

Step "settings.json"
Ok (Edit-Settings "apply")

Step $FFF_NAME
if (Test-Path -LiteralPath (Join-Path $AGENT_DIR "npm\node_modules\$FFF_NAME") -PathType Container) {
    Ok "installed"
} else {
    if (-not (Get-Cmd "npm")) { Die "npm is needed to install $OPENSEC_FFF" }
    # Into pi's own package dir, as `pi install` would, but without its
    # settings edit. agent\npm may not exist on a fresh clone; the bash twin
    # dies there too, so guard on the directory first (Push-Location returns
    # no output, so an `if` on it is always false).
    $npmDir = Join-Path $AGENT_DIR "npm"
    if (-not (Test-Path -LiteralPath $npmDir -PathType Container)) {
        Die "npm install $OPENSEC_FFF failed"
    }
    Push-Location $npmDir
    try {
        npm install --no-audit --no-fund --ignore-scripts $OPENSEC_FFF
        if ($LASTEXITCODE -ne 0) { Die "npm install $OPENSEC_FFF failed" }
    } finally {
        Pop-Location
    }
    Ok "installed into $AGENT_DIR/npm"
}

if ($COMPILE) {
    Step "Compiling extensions into Pi-Bolt"
    # Upstream refuses `compile` (all modes) on some builds -- win32 in 1.0.9:
    # "compiling extensions in is not available on Windows yet". --status is
    # the cheap detector, so skip the two-minute probe when the build cannot
    # compile in extensions at all. Surface upstream's own reason rather than
    # guessing at it.
    $eap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $statusOut = & pi-bolt compile --status 2>&1
    $supported = $LASTEXITCODE
    $ErrorActionPreference = $eap
    if ($supported -ne 0) {
        $reason = @($statusOut) | Select-Object -First 1
        if (-not $reason) { $reason = "no output" }
        Todo "this pi-bolt build cannot compile extensions in ($reason); extensions load at run time"
    }
    else {
        # In 5.1, 2>&1 from a native command under EAP=Stop throws
        # NativeCommandError; Continue keeps the merged stream.
        $eap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $compileOut = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $HERE "pi-bolt-compile.ps1") 2>&1
        $rc = $LASTEXITCODE
        $ErrorActionPreference = $eap
        $lines = @()
        foreach ($l in @($compileOut)) {
            $t = [string]$l
            if ($t -match '^pi-bolt-compile') { $lines += ($t -replace '^pi-bolt-compile: ', '  ') }
        }
        foreach ($l in $lines) {
            if ($rc -ne 0) { [Console]::Error.WriteLine($l) } else { [Console]::Out.WriteLine($l) }
        }
        if ($rc -ne 0) {
            Todo "compile failed (rolled back); Pi-Bolt still works with extensions loaded at run time. Retry: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pi-bolt-compile.ps1"
        }
    }
}

Step "Done"
Ok 'run `pi-bolt` (inside herdr for the kanban board and subagents); `pi` keeps working as before'
Ok "check any time: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\migrate-pi-bolt.ps1 --check"
Ok "on Windows, subagent children still run the bun pi"
