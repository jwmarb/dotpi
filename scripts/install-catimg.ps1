#
# Build catimg (https://github.com/posva/catimg) from source on Windows.
#
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-catimg.ps1 [--force]
#
# startup-fetch.ts renders the startup-panel image through catimg. It is
# optional: without it the panel falls back to chafa quadrants, then to the
# ASCII distro logo.
#
# Pinned to a commit, not the v2.8.0 tag: that tag no longer compiles on
# current gcc (implicit `usleep` declaration is an error since gcc 14).
# Bump CATIMG_REF deliberately, after building it once.
#
# Needs git and cmake plus a C++ toolchain: an initialized MSVC (cl.exe),
# Visual Studio Build Tools (found via vswhere), or MinGW (g++ +
# mingw32-make). For MSVC the checked-out CMakeLists is patched to guard the
# POSIX-only `m` link (MSVC has no libm). Installs to ~\.local\bin.
# Idempotent: skips the build when the installed binary carries this ref,
# unless --force. A missing toolchain is a skip (exit 0), not a failure — the
# panel degrades gracefully. Exit 1 only when a build was attempted and failed.
$ErrorActionPreference = "Stop"

$CATIMG_REPO = "https://github.com/posva/catimg.git"
$CATIMG_REF = "3531972cb5b166a8ced06109e622e14748fadbe4"
$PREFIX = if ($env:CATIMG_PREFIX) { $env:CATIMG_PREFIX } else { Join-Path $HOME ".local" }
$BIN = Join-Path $PREFIX "bin\catimg.exe"
$STAMP = Join-Path $PREFIX "share\catimg\.dotpi-ref"
$FORCE = $false
if ($args -contains "--force") { $FORCE = $true }

if (-not $FORCE -and (Test-Path $BIN) -and (Test-Path $STAMP) -and
    ((Get-Content $STAMP -Raw).Trim() -eq $CATIMG_REF)) {
    Write-Output "catimg already built at $($CATIMG_REF.Substring(0, 7)) ($BIN)"
    exit 0
}

foreach ($cmd in @("git", "cmake")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Output "catimg: $cmd is required to build from source; install it and re-run (the startup panel falls back in the meantime)"
        exit 0
    }
}

# Pick a toolchain: an initialized MSVC, VS Build Tools via vswhere, or MinGW.
$toolchain = $null
if (Get-Command cl -ErrorAction SilentlyContinue) {
    $toolchain = "msvc"
} else {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($vsPath) {
            $devCmd = Join-Path $vsPath "Common7\Tools\VsDevCmd.bat"
            if (Test-Path $devCmd) { $toolchain = "vsdevcmd`:$devCmd" }
        }
    }
}
if (-not $toolchain -and (Get-Command g++ -ErrorAction SilentlyContinue) -and
    (Get-Command mingw32-make -ErrorAction SilentlyContinue)) {
    $toolchain = "mingw"
}
if (-not $toolchain) {
    Write-Output "catimg: no C++ toolchain found (MSVC cl.exe, VS Build Tools, or MinGW g++/mingw32-make); skipping"
    Write-Output "catimg: the startup panel falls back to chafa/ASCII. Install a toolchain, then re-run this script."
    exit 0
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("catimg-build-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
    $src = Join-Path $work "src"
    & git init -q $src
    if ($LASTEXITCODE -ne 0) { throw "git init failed" }
    & git -C $src fetch -q --depth 1 $CATIMG_REPO $CATIMG_REF
    if ($LASTEXITCODE -ne 0) { throw "git fetch failed (network?)" }
    & git -C $src checkout -q FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { throw "git checkout failed" }

    # MSVC cannot link the POSIX `m` library the upstream CMakeLists names.
    if ($toolchain -ne "mingw") {
        $cmFile = Join-Path $src "CMakeLists.txt"
        $text = Get-Content $cmFile -Raw
        if ($text -notmatch "target_link_libraries\(catimg m\)") {
            throw "expected 'target_link_libraries(catimg m)' in CMakeLists.txt; the pinned commit's layout changed"
        }
        $text = $text -replace "target_link_libraries\(catimg m\)", "if(NOT WIN32)`n  target_link_libraries(catimg m)`nendif()"
        Set-Content -Path $cmFile -Value $text -NoNewline
    }

    # sys/ioctl.h is POSIX-only and unused on Windows (vestigial include).
    $cFile = Join-Path $src "src\catimg.c"
    $cText = Get-Content $cFile -Raw
    if ($cText -match "#include <sys/ioctl\.h>") {
        $cText = $cText -replace "#include <sys/ioctl\.h>", "#if !defined(_WIN32)`n#include <sys/ioctl.h>`n#endif"
        Set-Content -Path $cFile -Value $cText -NoNewline
    }

    $build = Join-Path $work "build"
    $cmArgs = @("-S", $src, "-B", $build, "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_INSTALL_PREFIX=$PREFIX")
    if ($toolchain -eq "mingw") { $cmArgs += @("-G", "MinGW Makefiles") }

    if ($toolchain -like "vsdevcmd:*") {
        # One cmd so the developer environment survives configure+build+install.
        $devCmd = $toolchain.Substring(9)
        $quoted = ($cmArgs | ForEach-Object { if ($_ -match "^`".*`"$") { $_ } else { "`"$_`"" } }) -join " "
        $cmdline = "call `"$devCmd`" -host=msvc && cmake $quoted && cmake --build `"$build`" --config Release -j && cmake --install `"$build`" --config Release"
        & cmd /d /s /c $cmdline
        if ($LASTEXITCODE -ne 0) { throw "build failed (see output above)" }
    } else {
        & cmake @cmArgs
        if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }
        $configArg = if ($toolchain -eq "msvc") { @("--config", "Release") } else { @() }
        & cmake --build $build @configArg -j
        if ($LASTEXITCODE -ne 0) { throw "cmake build failed" }
        & cmake --install $build @configArg
        if ($LASTEXITCODE -ne 0) { throw "cmake install failed" }
    }

    if (-not (Test-Path $BIN)) { throw "build finished but $BIN is missing" }
    & $BIN -h | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "installed catimg.exe does not run" }

    New-Item -ItemType Directory -Force -Path (Split-Path $STAMP) | Out-Null
    Set-Content -Path $STAMP -Value $CATIMG_REF
    Write-Output "catimg built at $($CATIMG_REF.Substring(0, 7)) -> $BIN (toolchain: $toolchain)"
    exit 0
} finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
