#Requires -Version 7.0
<#
.SYNOPSIS
Builds the flab-ui apk from the working tree with an OpenWrt SDK and installs or removes it on a router with apk.

.DESCRIPTION
Build copies www/, rpcd/ and LICENSE to a staging folder inside the SDK and builds the package with the SDK's
USE_SOURCE_DIR (so the package comes from the working tree, not from the tag tarball and hash in the feed Makefile).
The apk is written to -OutDir. Deploy builds and then copies the apk to the router, removes the installed flab-ui and adds
the new one. Installing and removing reload rpcd (the package's own scripts do that). Deploy then waits until every
flab.* ubus object of rpcd/ucode exists and the page answers over HTTPS. Remove runs apk del and checks that no flab.*
object is left.

The OpenWrt SDK only runs on Linux. On Linux the build runs directly in bash; on Windows it runs inside WSL (-Distro)
and the working tree is reached through /mnt. The SDK must already be set up, with the feed that holds admin/flab-ui
(a src-link to a checkout of openwrt/packages) installed and CONFIG_PACKAGE_flab-ui=m in its .config; see
docs/package.md. The router must run an apk-based OpenWrt (a snapshot or a release built with apk).

A Deploy or Remove ends nothing in rpcd by itself, but it replaces the plugins that serve the signed-in pages, so run
it under tools/router-lock.ps1 -Mode Write when the router is shared.

.PARAMETER Action
Build (only build the apk), Deploy (build, then install on the router) or Remove (uninstall from the router).

.PARAMETER Router
SSH destination of the router, for example root@192.168.1.1. Defaults to the FLAB_ROUTER environment variable, else
root@192.168.1.1. Not used by Build.

.PARAMETER Distro
Name of the WSL distribution that holds the SDK. Used on Windows only.

.PARAMETER Sdk
Directory of the SDK as the shell that runs the build sees it (a WSL path on Windows); a glob is allowed and the first
match is used.

.PARAMETER OutDir
Folder that receives the built apk.

.PARAMETER UseFeedSource
Build from the source the feed Makefile names (the tag tarball, whose hash the SDK checks) instead of the working tree.
Used for releases, so the apk is exactly what the Makefile builds.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Build', 'Deploy', 'Remove')][string]$Action,
    [string]$Router = $(if ($env:FLAB_ROUTER) { $env:FLAB_ROUTER } else { 'root@192.168.1.1' }),
    [ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Distro = 'Ubuntu-26.04',
    [ValidatePattern('^[A-Za-z0-9._/$*~-]+$')][string]$Sdk = '$HOME/sdk/openwrt-sdk-*',
    [string]$OutDir = (Join-Path ([IO.Path]::GetTempPath()) 'flab-apk'),
    [switch]$UseFeedSource
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent

#region Helpers
function ConvertTo-BuildPath {
    <#
    .SYNOPSIS
    Converts a local path to the path the shell that runs the build uses.
    .DESCRIPTION
    On Linux the path is used as is. On Windows the build runs in WSL, where a drive path such as D:\source\repo is
    /mnt/d/source/repo.
    .PARAMETER Path
    An absolute local path.
    .OUTPUTS
    String.
    #>
    param([Parameter(Mandatory)][string]$Path)

    if (-not $IsWindows) { return $Path }
    if ($Path -notmatch '^([A-Za-z]):[\\/](.*)$') { throw "Not a drive path: $Path" }
    return '/mnt/' + $Matches[1].ToLower() + '/' + ($Matches[2] -replace '\\', '/').TrimEnd('/')
}

function Invoke-Bash {
    <#
    .SYNOPSIS
    Runs a bash script where the SDK is (locally on Linux, in the WSL distribution on Windows) and returns its output.
    .DESCRIPTION
    The script goes in on standard input, so no quoting by wsl.exe or PowerShell touches its variables. Line endings are
    normalized to LF. Throws on a nonzero exit code.
    .PARAMETER Script
    Bash script text.
    .OUTPUTS
    The output lines of the script.
    #>
    param([Parameter(Mandatory)][string]$Script)

    $text = $Script -replace "`r`n", "`n"
    $out = if ($IsWindows) { $text | wsl -d $Distro -- bash -s } else { $text | bash -s }
    if ($LASTEXITCODE -ne 0) { throw "The build script failed with exit code $LASTEXITCODE" }
    return $out
}

function Invoke-Remote {
    <#
    .SYNOPSIS
    Runs a POSIX shell script on the router over SSH and returns its output.
    .DESCRIPTION
    Normalizes line endings to LF (BusyBox sh rejects CRLF) and throws on a nonzero exit code.
    .PARAMETER Script
    Shell script text.
    .OUTPUTS
    The output lines of the script.
    #>
    param([Parameter(Mandatory)][string]$Script)

    $out = ssh $Router ($Script -replace "`r`n", "`n")
    if ($LASTEXITCODE -ne 0) { throw "Remote command failed with exit code $LASTEXITCODE" }
    return $out
}

function Wait-Objects {
    <#
    .SYNOPSIS
    Waits until rpcd serves exactly the expected flab.* ubus objects (none when the list is empty).
    .DESCRIPTION
    rpcd reloads asynchronously after the package scripts return, so the objects appear or disappear a moment later.
    Throws with the difference when they are not as expected after the timeout.
    .PARAMETER Expected
    The ubus object names that must exist, for example flab.wifi.
    .PARAMETER TimeoutSeconds
    How long to keep polling.
    #>
    param([string[]]$Expected = @(), [int]$TimeoutSeconds = 20)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $actual = @(Invoke-Remote 'ubus list | grep "^flab\." || true' | Where-Object { $_ } | Sort-Object)
        $diff = Compare-Object @($Expected | Sort-Object) $actual
        if (-not $diff) { return }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    throw "ubus objects differ after $TimeoutSeconds s ('<=' expected but missing, '=>' present but unexpected): $(($diff | ForEach-Object { $_.SideIndicator + ' ' + $_.InputObject }) -join ', ')"
}
#endregion

#region Build script (runs where the SDK is)
# Stages only what the package installs, because the SDK writes its build stamps into the source directory it is given;
# the staging folder lives in the SDK's own tmp/ and is recreated on every run. The newest apk is taken, since the apk
# of an earlier version may still be in the SDK's bin folder.
$buildScript = @'
set -eu
SRC='@@SRC@@'
OUT='@@OUT@@'
LOG=/tmp/flab-ui-build.log
SDK=$(ls -d @@SDK@@ 2>/dev/null | head -n 1 || true)
[ -n "$SDK" ] || { echo "No OpenWrt SDK found at: @@SDK@@" >&2; exit 1; }
cd "$SDK"
if [ ! -f .config ] || ! grep '^CONFIG_PACKAGE_flab-ui=m' .config > /dev/null || ! ls -d package/feeds/*/flab-ui > /dev/null 2>&1; then
  echo "The SDK at $SDK is not set up for flab-ui: install the feed that holds admin/flab-ui and set CONFIG_PACKAGE_flab-ui=m (see docs/package.md)." >&2
  exit 1
fi
STAGE="$SDK/tmp/flab-ui-src"
make package/flab-ui/clean > "$LOG" 2>&1 || { tail -40 "$LOG" >&2; exit 1; }
if [ '@@FEED@@' = 1 ]; then
  make package/flab-ui/compile >> "$LOG" 2>&1 || { tail -40 "$LOG" >&2; exit 1; }
else
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  cp -a "$SRC/www" "$SRC/rpcd" "$SRC/LICENSE" "$STAGE/"
  make package/flab-ui/compile USE_SOURCE_DIR="$STAGE" >> "$LOG" 2>&1 || { tail -40 "$LOG" >&2; exit 1; }
fi
mkdir -p "$OUT"
APK=$(ls -t bin/packages/*/*/flab-ui-*.apk 2>/dev/null | head -n 1 || true)
[ -n "$APK" ] || { echo "The build produced no flab-ui apk (is this an apk-based SDK?). Log: $LOG" >&2; exit 1; }
rm -f "$OUT"/flab-ui-*.apk
cp "$APK" "$OUT/"
basename "$APK"
'@

function Build-Package {
    <#
    .SYNOPSIS
    Builds the apk from the working tree with the SDK and returns the path of the apk in -OutDir.
    .OUTPUTS
    String.
    #>
    New-Item -ItemType Directory $OutDir -Force | Out-Null
    Write-Host $(if ($UseFeedSource) { 'Building the package from the source the feed Makefile names...' } else { 'Building the package from the working tree...' })
    $feed = if ($UseFeedSource) { '1' } else { '0' }
    $script = $buildScript.Replace('@@SRC@@', (ConvertTo-BuildPath $root)).Replace('@@OUT@@', (ConvertTo-BuildPath (Resolve-Path $OutDir).Path)).Replace('@@SDK@@', $Sdk).Replace('@@FEED@@', $feed)
    $apk = Join-Path $OutDir @(Invoke-Bash $script)[-1]
    if (-not (Test-Path $apk)) { throw "The built package is missing: $apk" }
    Write-Host "Built $apk"
    return $apk
}
#endregion

#region Actions
switch ($Action) {
    'Build' {
        $null = Build-Package
    }
    'Deploy' {
        # The plugins are the source of truth for which ubus objects must appear (one object per plugin file).
        $expected = @(Get-ChildItem (Join-Path (Join-Path $root 'rpcd') 'ucode') -Filter 'flab.*.uc' | ForEach-Object { $_.BaseName })
        if (-not $expected) { throw 'No rpcd plugin found in rpcd/ucode.' }

        $apk = Build-Package
        $apkName = Split-Path $apk -Leaf
        Write-Host "Installing $apkName on the router..."
        scp -O -q $apk "${Router}:/tmp/$apkName"
        if ($LASTEXITCODE -ne 0) { throw "scp failed with exit code $LASTEXITCODE" }
        # The package is removed first because apk does not reinstall an apk of the version that is already installed.
        Invoke-Remote @"
set -e
if apk info -e flab-ui >/dev/null 2>&1; then apk del flab-ui; fi
apk add --allow-untrusted /tmp/$apkName
rm -f /tmp/$apkName
"@ | Write-Host

        Wait-Objects -Expected ($expected)
        $hostName = $Router.Split('@')[-1]
        $page = Invoke-WebRequest -Uri "https://$hostName/flab/" -SkipCertificateCheck
        if ($page.StatusCode -ne 200) { throw "The page answered HTTP $($page.StatusCode)." }
        Write-Host "Deployed $($expected.Count) rpcd objects. Open https://$hostName/flab/ and sign in as root."
    }
    'Remove' {
        Invoke-Remote 'if apk info -e flab-ui >/dev/null 2>&1; then apk del flab-ui; else echo "flab-ui is not installed."; fi' | Write-Host
        Wait-Objects
        Write-Host 'Removed; no flab.* ubus object is left.'
    }
}
#endregion
