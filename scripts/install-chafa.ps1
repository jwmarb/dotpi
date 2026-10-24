#
# Install chafa (https://hpjansson.org/chafa/) on Windows.
#
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-chafa.ps1 [--force]
#
# startup-fetch.ts uses chafa for the finer character styles (quad, sextant,
# octant, braille, ascii). Optional: without it those styles fall back to
# catimg half-blocks, then to the ASCII distro logo.
#
# Primary: the official pinned Windows archive from hpjansson.org, verified by
# SHA256, copied to ~\.local\bin\chafa.exe. Fallback: the exact winget package
# (hpjansson.Chafa, same version), whose executable is copied to the same
# place so ~\.local\bin stays the one location the extension looks at.
# Only the CLI is installed. Idempotent: skips when the installed binary is
# already at this ref, unless --force. Exit 0 on success or already-installed,
# 1 on failure.
$ErrorActionPreference = "Stop"

$CHAFA_REF = "1.16.2"
$URL = "https://hpjansson.org/chafa/releases/static/chafa-$CHAFA_REF-1-x86_64-windows.zip"
$SHA256 = "7C56044FF0745786023443D03E74507C195EBEE954F20DFAAE05A75D4CD01EED"
$PREFIX = if ($env:CHAFA_PREFIX) { $env:CHAFA_PREFIX } else { Join-Path $HOME ".local" }
$BIN = Join-Path $PREFIX "bin\chafa.exe"
$STAMP = Join-Path $PREFIX "share\chafa\.dotpi-ref"
$FORCE = $false
if ($args -contains "--force") { $FORCE = $true }

# `chafa --version` prints "Chafa version <ver>" then a "Loaders: ..." line
# (older builds printed "Chafa <ver>"; accept both).
function Chafa-Version([string]$exe) {
    try {
        $out = (& $exe --version 2>$null) -join "`n"
        if ($LASTEXITCODE -ne 0) { return $null }
        if ($out -match "chafa(?:\s+version)?\s+(\d+(?:\.\d+)+)") { return $Matches[1] }
        return $null
    } catch { return $null }
}

# Already installed at the pinned ref?
if (-not $FORCE) {
    if ((Test-Path $BIN) -and (Test-Path $STAMP) -and
        ((Get-Content $STAMP -Raw).Trim() -eq $CHAFA_REF) -and ((Chafa-Version $BIN) -eq $CHAFA_REF)) {
        Write-Output "chafa already installed at $CHAFA_REF ($BIN)"
        exit 0
    }
    # A PATH-managed install (e.g. winget) at the pinned ref is good enough;
    # copy it into the local prefix so the extension finds one canonical spot.
    $cmd = Get-Command chafa -ErrorAction SilentlyContinue
    if ($cmd -and (Chafa-Version $cmd.Source) -eq $CHAFA_REF) {
        if (-not (Test-Path $BIN)) {
            New-Item -ItemType Directory -Force -Path (Split-Path $BIN) | Out-Null
            Copy-Item $cmd.Source $BIN
        }
        if (-not (Test-Path $STAMP)) {
            New-Item -ItemType Directory -Force -Path (Split-Path $STAMP) | Out-Null
            Set-Content -Path $STAMP -Value $CHAFA_REF
        }
        Write-Output "chafa $CHAFA_REF already on PATH ($($cmd.Source))"
        exit 0
    }
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("chafa-install-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
    # 1. The official archive (hash-verified).
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        $zip = Join-Path $work "chafa.zip"
        $ok = $false
        try {
            & curl.exe -sSL --fail --max-time 180 -o $zip $URL
            if ($LASTEXITCODE -eq 0) {
                $hash = (Get-FileHash -Algorithm SHA256 $zip).Hash
                if ($hash -eq $SHA256) { $ok = $true }
                else { Write-Output "chafa: archive hash mismatch ($hash); trying winget" }
            } else {
                Write-Output "chafa: download failed (exit $LASTEXITCODE); trying winget"
            }
        } catch {
            Write-Output "chafa: download failed: $($_.Exception.Message); trying winget"
        }
        if ($ok) {
            Expand-Archive -Path $zip -DestinationPath $work -Force
            $src = Join-Path $work "chafa-$CHAFA_REF-1-x86_64-win\Chafa.exe"
            if (Test-Path $src) {
                New-Item -ItemType Directory -Force -Path (Split-Path $BIN) | Out-Null
                Copy-Item $src $BIN -Force
            } else {
                Write-Output "chafa: archive layout changed (expected chafa-$CHAFA_REF-1-x86_64-win\Chafa.exe); trying winget"
                Remove-Item $BIN -ErrorAction SilentlyContinue
            }
        }
    } else {
        Write-Output "chafa: curl.exe not found; trying winget"
    }

    # 2. winget fallback, pinned to the same version.
    if (-not (Test-Path $BIN)) {
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            Write-Output "chafa: installing hpjansson.Chafa $CHAFA_REF via winget"
            & winget install --id hpjansson.Chafa --version $CHAFA_REF --exact --silent `
                --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -eq 0) {
                # winget keeps the binary in its managed location; find it and
                # copy it into the local prefix (the current process's PATH may
                # not include the winget Links dir yet).
                $foundExe = $null
                $found = Get-Command chafa -ErrorAction SilentlyContinue
                if ($found) { $foundExe = $found.Source }
                if (-not $foundExe) {
                    $links = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"
                    if (Test-Path (Join-Path $links "chafa.exe")) { $foundExe = Join-Path $links "chafa.exe" }
                }
                if ($foundExe) {
                    New-Item -ItemType Directory -Force -Path (Split-Path $BIN) | Out-Null
                    Copy-Item $foundExe $BIN -Force
                } else {
                    Write-Output "chafa: winget reported success but no chafa executable is discoverable (a new shell may be needed)"
                }
            }
        } else {
            Write-Output "chafa: neither curl.exe nor winget is available"
        }
    }

    $got = if (Test-Path $BIN) { Chafa-Version $BIN } else { $null }
    if ($got -ne $CHAFA_REF) {
        $why = if (-not (Test-Path $BIN)) { "no $BIN" } elseif (-not $got) { "$BIN does not run or its --version is unrecognized" } else { "$BIN is version $got, expected $CHAFA_REF" }
        Write-Output "chafa: install failed ($why)"
        Remove-Item $BIN -ErrorAction SilentlyContinue
        exit 1
    }

    # Loader check, warning-only (mirror of install-chafa.sh): a build without
    # a loader still runs, it just cannot draw that format.
    $loaders = ""
    & $BIN --version 2>$null | ForEach-Object { if ($_ -match "Loaders:\s*(.*)") { $loaders = $Matches[1] } }
    foreach ($fmt in @("JPEG", "PNG")) {
        if ($loaders -notmatch [regex]::Escape($fmt)) {
            Write-Output "chafa: no $fmt loader (images in that format will not render)"
        }
    }

    New-Item -ItemType Directory -Force -Path (Split-Path $STAMP) | Out-Null
    Set-Content -Path $STAMP -Value $CHAFA_REF
    Write-Output "chafa $CHAFA_REF installed -> $BIN (loaders: $loaders)"
    exit 0
} finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
