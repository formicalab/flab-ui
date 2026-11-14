#Requires -Version 7.0
<#
.SYNOPSIS
Builds, installs, removes and releases the flab-ui OpenWrt package.

.DESCRIPTION
Build     builds the apk from the working tree with an OpenWrt SDK and writes it to -OutDir.
Deploy    builds, copies the apk to the router, removes the installed flab-ui and adds the new one (installing and
          removing reload rpcd; the package's own scripts do that), then waits until every flab.* ubus object of
          rpcd/ucode exists and the page answers over HTTPS.
Remove    runs apk del on the router and checks that no flab.* object is left.
Release   tags the source, updates the package Makefile to match, builds the apk from the tag and publishes it:
            1. checks that this repository is on main, clean and pushed, that the tag does not exist, and that the packages
               checkout (-PackagesDir, a checkout of the openwrt/packages feed branch that holds admin/flab-ui) is clean;
            2. creates and pushes the tag v<Version>;
            3. downloads the tag's source tarball and writes PKG_VERSION, PKG_HASH (its SHA-256) and PKG_RELEASE:=1 into
               the Makefile;
            4. builds the apk from that tarball, so the SDK checks the hash, and installs it on -Router as a check
               (skipped with -SkipInstallCheck);
            5. commits the Makefile in the packages checkout and pushes it to -Remote;
            6. creates the GitHub release with the apk and its SHA-256 file.
          The Makefile cannot live in this repository: PKG_HASH is the hash of the tag's tarball, which would contain
          the Makefile. If a step before the release fails, the tag created by this run is deleted again and the
          Makefile is restored. The tag and the packages commit use your git identity (git config, or
          GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL); it must match the Signed-off-by line of the package commit.

The OpenWrt SDK only runs on Linux. On Linux the build runs directly in bash; on Windows it runs inside WSL (-Distro)
and the working tree is reached through /mnt. The SDK must already be set up, with the feed that holds admin/flab-ui
(a src-link to a checkout of openwrt/packages) installed and CONFIG_PACKAGE_flab-ui=m in its .config; see
docs/package.md. The router must run an apk-based OpenWrt (a snapshot or a release built with apk).

A Deploy or Remove replaces the plugins that serve the signed-in pages, so do not run one while a browser test is
running on the same router.

.PARAMETER Action
Build, Deploy, Remove or Release (see the description).

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
Release always does.

.PARAMETER Version
Release only: the version without the leading v, for example 0.1.1.

.PARAMETER PackagesDir
Release only: checkout of the openwrt/packages feed branch that holds admin/flab-ui. Defaults to the FLAB_PACKAGES
environment variable, else a folder named packages next to this repository.

.PARAMETER Remote
Release only: remote of the packages checkout that receives the branch (a fork, never openwrt/packages itself).

.PARAMETER Amend
Release only: fold the Makefile change into the package commit at the tip of the branch (force-pushing with lease)
instead of adding a commit "flab-ui: update to <Version>". Use it while the package is not merged yet and is one commit.

.PARAMETER SkipInstallCheck
Release only: build only; do not install the apk on a router.

.PARAMETER Draft
Release only: create the GitHub release as a draft.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Build', 'Deploy', 'Remove', 'Release')][string]$Action,
    [string]$Router = $(if ($env:FLAB_ROUTER) { $env:FLAB_ROUTER } else { 'root@192.168.1.1' }),
    [ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Distro = 'Ubuntu-26.04',
    [ValidatePattern('^[A-Za-z0-9._/$*~-]+$')][string]$Sdk = '$HOME/sdk/openwrt-sdk-*',
    [string]$OutDir = (Join-Path ([IO.Path]::GetTempPath()) 'flab-apk'),
    [switch]$UseFeedSource,
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [string]$PackagesDir = $(if ($env:FLAB_PACKAGES) { $env:FLAB_PACKAGES } else { Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) 'packages' }),
    [string]$Remote = 'fork',
    [switch]$Amend,
    [switch]$SkipInstallCheck,
    [switch]$Draft
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

function Invoke-Native {
    <#
    .SYNOPSIS
    Runs a native command, returns its output lines and throws on a nonzero exit code.
    .PARAMETER File
    The program.
    .PARAMETER Arguments
    Its arguments.
    .OUTPUTS
    The output lines.
    #>
    param([Parameter(Mandatory)][string]$File, [string[]]$Arguments = @())

    $out = & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
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

function Set-MakeVariable {
    <#
    .SYNOPSIS
    Sets a PKG_* variable of a Makefile text, keeping its line endings.
    .PARAMETER Text
    The Makefile text.
    .PARAMETER Name
    The variable, for example PKG_VERSION.
    .PARAMETER Value
    The new value.
    .OUTPUTS
    The changed text. Throws when the variable is not exactly once in it.
    #>
    param([string]$Text, [string]$Name, [string]$Value)

    $pattern = "(?m)^(${Name}:=).*?(\r?)$"
    if ([regex]::Matches($Text, $pattern).Count -ne 1) { throw "$Name must be set exactly once in the Makefile." }
    return [regex]::Replace($Text, $pattern, ('${1}' + $Value + '${2}'))
}
#endregion

#region Build
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
    Builds the apk with the SDK and returns the path of the apk in -OutDir.
    .PARAMETER FromFeed
    Build from the source the feed Makefile names instead of the working tree.
    .OUTPUTS
    String.
    #>
    param([switch]$FromFeed)

    New-Item -ItemType Directory $OutDir -Force | Out-Null
    Write-Host $(if ($FromFeed) { 'Building the package from the source the feed Makefile names...' } else { 'Building the package from the working tree...' })
    $feed = if ($FromFeed) { '1' } else { '0' }
    $script = $buildScript.Replace('@@SRC@@', (ConvertTo-BuildPath $root)).Replace('@@OUT@@', (ConvertTo-BuildPath (Resolve-Path $OutDir).Path)).Replace('@@SDK@@', $Sdk).Replace('@@FEED@@', $feed)
    $apk = Join-Path $OutDir @(Invoke-Bash $script)[-1]
    if (-not (Test-Path $apk)) { throw "The built package is missing: $apk" }
    Write-Host "Built $apk"
    return $apk
}
#endregion

#region Install
function Install-Package {
    <#
    .SYNOPSIS
    Installs a built apk on the router, replacing the installed flab-ui, and checks that it works.
    .DESCRIPTION
    The installed package is removed first because apk does not reinstall an apk of the version that is already
    installed. Then it waits until rpcd serves one flab.* object per plugin in rpcd/ucode/ (the plugins are the source
    of truth) and the page answers over HTTPS.
    .PARAMETER Apk
    Path of the apk.
    #>
    param([Parameter(Mandatory)][string]$Apk)

    $expected = @(Get-ChildItem (Join-Path (Join-Path $root 'rpcd') 'ucode') -Filter 'flab.*.uc' | ForEach-Object { $_.BaseName })
    if (-not $expected) { throw 'No rpcd plugin found in rpcd/ucode.' }
    $apkName = Split-Path $Apk -Leaf

    Write-Host "Installing $apkName on the router..."
    scp -O -q $Apk "${Router}:/tmp/$apkName"
    if ($LASTEXITCODE -ne 0) { throw "scp failed with exit code $LASTEXITCODE" }
    Invoke-Remote @"
set -e
if apk info -e flab-ui >/dev/null 2>&1; then apk del flab-ui; fi
apk add --allow-untrusted /tmp/$apkName
rm -f /tmp/$apkName
"@ | Write-Host

    Wait-Objects -Expected $expected
    $hostName = $Router.Split('@')[-1]
    $page = Invoke-WebRequest -Uri "https://$hostName/flab/" -SkipCertificateCheck
    if ($page.StatusCode -ne 200) { throw "The page answered HTTP $($page.StatusCode)." }
    Write-Host "Installed: $($expected.Count) rpcd objects. Open https://$hostName/flab/ and sign in as root."
}
#endregion

#region Release
function Publish-Release {
    <#
    .SYNOPSIS
    Tags the source, aligns the package Makefile, builds the apk from the tag and creates the GitHub release.
    .DESCRIPTION
    See the Release action in the script help. Throws when a check fails or a step fails; before the release is
    published the tag created by this run is deleted again and the Makefile is restored.
    #>
    if (-not $Version) { throw '-Version is required for Release.' }
    $tag = "v$Version"
    $makefile = Join-Path (Join-Path (Join-Path $PackagesDir 'admin') 'flab-ui') 'Makefile'

    # Checks: nothing is changed until they all pass.
    $slug = ((Invoke-Native git @('-C', $root, 'remote', 'get-url', 'origin')) -replace '^.*github\.com[:/]', '' -replace '\.git$', '')
    if ($slug -notmatch '^[\w.-]+/[\w.-]+$') { throw "Cannot find the GitHub repository in the origin URL: $slug" }
    if (-not (Test-Path $makefile)) { throw "No Makefile at $makefile; set -PackagesDir." }
    if ((Invoke-Native git @('-C', $root, 'branch', '--show-current')) -ne 'main') { throw 'Release from the main branch.' }
    if (Invoke-Native git @('-C', $root, 'status', '--porcelain')) { throw 'The working tree is not clean.' }
    $null = Invoke-Native git @('-C', $root, 'fetch', '--quiet', 'origin', 'main')
    if ((Invoke-Native git @('-C', $root, 'rev-parse', 'HEAD')) -ne (Invoke-Native git @('-C', $root, 'rev-parse', 'origin/main'))) { throw 'main is not the same as origin/main: push or pull first.' }
    if (Invoke-Native git @('-C', $root, 'tag', '--list', $tag)) { throw "The tag $tag already exists." }
    if (Invoke-Native git @('-C', $root, 'ls-remote', '--tags', 'origin', "refs/tags/$tag")) { throw "The tag $tag already exists on origin." }
    if (Invoke-Native git @('-C', $PackagesDir, 'status', '--porcelain')) { throw "The packages checkout $PackagesDir is not clean." }
    $packagesBranch = Invoke-Native git @('-C', $PackagesDir, 'branch', '--show-current')
    if (-not $packagesBranch -or $packagesBranch -in 'master', 'main') { throw "Check out a feature branch in $PackagesDir first (now: '$packagesBranch')." }
    if ((Invoke-Native git @('-C', $PackagesDir, 'remote', 'get-url', $Remote)) -match 'github\.com[:/]openwrt/') { throw "Remote $Remote is openwrt/packages itself; use a fork." }
    $null = Invoke-Native gh @('auth', 'status')

    $originalMakefile = [IO.File]::ReadAllText($makefile)
    $tagPushed = $false
    $packagesPushed = $false
    $released = $false
    try {
        Write-Host "Tagging $tag..."
        $null = Invoke-Native git @('-C', $root, 'tag', '-a', $tag, '-m', "flab-ui $Version")
        $null = Invoke-Native git @('-C', $root, 'push', '--quiet', 'origin', $tag)
        $tagPushed = $true

        # The hash is taken from the tarball GitHub serves for the tag, the same file the SDK downloads.
        $tarball = Join-Path ([IO.Path]::GetTempPath()) "flab-ui-$Version.tar.gz"
        Invoke-WebRequest -Uri "https://codeload.github.com/$slug/tar.gz/$tag" -OutFile $tarball
        $sourceHash = (Get-FileHash $tarball -Algorithm SHA256).Hash.ToLower()
        Write-Host "Source tarball SHA-256: $sourceHash"

        $text = $originalMakefile
        $text = Set-MakeVariable $text 'PKG_VERSION' $Version
        $text = Set-MakeVariable $text 'PKG_RELEASE' '1'
        $text = Set-MakeVariable $text 'PKG_HASH' $sourceHash
        [IO.File]::WriteAllText($makefile, $text, [Text.UTF8Encoding]::new($false))

        # Build from the tarball the Makefile now names, so the SDK checks PKG_HASH; install it when asked to.
        $script:OutDir = Join-Path ([IO.Path]::GetTempPath()) 'flab-release'
        Remove-Item $OutDir -Recurse -Force -ErrorAction SilentlyContinue
        $builtApk = Build-Package -FromFeed
        $apkName = Split-Path $builtApk -Leaf
        if ($apkName -ne "flab-ui-$Version-r1.apk") { throw "Expected flab-ui-$Version-r1.apk, built $apkName" }
        if (-not $SkipInstallCheck) { Install-Package $builtApk }
        $apkHash = (Get-FileHash $builtApk -Algorithm SHA256).Hash.ToLower()
        $sumFile = "$builtApk.sha256"
        [IO.File]::WriteAllText($sumFile, "$apkHash  $apkName`n", [Text.UTF8Encoding]::new($false))

        Write-Host 'Committing the Makefile in the packages checkout...'
        $null = Invoke-Native git @('-C', $PackagesDir, 'add', 'admin/flab-ui/Makefile')
        if ($Amend) {
            $null = Invoke-Native git @('-C', $PackagesDir, 'commit', '--quiet', '--amend', '--no-edit')
            $null = Invoke-Native git @('-C', $PackagesDir, 'push', '--quiet', '--force-with-lease', $Remote, $packagesBranch)
        }
        else {
            $null = Invoke-Native git @('-C', $PackagesDir, 'commit', '--quiet', '--signoff', '-m', "flab-ui: update to $Version")
            $null = Invoke-Native git @('-C', $PackagesDir, 'push', '--quiet', $Remote, $packagesBranch)
        }
        $packagesPushed = $true

        $notes = @"
flab-ui $Version

An architecture-independent apk (``noarch``) for apk-based OpenWrt. Install it on the router:

``````sh
scp -O $apkName root@<router>:/tmp/
ssh root@<router> 'apk add --allow-untrusted /tmp/$apkName'
``````

Then open ``https://<router>/flab/`` and sign in as root. The package is unsigned, so apk needs ``--allow-untrusted``.

SHA-256 of ``$apkName``: ``$apkHash``
It was built by the OpenWrt SDK from the source tarball of this tag (SHA-256 ``$sourceHash``).
"@
        $releaseArgs = @('release', 'create', $tag, $builtApk, $sumFile, '--repo', $slug, '--verify-tag', '--title', "flab-ui $Version", '--notes', $notes)
        if ($Draft) { $releaseArgs += '--draft' }
        $null = Invoke-Native gh $releaseArgs
        $released = $true
        Write-Host "Released: https://github.com/$slug/releases/tag/$tag"
    }
    catch {
        if ($packagesPushed -and -not $released) {
            # The pushed Makefile names this tag, so keep the tag; only the GitHub release is missing.
            Write-Warning "The tag and the packages branch are published; only the release is missing: $($_.Exception.Message). Create it with gh release create $tag."
        }
        elseif (-not $released) {
            Write-Warning "Release failed: $($_.Exception.Message)"
            [IO.File]::WriteAllText($makefile, $originalMakefile, [Text.UTF8Encoding]::new($false))
            if ($tagPushed) {
                Write-Warning "Deleting the tag $tag created by this run."
                & git -C $root push --quiet origin ":refs/tags/$tag"
                & git -C $root tag -d $tag | Out-Null
            }
            else { & git -C $root tag -d $tag 2>$null | Out-Null }
        }
        throw
    }
}
#endregion

#region Actions
switch ($Action) {
    'Build' { $null = Build-Package -FromFeed:$UseFeedSource }
    'Deploy' { Install-Package (Build-Package -FromFeed:$UseFeedSource) }
    'Remove' {
        Invoke-Remote 'if apk info -e flab-ui >/dev/null 2>&1; then apk del flab-ui; else echo "flab-ui is not installed."; fi' | Write-Host
        Wait-Objects
        Write-Host 'Removed; no flab.* ubus object is left.'
    }
    'Release' { Publish-Release }
}
#endregion
