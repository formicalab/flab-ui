#Requires -Version 7.0
<#
.SYNOPSIS
Builds, installs, removes and releases the flab-ui OpenWrt package.

.DESCRIPTION
Build     builds the apk from the working tree with an OpenWrt SDK and writes it to -OutDir. The apk is named
          flab-ui-<version>-r<UTC time>.apk, where the version is the Makefile's, so it is never mistaken for a release.
Deploy    builds, copies the apk to the router, removes the installed flab-ui and adds the new one (installing and
          removing restarts rpcd; the package's own scripts do that), then waits until every flab.* ubus object of
          rpcd/ucode exists, the page answers over HTTPS and the router reports the version that was built.
Sync      the fast loop for editing: copies www/ to /www/flab on the router without building an apk (with -Backend,
          also rpcd/ and restarts rpcd). Browsers pick the new files up when the page is reloaded.
Check     reports whether the Makefile version/release, the Git tag, PKG_HASH, CHANGELOG.md, the GitHub release's apk
          and the router's installed apk agree. Fails on any mismatch.
Remove    removes every installed flab-ui package, cleans flab-owned files and checks for package, file and rpcd residue.
Release   validates the source repository, dispatches the hosted release workflow and waits for it. GitHub Actions
          tags v<Version>, updates the package-feed source hash, builds all APKs with an OpenWrt SDK, and publishes the
          release. -DryRun performs the same hosted SDK build without tagging or publishing.

The OpenWrt SDK only runs on Linux. On Linux the build runs directly in bash; on Windows it runs inside WSL (-Distro)
and the working tree is reached through /mnt. The SDK must already be set up, with the feed that holds admin/flab-ui
(a src-link to a checkout of openwrt/packages) installed and CONFIG_PACKAGE_flab-ui=m in its .config; see
docs/package.md. The router must run an apk-based OpenWrt (a snapshot or a release built with apk).

A Deploy or Remove replaces the plugins that serve the signed-in pages, so do not run one while a browser test is
running on the same router.

.PARAMETER Action
Build, Deploy, Sync, Check, Remove or Release (see the description).

.PARAMETER Backend
Sync only: also copy rpcd/ and restart rpcd. Never use while a configuration apply awaits confirmation.

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

.PARAMETER Version
Release only: the version without the leading v, for example 0.1.1.

.PARAMETER PackagesDir
Check only: checkout of the packages repository (the flab-ui branch) that holds admin/flab-ui. Defaults to the
FLAB_PACKAGES environment variable, else a folder named packages next to this repository.

.PARAMETER Remote
Check only: remote of the packages checkout to compare with.

.PARAMETER Amend
Hosted release only: fold the package Makefile change into the package commit at the tip of the branch (force-pushing
with lease) instead of adding a commit "flab-ui: update to <Version>".

.PARAMETER Draft
Hosted release only: create the GitHub release as a draft.

.PARAMETER NotesFile
Release only, required: UTF-8 file containing the actual changelog for this version. Installation instructions and
asset/source SHA-256 notes are appended automatically. Must be a tracked file of this repository; it is read and
validated before any Git state is changed.

.PARAMETER DryRun
Hosted release only: build all release APKs on GitHub without tagging or publishing.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Build', 'Deploy', 'Sync', 'Check', 'Remove', 'Release')][string]$Action,
    [string]$Router = $(if ($env:FLAB_ROUTER) { $env:FLAB_ROUTER } else { 'root@192.168.1.1' }),
    [ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Distro = 'Ubuntu-26.04',
    [ValidatePattern('^[A-Za-z0-9._/$*~-]+$')][string]$Sdk = '$HOME/sdk/openwrt-sdk-*',
    [string]$OutDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'artifacts\packages'),
    [switch]$UseFeedSource,
    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')][string]$Version,
    [string]$PackagesDir = $(if ($env:FLAB_PACKAGES) { $env:FLAB_PACKAGES } else { Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) 'packages' }),
    [string]$Remote = 'fork',
    [switch]$Amend,
    [switch]$Backend,
    [switch]$Draft,
    [string]$NotesFile,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent

#region Helpers
function Assert-RouterName {
    <#
    .SYNOPSIS
    Rejects a -Router value that ssh or scp could take for an option or that is not a plain destination.
    .DESCRIPTION
    The value is passed to ssh and scp as an argument and its host part is used in an https URL. A leading dash would
    make ssh parse it as an option (for example -oProxyCommand=...), so only user@host forms are accepted.
    #>
    if ($Router -notmatch '^[A-Za-z0-9][A-Za-z0-9._@:%\[\]-]*$') {
        throw "-Router must be a plain ssh destination such as root@192.168.1.1, not '$Router'."
    }
}

function Test-FlabPage {
    <#
    .SYNOPSIS
    Checks that the router serves the flab-ui page over HTTPS and returns its host name.
    .DESCRIPTION
    The router normally has a self-signed certificate, so the certificate is not validated: this only proves that
    uhttpd serves /flab/, it does not authenticate the router.
    .OUTPUTS
    The host part of -Router.
    #>
    $hostName = $Router.Split('@')[-1]
    $page = Invoke-WebRequest -Uri "https://$hostName/flab/" -SkipCertificateCheck
    if ($page.StatusCode -ne 200) { throw "The page answered HTTP $($page.StatusCode)." }
    return $hostName
}

function Get-ArtifactEntries {
    <#
    .SYNOPSIS
    Returns the source files and install targets declared by tools/artifact-manifest.json.
    .DESCRIPTION
    Validates the manifest, expands each source directory and produces the exact paths expected in the package.
    .OUTPUTS
    Objects with Source, RelativePath and Target properties.
    #>
    $path = Join-Path $root 'tools\artifact-manifest.json'
    $manifest = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if (-not $manifest.entries) { throw "The artifact manifest has no entries: $path" }
    $entries = foreach ($entry in $manifest.entries) {
        $glob = $entry.PSObject.Properties['glob']?.Value
        $source = Join-Path $root ($entry.source -replace '/', '\')
        if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Artifact source directory is missing: $($entry.source)" }
        $files = @(Get-ChildItem -LiteralPath $source -Recurse -File)
        if ($glob) { $files = @($files | Where-Object { $_.Name -like $glob }) }
        if (-not $files) { throw "Artifact source has no matching files: $($entry.source)" }
        foreach ($file in $files) {
            $relative = [IO.Path]::GetRelativePath($source, $file.FullName) -replace '\\', '/'
            [pscustomobject]@{
                Source = $file.FullName
                RelativePath = $relative
                Target = ($entry.target.TrimEnd('/') + '/' + $relative)
            }
        }
    }
    if (-not $entries) { throw 'The artifact manifest resolved to no files.' }
    return $entries
}

function Test-ArtifactContract {
    <#
    .SYNOPSIS
    Checks the source artifact manifest before a build or sync.
    .DESCRIPTION
    Ensures every declared artifact exists, targets are absolute and plugin/ACL names remain paired.
    #>
    $entries = @(Get-ArtifactEntries)
    $targets = @($entries | ForEach-Object Target)
    if ($targets.Count -ne @($targets | Select-Object -Unique).Count) { throw 'The artifact manifest maps two source files to the same install path.' }
    $plugins = @($entries | Where-Object { $_.Target -like '/usr/share/rpcd/ucode/flab.*.uc' } | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_.Target) })
    $acls = @($entries | Where-Object { $_.Target -like '/usr/share/rpcd/acl.d/flab-*.json' } | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_.Target) })
    foreach ($plugin in $plugins) {
        $expectedAcl = $plugin.Replace('flab.', 'flab-')
        if ($expectedAcl -notin $acls) { throw "Missing ACL artifact $expectedAcl.json for $plugin." }
    }
    foreach ($entry in $entries) {
        if (-not $entry.Target.StartsWith('/')) { throw "Artifact target must be absolute: $($entry.Target)" }
        if ($entry.Target -match '\s') { throw "Artifact target contains whitespace and cannot use sha256sum -c: $($entry.Target)" }
        if (-not (Test-Path -LiteralPath $entry.Source -PathType Leaf)) { throw "Artifact file is missing: $($entry.Source)" }
    }
    return $entries
}

function Get-InstalledArtifactHash {
    <#
    .SYNOPSIS
    Returns the hash expected for an artifact after package installation.
    .DESCRIPTION
    OpenWrt-owned ACL copies are normalized to LF in the packages tree. Feed builds also contain Git's LF form of
    text files, while working-tree builds retain the checkout bytes.
    .PARAMETER Entry
    One resolved artifact-manifest entry.
    .PARAMETER FromFeed
    The artifact came from the immutable Git tag tarball rather than the local working tree.
    .OUTPUTS
    The lowercase SHA-256 hash installed on the router.
    #>
    param([Parameter(Mandatory)]$Entry, [switch]$FromFeed)

    $textExtensions = @('.css', '.html', '.js', '.json', '.md', '.uc', '')
    $extension = [IO.Path]::GetExtension($Entry.Source)
    if ($Entry.Target -like '/usr/share/rpcd/acl.d/flab-*.json' -or ($FromFeed -and $extension -in $textExtensions)) {
        $text = [IO.File]::ReadAllText($Entry.Source).Replace("`r`n", "`n").Replace("`r", "`n")
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
        return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    }
    return (Get-FileHash -LiteralPath $Entry.Source -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-InstalledArtifacts {
    <#
    .SYNOPSIS
    Verifies the installed flab-ui file contract on the router.
    .DESCRIPTION
    Checks every manifest target with sha256sum and rejects extra files under /www/flab and in the plugin, library
    and ACL directories.
    .PARAMETER Entries
    Resolved artifact-manifest entries.
    .PARAMETER FromFeed
    Compare against the Git tag form of the files (see Get-InstalledArtifactHash).
    #>
    param([Parameter(Mandatory)]$Entries, [switch]$FromFeed)

    $checks = @($Entries | ForEach-Object { "$(Get-InstalledArtifactHash -Entry $_ -FromFeed:$FromFeed)  $($_.Target)" })
    $local = Join-Path ([IO.Path]::GetTempPath()) ("flab-artifacts-$PID.txt")
    $remote = "/tmp/flab-artifacts-$PID.expected"
    [IO.File]::WriteAllText($local, (($checks -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
    try {
        scp -O -q $local "${Router}:$remote"
        if ($LASTEXITCODE -ne 0) { throw "scp failed with exit code $LASTEXITCODE" }
        Invoke-Remote @"
set -eu
trap 'rm -f $remote /tmp/flab-artifacts.paths /tmp/flab-artifacts.actual /tmp/flab-artifacts.web /tmp/flab-artifacts.group' EXIT
out=`$(sha256sum -c $remote) || { printf '%s\n' "`$out" | grep -v ': OK`$' >&2; exit 1; }
awk '{ print `$2 }' $remote > /tmp/flab-artifacts.paths
find /www/flab -type f | sort > /tmp/flab-artifacts.actual
grep '^/www/flab/' /tmp/flab-artifacts.paths | sort > /tmp/flab-artifacts.web
if ! cmp /tmp/flab-artifacts.web /tmp/flab-artifacts.actual; then
  echo 'Installed /www/flab file set differs from the artifact manifest.' >&2
  diff -u /tmp/flab-artifacts.web /tmp/flab-artifacts.actual >&2 || true
  exit 1
fi
check_group() {
  dir="`$1"; pattern="`$2"
  find "`$dir" -maxdepth 1 -type f -name "`$pattern" | sort > /tmp/flab-artifacts.actual
  grep "^`$dir/" /tmp/flab-artifacts.paths | sort > /tmp/flab-artifacts.group
  if ! cmp /tmp/flab-artifacts.group /tmp/flab-artifacts.actual; then
    echo "Installed artifact group differs from the manifest: `$dir" >&2
    diff -u /tmp/flab-artifacts.group /tmp/flab-artifacts.actual >&2 || true
    exit 1
  fi
}
check_group /usr/share/rpcd/ucode 'flab.*.uc'
check_group /usr/share/ucode/flab '*.uc'
check_group /usr/share/rpcd/acl.d 'flab-*.json'
"@ | Write-Host
    }
    finally {
        Remove-Item -LiteralPath $local -ErrorAction SilentlyContinue
    }
}

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
    .DESCRIPTION
    Checks the native exit status immediately, including Git operations used by release recovery.
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
    rpcd restarts during package scripts, but ubus registration can finish a moment later.
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

function Get-InstalledFlabPackages {
    <#
    .SYNOPSIS
    Returns the installed flab-ui package names.
    .DESCRIPTION
    Reads apk's installed package names and accepts only the metapackage, base package and feature-module names.
    .OUTPUTS
    Installed flab-ui package names without versions.
    #>
    $names = @(Invoke-Remote "apk info 2>/dev/null | grep -E '^flab-ui($|-(base|mod-[A-Za-z0-9-]+)$)' || true" |
        Where-Object { $_ } |
        Sort-Object -Unique)
    foreach ($name in $names) {
        if ($name -notmatch '^flab-ui(?:-base|-mod-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)?$') {
            throw "Router returned an invalid installed package name: '$name'."
        }
    }
    return $names
}

function Test-FlabRemoved {
    <#
    .SYNOPSIS
    Verifies that flab-ui packages, runtime objects and owned files are absent from the router.
    .DESCRIPTION
    Checks the package database, waits for rpcd object removal and rejects any remaining web, backend, ACL or
    temporary package files.
    .PARAMETER ObjectTimeoutSeconds
    How long to wait for rpcd's ubus objects to disappear.
    #>
    param([int]$ObjectTimeoutSeconds = 20)

    $packages = @(Get-InstalledFlabPackages)
    if ($packages) { throw "flab-ui packages remain installed: $($packages -join ', ')" }

    Wait-Objects -TimeoutSeconds $ObjectTimeoutSeconds

    $leftovers = @(Invoke-Remote @'
for path in /www/flab /usr/share/ucode/flab; do
  [ ! -e "$path" ] || printf '%s\n' "$path"
done
[ ! -d /usr/share/rpcd/ucode ] || find /usr/share/rpcd/ucode -maxdepth 1 -type f -name 'flab.*.uc' -print
[ ! -d /usr/share/rpcd/acl.d ] || find /usr/share/rpcd/acl.d -maxdepth 1 -type f -name 'flab-*.json' -print
find /tmp -maxdepth 1 -type f \( -name 'flab-ui-*.apk' -o -name 'flab-ui-*.apk.sha256' \) -print 2>/dev/null
'@ | Where-Object { $_ })
    if ($leftovers) { throw "flab-ui files remain on the router: $($leftovers -join ', ')" }
}

function Remove-FlabPackages {
    <#
    .SYNOPSIS
    Completely removes flab-ui from the router.
    .DESCRIPTION
    Removes the metapackage and every independently installed base or feature package, cleans flab-owned paths left
    by development syncs, restarts rpcd and verifies the complete removal.
    #>
    $packages = @(Get-InstalledFlabPackages)
    $remove = if ($packages) { "apk del $($packages -join ' ')" } else { ':' }
    # Sync can install files without apk ownership, so removal must clean those paths after the package transaction.
    Invoke-Remote @"
set -e
$remove
rm -rf /www/flab /usr/share/ucode/flab
[ ! -d /usr/share/rpcd/ucode ] || find /usr/share/rpcd/ucode -maxdepth 1 -type f -name 'flab.*.uc' -exec rm -f {} +
[ ! -d /usr/share/rpcd/acl.d ] || find /usr/share/rpcd/acl.d -maxdepth 1 -type f -name 'flab-*.json' -exec rm -f {} +
rm -f /tmp/flab-ui-*.apk /tmp/flab-ui-*.apk.sha256
/etc/init.d/rpcd restart
"@ | Write-Host
    Test-FlabRemoved
    if ($packages) {
        Write-Host "Removed $($packages -join ', '); no flab-ui package, file or ubus object is left."
    }
    else {
        Write-Host 'flab-ui was not installed; verified no flab-ui package, file or ubus object is present.'
    }
}
#endregion

#region Build
# Stages the shared source tree, because the SDK writes its build stamps into the source directory it is given. The
# staging folder lives in the SDK's own tmp/ and is recreated on every run. Every apk for this package release is
# copied; the unprefixed flab-ui apk is the metapackage returned to the caller.
$buildScript = @'
set -eu
SRC='@@SRC@@'
OUT='@@OUT@@'
SDK=$(ls -d @@SDK@@ 2>/dev/null | head -n 1 || true)
[ -n "$SDK" ] || { echo "No OpenWrt SDK found at: @@SDK@@" >&2; exit 1; }
SDK=$(cd "$SDK" && pwd)
cd "$SDK"
exec 9>"$SDK/.flab-ui-build.lock"
flock -n 9 || { echo "Another flab-ui build is using $SDK." >&2; exit 1; }
LOG="$SDK/.flab-ui-build.log"
if [ ! -f .config ] || ! grep '^CONFIG_PACKAGE_flab-ui=m' .config > /dev/null || ! ls -d package/feeds/*/flab-ui > /dev/null 2>&1; then
  echo "The SDK at $SDK is not set up for flab-ui: install the feed that holds admin/flab-ui and set CONFIG_PACKAGE_flab-ui=m (see docs/package.md)." >&2
  exit 1
fi
STAGE="$SDK/tmp/flab-ui-src"
OVERRIDE="$SDK/.flab-ui-package"
ORIGINAL="$SDK/.flab-ui-package-original"
[ ! -e "$ORIGINAL" ] && [ ! -L "$ORIGINAL" ] || {
  echo "An interrupted build left $ORIGINAL; restore the SDK package entry before retrying." >&2; exit 1;
}
make package/flab-ui/clean > "$LOG" 2>&1 || { tail -40 "$LOG" >&2; exit 1; }
PACKAGE=$(ls -d package/feeds/*/flab-ui | head -n 1)
if [ '@@FEED@@' = 1 ]; then
  make package/flab-ui/compile V=s >> "$LOG" 2>&1 || { tail -40 "$LOG" >&2; exit 1; }
else
  rm -rf "$STAGE" "$OVERRIDE"
  mkdir -p "$STAGE"
  cp -a "$SRC/www" "$SRC/rpcd" "$SRC/LICENSE" "$STAGE/"
  # Files read from a Windows drive in WSL are rwxrwxrwx; the package must not install them that way.
  find "$STAGE" -type d -exec chmod 0755 {} + -o -type f -exec chmod 0644 {} +
  # Temporarily redirect only the SDK's installed package entry; never edit the feed checkout's Makefile.
  bash "$SRC/tools/stage-source.sh" "$PACKAGE" "$OVERRIDE" "$STAGE" '@@DEVREL@@'
  mv "$PACKAGE" "$ORIGINAL"
  restore_package() {
    rm -f "$PACKAGE"
    mv "$ORIGINAL" "$PACKAGE"
    rm -rf "$OVERRIDE"
  }
  trap restore_package EXIT
  ln -s "$OVERRIDE" "$PACKAGE"
  make package/flab-ui/compile V=s >> "$LOG" 2>&1 || { tail -40 "$LOG" >&2; exit 1; }
fi
mkdir -p "$OUT"
VERSION=$(sed -n 's/^PKG_VERSION:=//p' "$PACKAGE/Makefile")
if [ '@@FEED@@' = 1 ]; then
  RELEASE=$(sed -n 's/^PKG_RELEASE:=//p' "$PACKAGE/Makefile")
else
  RELEASE='@@DEVREL@@'
fi
APKS=$(find bin/packages -type f -name "flab-ui*-$VERSION-r$RELEASE.apk" | sort)
[ -n "$APKS" ] || { echo "The build produced no flab-ui apk set (is this an apk-based SDK?). Log: $LOG" >&2; exit 1; }
APK=$(printf '%s\n' "$APKS" | grep "/flab-ui-$VERSION-r$RELEASE.apk$" | head -n 1 || true)
[ -n "$APK" ] || { echo "The build produced no full flab-ui metapackage. Log: $LOG" >&2; exit 1; }
rm -f "$OUT"/flab-ui-*.apk
cp $APKS "$OUT/"
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

    $null = Test-ArtifactContract
    New-Item -ItemType Directory $OutDir -Force | Out-Null
    Write-Host $(if ($FromFeed) { 'Building the package from the source the feed Makefile names...' } else { 'Building the package from the working tree...' })
    $feed = if ($FromFeed) { '1' } else { '0' }
    # A working-tree build gets a release number made of the UTC time (for example flab-ui-0.1.4-r202611151530),
    # which sorts after the published -r1 of the same version and can never be mistaken for it.
    $devRelease = [DateTime]::UtcNow.ToString('yyyyMMddHHmm')
    # The paths go into single-quoted bash strings, so an embedded quote must be closed, escaped and reopened.
    $srcPath = (ConvertTo-BuildPath $root).Replace("'", "'\''")
    $outPath = (ConvertTo-BuildPath (Resolve-Path $OutDir).Path).Replace("'", "'\''")
    $script = $buildScript.Replace('@@SRC@@', $srcPath).Replace('@@OUT@@', $outPath).Replace('@@SDK@@', $Sdk).Replace('@@FEED@@', $feed).Replace('@@DEVREL@@', $devRelease)
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
    .PARAMETER FromFeed
    Verify package bytes against the immutable Git tag form rather than the local checkout form.
    #>
    param([Parameter(Mandatory)][string]$Apk, [switch]$FromFeed)

    $artifacts = @(Test-ArtifactContract)
    $expected = @(Get-ChildItem (Join-Path (Join-Path $root 'rpcd') 'ucode') -Filter 'flab.*.uc' | ForEach-Object { $_.BaseName })
    if (-not $expected) { throw 'No rpcd plugin found in rpcd/ucode.' }
    $apkName = Split-Path $Apk -Leaf
    $apks = @(Get-ChildItem -LiteralPath $OutDir -Filter 'flab-ui-*.apk' -File)
    if ($apks.Count -lt 2) { throw 'The modular build did not produce a complete apk set.' }

    Write-Host "Installing $($apks.Count) modular apks on the router..."
    # Remove first (also cleans files left by Sync, which apk does not own); it deletes /tmp/flab-ui-*.apk, so the
    # new apks are copied afterwards.
    Remove-FlabPackages
    scp -O -q $apks.FullName "${Router}:/tmp/"
    if ($LASTEXITCODE -ne 0) { throw "scp failed with exit code $LASTEXITCODE" }
    Invoke-Remote @"
set -e
trap 'rm -f /tmp/flab-ui-*.apk' EXIT
apk add --allow-untrusted /tmp/flab-ui-*.apk
"@ | Write-Host

    Wait-Objects -Expected $expected
    Test-InstalledArtifacts -Entries $artifacts -FromFeed:$FromFeed
    # The installed version must be the one that was built: the apk file name is name-version-release.apk.
    $installed = (Invoke-Remote 'apk list -I flab-ui 2>/dev/null | head -n 1') -replace '^(\S+).*$', '$1'
    if ($installed -ne [IO.Path]::GetFileNameWithoutExtension($apkName)) { throw "The router reports '$installed', not $apkName." }
    $hostName = Test-FlabPage
    Write-Host "Installed: $($expected.Count) rpcd objects. Open https://$hostName/flab/ and sign in as root."
}
#endregion

#region Release
function Start-HostedRelease {
    <#
    .SYNOPSIS
    Dispatches the hosted build-and-release workflow and waits for it to finish.
    .DESCRIPTION
    Validates that main is clean and pushed, verifies the release notes and tag, then asks GitHub Actions to tag,
    update the packages feed, build the APK set, create checksums and publish the GitHub release. Dry runs stop after
    the hosted APK build. The local workstation needs Git and gh, but not the OpenWrt SDK or WSL.
    #>
    if (-not $Version) { throw '-Version is required for Release.' }
    if (-not $NotesFile) { throw '-NotesFile containing the release changelog is required for Release.' }
    $notesPath = (Resolve-Path -LiteralPath $NotesFile).Path
    $notesRelative = [IO.Path]::GetRelativePath($root, $notesPath).Replace('\', '/')
    if ($notesRelative.StartsWith('../') -or $notesRelative -eq '..') { throw '-NotesFile must be inside the repository.' }
    if (-not [IO.File]::ReadAllText($notesPath).Trim()) { throw '-NotesFile must contain a nonempty release changelog.' }
    if ((Invoke-Native git @('-C', $root, 'branch', '--show-current')) -ne 'main') { throw 'Release from the main branch.' }
    if (Invoke-Native git @('-C', $root, 'status', '--porcelain')) { throw 'The working tree is not clean.' }
    # The hosted workflow reads the notes from its own checkout, so the file must be committed.
    $null = Invoke-Native git @('-C', $root, 'ls-files', '--error-unmatch', '--', $notesRelative)
    $sourceHead = Invoke-Native git @('-C', $root, 'rev-parse', 'HEAD')
    $null = Invoke-Native git @('-C', $root, 'fetch', '--quiet', 'origin', 'main')
    if ($sourceHead -ne (Invoke-Native git @('-C', $root, 'rev-parse', 'origin/main'))) {
        throw 'main is not the same as origin/main: push or pull first.'
    }
    if (-not $DryRun) {
        $tag = "v$Version"
        if (Invoke-Native git @('-C', $root, 'tag', '--list', $tag)) { throw "The tag $tag already exists." }
        if (Invoke-Native git @('-C', $root, 'ls-remote', '--tags', 'origin', "refs/tags/$tag")) {
            throw "The tag $tag already exists on origin."
        }
    }
    $null = Invoke-Native gh @('auth', 'status')

    $requestedAfter = [DateTime]::UtcNow.AddSeconds(-10)
    $null = Invoke-Native gh @(
        'workflow', 'run', 'release.yml', '--ref', 'main',
        '-f', "version=$Version",
        '-f', "notes_file=$notesRelative",
        '-f', "amend=$($Amend.IsPresent.ToString().ToLowerInvariant())",
        '-f', "draft=$($Draft.IsPresent.ToString().ToLowerInvariant())",
        '-f', "dry_run=$($DryRun.IsPresent.ToString().ToLowerInvariant())"
    )

    $run = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $runsJson = (Invoke-Native gh @(
            'run', 'list', '--workflow', 'release.yml', '--branch', 'main',
            '--event', 'workflow_dispatch', '--limit', '10', '--json', 'databaseId,createdAt'
        )) -join "`n"
        $run = @($runsJson | ConvertFrom-Json) | Where-Object {
            $createdAt = if ($_.createdAt -is [DateTime]) {
                ([DateTime]$_.createdAt).ToUniversalTime()
            }
            else {
                [DateTimeOffset]::Parse(
                    $_.createdAt,
                    [Globalization.CultureInfo]::InvariantCulture,
                    [Globalization.DateTimeStyles]::RoundtripKind
                ).UtcDateTime
            }
            $createdAt -ge $requestedAfter
        } | Sort-Object createdAt -Descending | Select-Object -First 1
        if (-not $run) { Start-Sleep -Milliseconds 1000 }
    } while (-not $run -and [DateTime]::UtcNow -lt $deadline)
    if (-not $run) { throw 'GitHub accepted the release request, but the workflow run could not be found.' }

    Write-Host "Hosted release run: https://github.com/formicalab/flab-ui/actions/runs/$($run.databaseId)"
    $null = Invoke-Native gh @('run', 'watch', "$($run.databaseId)", '--exit-status')
    $url = @(Invoke-Native gh @('run', 'view', "$($run.databaseId)", '--json', 'url', '--jq', '.url'))[0]
    Write-Host "Hosted release completed: $url"
}

#endregion

#region Sync
function Sync-Router {
    <#
    .SYNOPSIS
    Copies the working tree's web files (and, with -Backend, the rpcd files) to the installed package on the router, without building an apk.
    .DESCRIPTION
    A fast loop for editing pages. The router's /www/flab is replaced by a copy of www/ (files that no longer exist
    locally disappear). The browser notices the new files by itself the next time the page starts (core/freshness.js).
    With -Backend, rpcd/ is copied to the places the package installs it and rpcd is reloaded; do that only when no
    configuration apply is waiting for confirmation, because the rollback timer lives in rpcd's memory. The flab
    plugins, libraries and ACL files on the router are replaced as a set, so files removed from rpcd/ disappear too.
    The result is not an installed package version: use Deploy for that.
    #>
    $artifacts = @(Test-ArtifactContract)
    $work = Join-Path ([IO.Path]::GetTempPath()) ("flab-sync-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory $work | Out-Null
    try {
        $webTar = Join-Path $work 'web.tar'
        $null = Invoke-Native tar @('--format', 'ustar', '-cf', $webTar, '-C', (Join-Path $root 'www'), '.')
        scp -O -q $webTar "${Router}:/tmp/flab-web.tar"
        if ($LASTEXITCODE -ne 0) { throw "scp failed with exit code $LASTEXITCODE" }
        $backendScript = ''
        if ($Backend) {
            # Stage the manifest's non-web files under their install paths. Only file entries go into the tar: a
            # Windows tar records every directory as 0777, and extracting such entries could widen the permissions
            # of the router's existing /usr directories.
            $stage = Join-Path $work 'stage'
            $staged = foreach ($entry in @($artifacts | Where-Object { $_.Target -notlike '/www/flab/*' })) {
                $relative = $entry.Target.TrimStart('/')
                $destination = Join-Path $stage $relative
                New-Item -ItemType Directory (Split-Path $destination -Parent) -Force | Out-Null
                if ($entry.Target -like '/usr/share/rpcd/acl.d/flab-*.json') {
                    # The packages tree keeps ACL copies with LF line endings; do the same here.
                    $text = [IO.File]::ReadAllText($entry.Source).Replace("`r`n", "`n").Replace("`r", "`n")
                    [IO.File]::WriteAllText($destination, $text, [Text.UTF8Encoding]::new($false))
                }
                else {
                    Copy-Item -LiteralPath $entry.Source -Destination $destination
                }
                $relative
            }
            $backendTar = Join-Path $work 'backend.tar'
            $null = Invoke-Native tar (@('--format', 'ustar', '-cf', $backendTar, '-C', $stage) + @($staged))
            scp -O -q $backendTar "${Router}:/tmp/flab-backend.tar"
            if ($LASTEXITCODE -ne 0) { throw "scp failed with exit code $LASTEXITCODE" }
            $backendScript = @'
mkdir -p /usr/share/rpcd/ucode /usr/share/ucode/flab /usr/share/rpcd/acl.d
find /usr/share/rpcd/ucode -maxdepth 1 -type f -name 'flab.*.uc' -exec rm -f {} +
find /usr/share/ucode/flab -maxdepth 1 -type f -name '*.uc' -exec rm -f {} +
find /usr/share/rpcd/acl.d -maxdepth 1 -type f -name 'flab-*.json' -exec rm -f {} +
tar -xof /tmp/flab-backend.tar -C /
chmod 0644 /usr/share/rpcd/acl.d/flab-*.json /usr/share/rpcd/ucode/flab.*.uc /usr/share/ucode/flab/*.uc
rm -f /tmp/flab-backend.tar
/etc/init.d/rpcd restart
'@
        }
        # Extract beside the live folder and rename, so a request never sees a half-copied tree.
        Invoke-Remote @"
set -e
rm -rf /www/flab.new /www/flab.old
mkdir /www/flab.new
tar -xof /tmp/flab-web.tar -C /www/flab.new
chmod -R u=rwX,go=rX /www/flab.new
[ ! -d /www/flab ] || mv /www/flab /www/flab.old
mv /www/flab.new /www/flab
rm -rf /www/flab.old /tmp/flab-web.tar
$backendScript
"@ | Write-Host
    }
    finally {
        Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($Backend) {
        $expected = @(Get-ChildItem (Join-Path (Join-Path $root 'rpcd') 'ucode') -Filter 'flab.*.uc' | ForEach-Object { $_.BaseName })
        Wait-Objects -Expected $expected
        Test-InstalledArtifacts -Entries $artifacts
    }
    $hostName = Test-FlabPage
    Write-Host "Synchronized. Reload https://$hostName/flab/ (the page refreshes its cached files when it starts)."
}
#endregion

#region Check
function Get-MakeVariable {
    <#
    .SYNOPSIS
    Reads a PKG_* variable of a Makefile text, or $null when it is not set exactly once.
    #>
    param([string]$Text, [string]$Name)

    $found = [regex]::Matches($Text, "(?m)^${Name}:=(.*?)\r?$")
    if ($found.Count -ne 1) { return $null }
    return $found[0].Groups[1].Value.Trim()
}

function Test-Consistency {
    <#
    .SYNOPSIS
    Checks that the package Makefile, the Git tag, the changelog, the GitHub release and the installed apk name the same version.
    .DESCRIPTION
    Prints one line per check and throws when one fails. The network and the router are queried; a router
    that cannot be reached is reported as a failure of that check only. A working-tree build installed on the router
    (a release number made of the time, not 1) is reported, not treated as a failure.
    #>
    $makefile = Join-Path (Join-Path (Join-Path $PackagesDir 'admin') 'flab-ui') 'Makefile'
    if (-not (Test-Path $makefile)) { throw "No Makefile at $makefile; set -PackagesDir." }
    $text = [IO.File]::ReadAllText($makefile)
    $version = Get-MakeVariable $text 'PKG_VERSION'
    $release = Get-MakeVariable $text 'PKG_RELEASE'
    $hash = Get-MakeVariable $text 'PKG_HASH'
    $tag = "v$version"
    $apkName = "flab-ui-$version-r$release.apk"
    $state = @{ Failed = 0 }
    function Report([bool]$Ok, [string]$Message) {
        Write-Host ('{0} {1}' -f $(if ($Ok) { '  ok' } else { 'FAIL' }), $Message)
        if (-not $Ok) { $state.Failed++ }
    }
    Report ([bool]($version -and $release -and $hash)) "Makefile (packages checkout): PKG_VERSION=$version PKG_RELEASE=$release; apk $apkName"

    $slug = ((Invoke-Native git @('-C', $root, 'remote', 'get-url', 'origin')) -replace '^.*github\.com[:/]', '' -replace '\.git$', '')
    $localTag = [bool](Invoke-Native git @('-C', $root, 'tag', '--list', $tag))
    $remoteTag = [bool](Invoke-Native git @('-C', $root, 'ls-remote', '--tags', 'origin', "refs/tags/$tag"))
    Report ($localTag -and $remoteTag) "Git tag ${tag}: local $localTag, on origin $remoteTag"
    if ($localTag) {
        $ahead = [int](Invoke-Native git @('-C', $root, 'rev-list', '--count', "$tag..HEAD"))
        Write-Host ("  --  source is {0} commit(s) past {1}; those are not in the published apk" -f $ahead, $tag)
        $unclean = [bool](Invoke-Native git @('-C', $root, 'status', '--porcelain'))
        if ($unclean) { Write-Host '  --  the working tree has uncommitted changes' }
    }

    $tarball = Join-Path ([IO.Path]::GetTempPath()) "flab-ui-check-$version.tar.gz"
    try {
        Invoke-WebRequest -Uri "https://codeload.github.com/$slug/tar.gz/$tag" -OutFile $tarball
        $actual = (Get-FileHash $tarball -Algorithm SHA256).Hash.ToLower()
        Report ($actual -eq $hash) "PKG_HASH matches the tarball GitHub serves for $tag"
    }
    catch { Report $false "PKG_HASH: cannot download the tarball of ${tag}: $($_.Exception.Message)" }
    finally { Remove-Item $tarball -ErrorAction SilentlyContinue }

    $changelog = [IO.File]::ReadAllText((Join-Path $root 'CHANGELOG.md'))
    Report ($changelog -match "(?m)^## $([regex]::Escape($version)) ") "CHANGELOG.md has a section for $version"

    try {
        $assets = @((Invoke-Native gh @('release', 'view', $tag, '--repo', $slug, '--json', 'assets', '--jq', '.assets[].name')))
        Report (($assets -contains $apkName) -and ($assets -contains "$apkName.sha256")) "GitHub release $tag has $apkName and its .sha256"
    }
    catch { Report $false "GitHub release ${tag}: $($_.Exception.Message)" }

    $branch = Invoke-Native git @('-C', $PackagesDir, 'branch', '--show-current')
    $clean = -not (Invoke-Native git @('-C', $PackagesDir, 'status', '--porcelain'))
    $remoteHead = @(Invoke-Native git @('-C', $PackagesDir, 'ls-remote', '--heads', $Remote, "refs/heads/$branch"))
    $pushed = $remoteHead.Count -gt 0 -and (($remoteHead[0] -split '\s+')[0] -eq (Invoke-Native git @('-C', $PackagesDir, 'rev-parse', 'HEAD')))
    Report ($clean -and $pushed) "packages checkout on $branch is clean and equals $Remote/$branch"

    try {
        $installed = (Invoke-Remote 'apk list -I flab-ui 2>/dev/null | head -n 1') -replace '^(\S+).*$', '$1'
        if (-not $installed) { Report $false 'router: flab-ui is not installed' }
        elseif ($installed -eq [IO.Path]::GetFileNameWithoutExtension($apkName)) { Report $true "router has $installed" }
        elseif ($installed -match "^flab-ui-$([regex]::Escape($version))-r\d{12}$") { Write-Host "  --  router has the working-tree build $installed" }
        else { Report $false "router has $installed, the Makefile names $([IO.Path]::GetFileNameWithoutExtension($apkName))" }
    }
    catch { Report $false "router: $($_.Exception.Message)" }

    if ($state.Failed) { throw "$($state.Failed) consistency check(s) failed." }
}
#endregion

#region Actions
if ($MyInvocation.InvocationName -eq '.') { return }
if ($Action -in 'Deploy', 'Sync', 'Check', 'Remove') { Assert-RouterName }
switch ($Action) {
    'Build' { $null = Build-Package -FromFeed:$UseFeedSource }
    'Deploy' {
        $apk = Build-Package -FromFeed:$UseFeedSource
        Install-Package $apk -FromFeed:$UseFeedSource
    }
    'Sync' { Sync-Router }
    'Check' { Test-Consistency }
    'Remove' { Remove-FlabPackages }
    'Release' { Start-HostedRelease }
}
#endregion
