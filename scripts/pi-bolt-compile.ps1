#
# Compile this config's extensions into Pi-Bolt, the AOT-compiled pi
# (https://github.com/opensec-git/Pi-Bolt), leaving out the ones known not to
# survive it, then smoke-test the result and roll back if it is broken.
#
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pi-bolt-compile.ps1            # compile, verify, keep or roll back
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pi-bolt-compile.ps1 --status   # what is compiled in now
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pi-bolt-compile.ps1 --off      # back to the release's executable
#
# Why not a bare `pi-bolt compile` (measured on Pi-Bolt 1.0.2, 2026-10-25):
#   - @ff-labs/pi-fff: imports @sinclair/typebox without depending on it, so the
#     build stops; shimmed in, it then needs bun:ffi, which the JIT-off build
#     cannot call ("bun:ffi requires the JIT"), so fffind/ffgrep break. Pi-Bolt
#     runs opensec-pi-fff instead (settings.json piBolt.packages, which this
#     script checks); that one is a core.cjs Bun build `pi-bolt compile` passes
#     over by itself, and it stays run-time loaded (~14 ms).
#   - The program's top-level code is ~270 KB of bytecode with these extensions,
#     over the 256 KB default AOT limit, so the limit is raised (compile.json
#     keeps it, so `pi-bolt update` re-compiles with it too). Override with
#     PIBOLT_AOT_LIMIT=<bytes>.
#
# The smoke test loads every extension in the new executable and compares the
# tool count with the executable it replaced, without calling a model. Add a
# name to EXCLUDE when a future extension refuses to compile or to load.
#
# Upstream refuses `compile` (all modes) on some builds -- win32 in 1.0.9:
# "compiling extensions in is not available on Windows yet" -- so the script
# checks --status first and says so (exit 1) instead of probing for two minutes.
#
# On Windows the pi-shim PATH trick in agent/extensions/lib/runtime.ts is
# deliberately NOT ported, so subagent children keep running the bun `pi`;
# this script never touches agent\cache\pi-shim\.
$ErrorActionPreference = "Stop"

$EXCLUDE = @("ff-labs-pi-fff")  # keep in sync with pi-bolt-compile.sh
$AOT_LIMIT = if ($env:PIBOLT_AOT_LIMIT) { $env:PIBOLT_AOT_LIMIT } else { "300000" }
$AGENT_DIR = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME ".pi\agent" }
$SETTINGS = Join-Path $AGENT_DIR "settings.json"

function Die([string]$msg) {
    [Console]::Error.WriteLine("pi-bolt-compile: $msg")
    exit 1
}

function Say([string]$msg) {
    Write-Output "pi-bolt-compile: $msg"
}

function Get-Cmd([string]$name) {
    $c = Get-Command $name -CommandType Application,ExternalScript -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
}

if (-not (Get-Cmd "pi-bolt")) {
    Die "pi-bolt is not on PATH (install: powershell -c ""irm https://pi-bolt.opensec.in/install.ps1 | iex"")"
}

$first = if ($args.Count -gt 0) { $args[0] } else { "" }
switch ($first) {
    "--status" { & pi-bolt compile --status; exit $LASTEXITCODE }
    "--off" { & pi-bolt compile --off; exit $LASTEXITCODE }
    "" { }
    default { Die "unknown argument: $first (use --status, --off, or nothing)" }
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-bolt-compile-" + [Guid]::NewGuid().ToString("N").Substring(0,8))
try {
    [System.IO.Directory]::CreateDirectory($work) | Out-Null  # .NET idiom; idempotent (New-Item -Path is literal on 5.1, but the param is -Path)

    # A throwaway extension: report the tool count once every extension has
    # loaded, then exit before the prompt reaches a model. Absolute paths
    # throughout: .NET file APIs ignore PowerShell's location.
    $probe = Join-Path $work "probe.ts"
    $probeText = @'
export default function (pi: any) {
	pi.on("session_start", () => {
		console.log(`PIBOLT_PROBE_TOOLS ${pi.getAllTools().length}`);
		process.exit(0);
	});
}
'@
    [System.IO.File]::WriteAllText($probe, $probeText, (New-Object System.Text.UTF8Encoding $false))

    # Prints the tool count (empty on failure); the full output goes to
    # $work\<name>.log. No `timeout` binary on Windows: bound the run with
    # WaitForExit, then kill the tree (.Kill() on the process orphans its
    # children on .NET Framework).
    function Count-Tools([string]$name) {
        $outFile = Join-Path $work "$name.out"
        $errFile = Join-Path $work "$name.err"
        # stdout and stderr MUST be different files, or Start-Process throws.
        # 5.1 joins an -ArgumentList array with single spaces and adds no quotes
        # (and may strip embedded quotes), so pass ONE pre-quoted string with the
        # probe path quoted by hand -- the documented way to get exact arg passing.
        $probeArg = '--no-session -e "' + $probe + '" -p probe'
        $p = Start-Process -FilePath (Get-Cmd "pi-bolt") -ArgumentList $probeArg -WorkingDirectory $work -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        if (-not $p.WaitForExit(120000)) {
            & taskkill /T /F /PID $p.Id | Out-Null
        }

        # The redirected file can lag the process exit on some platforms; settle
        # until it stops growing (bounded) so the read below sees the full output.
        $lastSize = -1
        for ($i = 0; $i -lt 20; $i++) {
            $curSize = if (Test-Path -LiteralPath $outFile) { (Get-Item -LiteralPath $outFile).Length } else { 0 }
            if ($curSize -eq $lastSize) { break }
            $lastSize = $curSize
            Start-Sleep -Milliseconds 100
        }
        $log = Join-Path $work "$name.log"
        $content = ""
        if (Test-Path -LiteralPath $outFile) { $content += [System.IO.File]::ReadAllText($outFile) }
        if (Test-Path -LiteralPath $errFile) { $content += [System.IO.File]::ReadAllText($errFile) }
        [System.IO.File]::WriteAllText($log, $content, (New-Object System.Text.UTF8Encoding $false))
        $hits = @(Select-String -LiteralPath $log -Pattern '^PIBOLT_PROBE_TOOLS (\d+)')
        if ($hits.Count -eq 0) { return "" }
        return $hits[$hits.Count - 1].Matches[0].Groups[1].Value
    }

    # Pi-Bolt should run the JIT-free fff, not the one that breaks without the
    # JIT. A missing settings file skips the check, as in the bash twin; an
    # unparseable one warns, because the twin's python raises (fff_ok=1).
    try {
        $fffSettings = [System.IO.File]::ReadAllText($SETTINGS) | ConvertFrom-Json
        $fffOwn = @()
        $pbProp = $fffSettings.PSObject.Properties['piBolt']
        if ($pbProp -and $pbProp.Value) {
            $pkProp = $pbProp.Value.PSObject.Properties['packages']
            if ($pkProp -and $pkProp.Value) { $fffOwn = @($pkProp.Value) }
        }
        $hasFf = $false
        $hasOpensec = $false
        foreach ($entry in $fffOwn) {
            $src = if ($entry -is [string]) { $entry }
                elseif ($entry.PSObject.Properties['source']) { [string]$entry.PSObject.Properties['source'].Value }
                else { "" }
            if ($src -ceq "-npm:@ff-labs/pi-fff") { $hasFf = $true }
            if ($src.StartsWith("npm:opensec-pi-fff", [StringComparison]::Ordinal)) { $hasOpensec = $true }
        }
        if (-not $hasFf -or -not $hasOpensec) {
            [Console]::Error.WriteLine("pi-bolt-compile: warning: settings.json piBolt.packages does not swap @ff-labs/pi-fff for npm:opensec-pi-fff; fffind/ffgrep will be slow or fail under Pi-Bolt")
        }
    } catch {
        # Unparseable settings: the twin's python raises, so fff_ok is
        # nonzero and the warning is printed; a missing file skips the
        # check entirely (as the twin's [ -f ] guard does).
        if (Test-Path -LiteralPath $SETTINGS) {
            [Console]::Error.WriteLine("pi-bolt-compile: warning: settings.json piBolt.packages does not swap @ff-labs/pi-fff for npm:opensec-pi-fff; fffind/ffgrep will be slow or fail under Pi-Bolt")
        }
    }

    # Upstream refuses `compile` (all modes) on some builds -- win32 in 1.0.9:
    # "compiling extensions in is not available on Windows yet". --status is
    # the cheap detector: if it fails, the build cannot compile in extensions
    # at all, so say so instead of probing for two minutes. Surface upstream's
    # own reason (e.g. "whose folder brew owns: install it with the
    # installer") rather than guessing at it.
    $eap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $statusOut = & pi-bolt compile --status 2>&1
    $supported = $LASTEXITCODE
    $ErrorActionPreference = $eap
    if ($supported -ne 0) {
        $reason = @($statusOut) | Select-Object -First 1
        if (-not $reason) { $reason = "no output" }
        Die "this pi-bolt build refuses to compile extensions in (pi-bolt compile --status: $reason). On Windows: build in a checkout of the repo, per Pi-Bolt's docs/PLUGINS.md (scripts\build-pi.ps1 -PluginsFromInstalled)"
    }

    $before = Count-Tools "before"
    if (-not $before) {
        Die "the current pi-bolt does not start cleanly; fix that first (see: pi-bolt --no-session -p hi)"
    }

    $exclude = $EXCLUDE -join ","
    Say "compiling (excluding: $exclude; AOT limit: $AOT_LIMIT bytes; $before tools now)"
    $env:BUN_JSC_maximumAOTCandidateBytecodeSize = $AOT_LIMIT
    $rc = 0
    try {
        & pi-bolt compile --exclude $exclude
        $rc = $LASTEXITCODE
    } finally {
        Remove-Item "env:BUN_JSC_maximumAOTCandidateBytecodeSize" -ErrorAction SilentlyContinue
    }
    if ($rc -ne 0) {
        Die "the build failed and the installed executable is unchanged; the compiler's output is in Pi-Bolt's compile log"
    }

    Say "verifying the new executable"
    $after = Count-Tools "after"
    $afterLog = Join-Path $work "after.log"
    if (-not $after -or ([int]$after -lt [int]$before) -or (Select-String -LiteralPath $afterLog -Pattern 'failed to load extension|bun:ffi requires the JIT' -Quiet:$true)) {
        $lines = @(Select-String -LiteralPath $afterLog -Pattern 'error|fail|ffi') | Select-Object -First 20
        foreach ($l in $lines) { [Console]::Error.WriteLine($l.Line) }
        & pi-bolt update --rollback
        $null = $LASTEXITCODE
        $loaded = if ($after) { $after } else { "no" }
        Die "the compiled executable loaded $loaded tools (before: $before) or an extension failed; rolled back. Add the culprit to EXCLUDE"
    }

    Say "$after tools load (before: $before)"
    & pi-bolt compile --status
    Say "done. Restart pi-bolt to use it; undo with: pi-bolt update --rollback"
    Say "on Windows, subagent children still run the bun pi (the pi-shim PATH trick is not ported)"
} finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
