#Requires -Version 7.0
<#
.SYNOPSIS
Builds the flab-ui apk from the working tree with the OpenWrt SDK and installs or removes it on the router with apk.

.DESCRIPTION
Deploy copies www/, rpcd/ and LICENSE to a staging folder inside WSL, builds the package with the OpenWrt SDK's
USE_SOURCE_DIR (so the package comes from the working tree, not from the tag tarball and hash in the feed Makefile),
copies the apk to the router, removes the installed flab-ui and adds the new one. Installing and removing reload rpcd
(the package's own scripts do that). Deploy then waits until every flab.* ubus object of rpcd/ucode exists and the page
answers over HTTPS. Remove runs apk del and checks that no flab.* object is left.

The SDK must already be set up in WSL, with the feed that holds admin/flab-ui (a src-link to a checkout of
openwrt/packages) installed and CONFIG_PACKAGE_flab-ui=m in its .config. Remove the package before using
deploy.ps1 and the other way around: both use /www/flab.

A Deploy or Remove ends nothing in rpcd by itself, but it replaces the plugins that serve the signed-in pages, so run
it under tools/router-lock.ps1 -Mode Write when the router is shared.

.PARAMETER Action
Deploy or Remove.

.PARAMETER Router
SSH destination of the router.

.PARAMETER Distro
Name of the WSL distribution that holds the SDK.

.PARAMETER Sdk
Directory of the SDK inside WSL; a glob is allowed and the first match is used.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Deploy', 'Remove')][string]$Action,
    [string]$Router = 'root@openwrt.lab.formicalab.casa',
    [ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Distro = 'Ubuntu-26.04',
    [ValidatePattern('^[A-Za-z0-9._/$*~-]+$')][string]$Sdk = '$HOME/sdk/openwrt-sdk-*'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent

#region Helpers
function ConvertTo-WslPath {
    <#
    .SYNOPSIS
    Converts a Windows drive path to its /mnt path inside WSL.
    .PARAMETER Path
    An absolute path on a drive, for example D:\source\repo.
    .OUTPUTS
    String.
    #>
    param([Parameter(Mandatory)][string]$Path)

    if ($Path -notmatch '^([A-Za-z]):[\\/](.*)$') { throw "Not a drive path: $Path" }
    return '/mnt/' + $Matches[1].ToLower() + '/' + ($Matches[2] -replace '\\', '/').TrimEnd('/')
}

function Invoke-Wsl {
    <#
    .SYNOPSIS
    Runs a bash script inside the WSL distribution and returns its output.
    .DESCRIPTION
    The script goes in on standard input, so no quoting by wsl.exe or PowerShell touches its variables. Line endings are
    normalized to LF. Throws on a nonzero exit code.
    .PARAMETER Script
    Bash script text.
    .OUTPUTS
    The output lines of the script.
    #>
    param([Parameter(Mandatory)][string]$Script)

    $out = ($Script -replace "`r`n", "`n") | wsl -d $Distro -- bash -s
    if ($LASTEXITCODE -ne 0) { throw "WSL script failed with exit code $LASTEXITCODE" }
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

#region Build script (runs in WSL)
# Stages only what the package installs, because the SDK writes its build stamps into the source directory it is given.
# The newest apk is taken, since the apk of an earlier version may still be in the SDK's bin folder.
$buildScript = @'
set -eu
SRC='@@SRC@@'
OUT='@@OUT@@'
STAGE="$HOME/sdk/src/flab-ui"
LOG=/tmp/flab-ui-build.log
SDK=$(ls -d @@SDK@@ 2>/dev/null | head -n 1 || true)
[ -n "$SDK" ] || { echo "No OpenWrt SDK found at: @@SDK@@" >&2; exit 1; }
rm -rf "$STAGE"
mkdir -p "$STAGE" "$OUT"
rsync -a "$SRC/www" "$SRC/rpcd" "$SRC/LICENSE" "$STAGE/"
cd "$SDK"
make package/flab-ui/clean > "$LOG" 2>&1 || { tail -40 "$LOG" >&2; exit 1; }
make package/flab-ui/compile USE_SOURCE_DIR="$STAGE" >> "$LOG" 2>&1 || { tail -40 "$LOG" >&2; exit 1; }
APK=$(ls -t "$SDK"/bin/packages/*/packages/flab-ui-*.apk | head -n 1)
rm -f "$OUT"/flab-ui-*.apk
cp "$APK" "$OUT/"
basename "$APK"
'@
#endregion

#region Actions
switch ($Action) {
    'Deploy' {
        # The plugins are the source of truth for which ubus objects must appear (one object per plugin file).
        $expected = @(Get-ChildItem (Join-Path $root 'rpcd\ucode') -Filter 'flab.*.uc' | ForEach-Object { $_.BaseName })
        if (-not $expected) { throw 'No rpcd plugin found in rpcd/ucode.' }

        $outDir = Join-Path ([IO.Path]::GetTempPath()) 'flab-apk'
        New-Item -ItemType Directory $outDir -Force | Out-Null

        Write-Host 'Building the package from the working tree...'
        $script = $buildScript.Replace('@@SRC@@', (ConvertTo-WslPath $root)).Replace('@@OUT@@', (ConvertTo-WslPath $outDir)).Replace('@@SDK@@', $Sdk)
        $apkName = @(Invoke-Wsl $script)[-1]
        $apk = Join-Path $outDir $apkName
        if (-not (Test-Path $apk)) { throw "The built package is missing: $apk" }

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
