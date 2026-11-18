#Requires -Version 7.0
<#
.SYNOPSIS
Builds, installs, removes and releases the flab-ui OpenWrt package.

.DESCRIPTION
Build     builds the apk from the working tree with an OpenWrt SDK and writes it to -OutDir. The apk is named
          flab-ui-<version>-r<UTC time>.apk, where the version is the Makefile's, so it is never mistaken for a release.
Deploy    builds, copies the apk to the router, removes the installed flab-ui and adds the new one (installing and
          removing reload rpcd; the package's own scripts do that), then waits until every flab.* ubus object of
          rpcd/ucode exists, the page answers over HTTPS and the router reports the version that was built.
Sync      the fast loop for editing: copies www/ to /www/flab on the router without building an apk (with -Backend,
          also rpcd/ and reloads rpcd). Browsers pick the new files up when the page is reloaded.
Check     reports whether the Makefile version/release, the Git tag, PKG_HASH, CHANGELOG.md, the GitHub release's apk
          and the router's installed apk agree. Fails on any mismatch.
Remove    runs apk del on the router and checks that no flab.* object is left.
Release   tags the source, updates the package Makefile to match, builds the apk from the tag and publishes it:
            1. checks that this repository is on main, clean and pushed, that the tag does not exist, and that the packages
               checkout (-PackagesDir, a checkout of the openwrt/packages feed branch that holds admin/flab-ui) is clean;
            2. creates and pushes the tag v<Version>;
            3. downloads the tag's source tarball and writes PKG_VERSION, PKG_HASH (its SHA-256) and PKG_RELEASE:=1 into
               the Makefile; when this source has www/LICENSE, also sets PKG_LICENSE_FILES:=LICENSE www/LICENSE;
            4. builds the apk from that tarball, so the SDK checks the hash, and installs it on -Router as a check
               (skipped with -SkipInstallCheck);
            5. commits the Makefile in the packages checkout and pushes it to -Remote;
            6. creates the GitHub release with the apk and its SHA-256 file.
          The Makefile cannot live in this repository: PKG_HASH is the hash of the tag's tarball, which would contain
          the Makefile. If the package push fails, its local branch, index and Makefile are restored to the recorded
          baseline. Published tags are retained, including when a push's outcome is uncertain; remote branches are
          never rolled back. The tag and the packages commit use your git identity (git config, or
          GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL); it must match the Signed-off-by line of the package commit.

The OpenWrt SDK only runs on Linux. On Linux the build runs directly in bash; on Windows it runs inside WSL (-Distro)
and the working tree is reached through /mnt. The SDK must already be set up, with the feed that holds admin/flab-ui
(a src-link to a checkout of openwrt/packages) installed and CONFIG_PACKAGE_flab-ui=m in its .config; see
docs/package.md. The router must run an apk-based OpenWrt (a snapshot or a release built with apk).

A Deploy or Remove replaces the plugins that serve the signed-in pages, so do not run one while a browser test is
running on the same router.

.PARAMETER Action
Build, Deploy, Sync, Check, Remove or Release (see the description).

.PARAMETER Backend
Sync only: also copy rpcd/ and reload rpcd. Never use while a configuration apply awaits confirmation.

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

.PARAMETER NotesFile
Release only, required: UTF-8 file containing the actual changelog for this version. Installation instructions and
asset/source SHA-256 notes are appended automatically. Read and validated before any Git state is changed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Build', 'Deploy', 'Sync', 'Check', 'Remove', 'Release')][string]$Action,
    [string]$Router = $(if ($env:FLAB_ROUTER) { $env:FLAB_ROUTER } else { 'root@192.168.1.1' }),
    [ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Distro = 'Ubuntu-26.04',
    [ValidatePattern('^[A-Za-z0-9._/$*~-]+$')][string]$Sdk = '$HOME/sdk/openwrt-sdk-*',
    [string]$OutDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'artifacts\packages'),
    [switch]$UseFeedSource,
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [string]$PackagesDir = $(if ($env:FLAB_PACKAGES) { $env:FLAB_PACKAGES } else { Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) 'packages' }),
    [string]$Remote = 'fork',
    [switch]$Amend,
    [switch]$Backend,
    [switch]$SkipInstallCheck,
    [switch]$Draft,
    [string]$NotesFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent

#region Helpers
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
        $exclusive = [bool]$entry.PSObject.Properties['exclusive']?.Value
        $source = Join-Path $root ($entry.source -replace '/', '\')
        if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Artifact source directory is missing: $entry.source" }
        $files = @(Get-ChildItem -LiteralPath $source -Recurse -File)
        if ($glob) { $files = @($files | Where-Object { $_.Name -like $glob }) }
        if (-not $files) { throw "Artifact source has no matching files: $entry.source" }
        foreach ($file in $files) {
            $relative = [IO.Path]::GetRelativePath($source, $file.FullName) -replace '\\', '/'
            [pscustomobject]@{
                Source = $file.FullName
                RelativePath = $relative
                Target = ($entry.target.TrimEnd('/') + '/' + $relative)
                Exclusive = $exclusive
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

function Test-InstalledArtifacts {
    <#
    .SYNOPSIS
    Verifies the installed flab-ui file contract on the router.
    .DESCRIPTION
    Checks every manifest target and rejects extra files under the exclusive web installation directory.
    #>
    param([Parameter(Mandatory)]$Entries)

    $checks = @($Entries | ForEach-Object { "$((Get-FileHash -LiteralPath $_.Source -Algorithm SHA256).Hash.ToLower())  $($_.Target)" })
    $local = Join-Path ([IO.Path]::GetTempPath()) ("flab-artifacts-$PID.txt")
    $remote = "/tmp/flab-artifacts-$PID.expected"
    [IO.File]::WriteAllText($local, (($checks -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
    try {
        scp -O -q $local "${Router}:$remote"
        if ($LASTEXITCODE -ne 0) { throw "scp failed with exit code $LASTEXITCODE" }
        Invoke-Remote @"
set -eu
trap 'rm -f $remote /tmp/flab-artifacts.paths /tmp/flab-artifacts.actual /tmp/flab-artifacts.web /tmp/flab-artifacts.group' EXIT
sha256sum -c $remote >/dev/null
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
ORIGINAL="$SDK/.flab-ui-package-original"
[ ! -e "$ORIGINAL" ] && [ ! -L "$ORIGINAL" ] || {
  echo "An interrupted build left $ORIGINAL; restore the SDK package entry before retrying." >&2; exit 1;
}
make package/flab-ui/clean > "$LOG" 2>&1 || { tail -40 "$LOG" >&2; exit 1; }
if [ '@@FEED@@' = 1 ]; then
  make package/flab-ui/compile V=s >> "$LOG" 2>&1 || { tail -40 "$LOG" >&2; exit 1; }
else
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  cp -a "$SRC/www" "$SRC/rpcd" "$SRC/LICENSE" "$STAGE/"
  # Files read from a Windows drive in WSL are rwxrwxrwx; the package must not install them that way.
  find "$STAGE" -type d -exec chmod 0755 {} + -o -type f -exec chmod 0644 {} +
  # Temporarily redirect only the SDK's installed package entry; never edit the feed checkout's Makefile.
  PACKAGE=$(ls -d package/feeds/*/flab-ui | head -n 1)
  OVERRIDE="$SDK/.flab-ui-package"
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

    $null = Test-ArtifactContract
    New-Item -ItemType Directory $OutDir -Force | Out-Null
    Write-Host $(if ($FromFeed) { 'Building the package from the source the feed Makefile names...' } else { 'Building the package from the working tree...' })
    $feed = if ($FromFeed) { '1' } else { '0' }
    # A working-tree build gets a release number made of the UTC time (for example flab-ui-0.1.4-r202611151530),
    # which sorts after the published -r1 of the same version and can never be mistaken for it.
    $devRelease = [DateTime]::UtcNow.ToString('yyyyMMddHHmm')
    $script = $buildScript.Replace('@@SRC@@', (ConvertTo-BuildPath $root)).Replace('@@OUT@@', (ConvertTo-BuildPath (Resolve-Path $OutDir).Path)).Replace('@@SDK@@', $Sdk).Replace('@@FEED@@', $feed).Replace('@@DEVREL@@', $devRelease)
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

    $artifacts = @(Test-ArtifactContract)
    $expected = @(Get-ChildItem (Join-Path (Join-Path $root 'rpcd') 'ucode') -Filter 'flab.*.uc' | ForEach-Object { $_.BaseName })
    if (-not $expected) { throw 'No rpcd plugin found in rpcd/ucode.' }
    $apkName = Split-Path $Apk -Leaf

    Write-Host "Installing $apkName on the router..."
    scp -O -q $Apk "${Router}:/tmp/$apkName"
    if ($LASTEXITCODE -ne 0) { throw "scp failed with exit code $LASTEXITCODE" }
    Invoke-Remote @"
set -e
if apk info -e flab-ui >/dev/null 2>&1; then apk del flab-ui; fi
rm -rf /www/flab
apk add --allow-untrusted /tmp/$apkName
rm -f /tmp/$apkName
"@ | Write-Host

    Wait-Objects -Expected $expected
    Test-InstalledArtifacts -Entries $artifacts
    # The installed version must be the one that was built: the apk file name is name-version-release.apk.
    $installed = (Invoke-Remote 'apk list -I flab-ui 2>/dev/null | head -n 1') -replace '^(\S+).*$', '$1'
    if ($installed -ne [IO.Path]::GetFileNameWithoutExtension($apkName)) { throw "The router reports '$installed', not $apkName." }
    $hostName = $Router.Split('@')[-1]
    $page = Invoke-WebRequest -Uri "https://$hostName/flab/" -SkipCertificateCheck
    if ($page.StatusCode -ne 200) { throw "The page answered HTTP $($page.StatusCode)." }
    Write-Host "Installed: $($expected.Count) rpcd objects. Open https://$hostName/flab/ and sign in as root."
}
#endregion

#region Release
function Restore-PackageCheckout {
    <#
    .SYNOPSIS
    Restores the unpublished package change to its pre-release baseline.
    .DESCRIPTION
    Compare-and-swap updates only this run's branch tip, then restores the flab-ui package files in the index and worktree.
    No remote ref or unrelated path is changed. Refuses to overwrite a branch moved by another process.
    .PARAMETER Baseline
    The package branch's original commit.
    .PARAMETER ExpectedHead
    This run's new commit, or the baseline when no commit was made.
    .PARAMETER Branch
    The package branch recorded before tagging.
    .PARAMETER OriginalBytes
    The original worktree bytes, including its encoding and line endings.
    #>
    param([string]$Baseline, [string]$ExpectedHead, [string]$Branch, [byte[]]$OriginalBytes)

    if ((Invoke-Native git @('-C', $PackagesDir, 'branch', '--show-current')) -ne $Branch) {
        throw 'Package branch changed during release; refusing automatic recovery.'
    }
    $null = Invoke-Native git @('-C', $PackagesDir, 'update-ref', "refs/heads/$Branch", $Baseline, $ExpectedHead)
    $null = Invoke-Native git @('-C', $PackagesDir, 'restore', "--source=$Baseline", '--staged', '--worktree', '--', 'admin/flab-ui')
    $null = Invoke-Native git @('-C', $PackagesDir, 'clean', '-fd', '--', 'admin/flab-ui/files/usr/share/rpcd/acl.d')
    [IO.File]::WriteAllBytes((Join-Path $PackagesDir 'admin\flab-ui\Makefile'), $OriginalBytes)
}

function Sync-PackageFiles {
    <#
    .SYNOPSIS
    Copies OpenWrt-owned integration files into the packages checkout.
    .DESCRIPTION
    Keeps the rpcd ACL fragments identical in the source repository and the package feed's files/ tree, deleting
    stale copies first. Other application files continue to come from the immutable source archive.
    #>
    $source = Join-Path $root 'rpcd\acl.d'
    $target = Join-Path $PackagesDir 'admin\flab-ui\files\usr\share\rpcd\acl.d'
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "ACL source directory is missing: $source" }
    New-Item -ItemType Directory $target -Force | Out-Null
    Get-ChildItem -LiteralPath $target -Filter 'flab-*.json' -File | Remove-Item -Force
    Copy-Item (Join-Path $source 'flab-*.json') $target
    $sourceFiles = @(Get-ChildItem -LiteralPath $source -Filter 'flab-*.json' -File)
    $targetFiles = @(Get-ChildItem -LiteralPath $target -Filter 'flab-*.json' -File)
    if ($sourceFiles.Count -ne $targetFiles.Count) { throw 'The package ACL file count does not match the source repository.' }
    foreach ($file in $sourceFiles) {
        $copy = Join-Path $target $file.Name
        if ((Get-FileHash $file.FullName -Algorithm SHA256).Hash -ne (Get-FileHash $copy -Algorithm SHA256).Hash) {
            throw "The package ACL copy differs: $($file.Name)"
        }
    }
}

function Publish-Release {
    <#
    .SYNOPSIS
    Tags the source, aligns the package Makefile, builds the apk from the tag and creates the GitHub release.
    .DESCRIPTION
    Records source/package heads and the remote package tip before publishing. Failed unpublished package changes
    are restored locally; published or possibly published tags and all remote branch work are retained.
    Updates the web license file metadata together with the version and hash, only when this source contains it.
    #>
    if (-not $Version) { throw '-Version is required for Release.' }
    if (-not $NotesFile) { throw '-NotesFile containing the release changelog is required for Release.' }
    $changelog = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $NotesFile).Path).Trim()
    if (-not $changelog) { throw '-NotesFile must contain a nonempty release changelog.' }
    $tag = "v$Version"
    $makefile = Join-Path (Join-Path (Join-Path $PackagesDir 'admin') 'flab-ui') 'Makefile'

    # Checks: nothing is changed until they all pass.
    $slug = ((Invoke-Native git @('-C', $root, 'remote', 'get-url', 'origin')) -replace '^.*github\.com[:/]', '' -replace '\.git$', '')
    if ($slug -notmatch '^[\w.-]+/[\w.-]+$') { throw "Cannot find the GitHub repository in the origin URL: $slug" }
    if (-not (Test-Path $makefile)) { throw "No Makefile at $makefile; set -PackagesDir." }
    if ((Invoke-Native git @('-C', $root, 'branch', '--show-current')) -ne 'main') { throw 'Release from the main branch.' }
    if (Invoke-Native git @('-C', $root, 'status', '--porcelain')) { throw 'The working tree is not clean.' }
    $sourceHead = Invoke-Native git @('-C', $root, 'rev-parse', 'HEAD')
    if (Invoke-Native git @('-C', $PackagesDir, 'status', '--porcelain')) { throw "The packages checkout $PackagesDir is not clean." }
    $packagesHead = Invoke-Native git @('-C', $PackagesDir, 'rev-parse', 'HEAD')
    $packagesBranch = Invoke-Native git @('-C', $PackagesDir, 'branch', '--show-current')
    if (-not $packagesBranch -or $packagesBranch -in 'master', 'main') { throw "Check out a feature branch in $PackagesDir first (now: '$packagesBranch')." }
    if ((Invoke-Native git @('-C', $PackagesDir, 'remote', 'get-url', $Remote)) -match 'github\.com[:/]openwrt/') { throw "Remote $Remote is openwrt/packages itself; use a fork." }
    $remoteTip = @(Invoke-Native git @('-C', $PackagesDir, 'ls-remote', '--heads', $Remote, "refs/heads/$packagesBranch"))
    $remoteHead = if ($remoteTip.Count) { ($remoteTip[0] -split '\s+')[0] } else { '' }
    if ($Amend -and $remoteHead -and $remoteHead -ne $packagesHead) { throw 'The package branch must match its remote before -Amend; synchronize it first.' }
    $null = Invoke-Native git @('-C', $root, 'fetch', '--quiet', 'origin', 'main')
    if ($sourceHead -ne (Invoke-Native git @('-C', $root, 'rev-parse', 'origin/main'))) { throw 'main is not the same as origin/main: push or pull first.' }
    if (Invoke-Native git @('-C', $root, 'tag', '--list', $tag)) { throw "The tag $tag already exists." }
    if (Invoke-Native git @('-C', $root, 'ls-remote', '--tags', 'origin', "refs/tags/$tag")) { throw "The tag $tag already exists on origin." }
    $null = Invoke-Native gh @('auth', 'status')

    $originalMakefile = [IO.File]::ReadAllText($makefile)
    $originalBytes = [IO.File]::ReadAllBytes($makefile)
    $tagCreated = $false
    $tagPushAttempted = $false
    $packagesCommit = $packagesHead
    $packagesPushed = $false
    $released = $false
    try {
        Write-Host "Tagging $tag..."
        $null = Invoke-Native git @('-C', $root, 'tag', '-a', $tag, '-m', "flab-ui $Version")
        $tagCreated = $true
        $tagPushAttempted = $true
        $null = Invoke-Native git @('-C', $root, 'push', '--quiet', 'origin', $tag)

        # The hash is taken from the tarball GitHub serves for the tag, the same file the SDK downloads.
        New-Item -ItemType Directory $OutDir -Force | Out-Null
        $tarball = Join-Path $OutDir "flab-ui-$Version.tar.gz"
        Invoke-WebRequest -Uri "https://codeload.github.com/$slug/tar.gz/$tag" -OutFile $tarball
        $sourceHash = (Get-FileHash $tarball -Algorithm SHA256).Hash.ToLower()
        Write-Host "Source tarball SHA-256: $sourceHash"

        $text = $originalMakefile
        $text = Set-MakeVariable $text 'PKG_VERSION' $Version
        $text = Set-MakeVariable $text 'PKG_RELEASE' '1'
        $text = Set-MakeVariable $text 'PKG_HASH' $sourceHash
        if (Test-Path -LiteralPath (Join-Path $root 'www\LICENSE') -PathType Leaf) {
            $text = Set-MakeVariable $text 'PKG_LICENSE_FILES' 'LICENSE www/LICENSE'
        }
        [IO.File]::WriteAllText($makefile, $text, [Text.UTF8Encoding]::new($false))
        Sync-PackageFiles

        # Build from the tarball the Makefile now names, so the SDK checks PKG_HASH; install it when asked to.
        $builtApk = Build-Package -FromFeed
        $apkName = Split-Path $builtApk -Leaf
        if ($apkName -ne "flab-ui-$Version-r1.apk") { throw "Expected flab-ui-$Version-r1.apk, built $apkName" }
        if (-not $SkipInstallCheck) { Install-Package $builtApk }
        $apkHash = (Get-FileHash $builtApk -Algorithm SHA256).Hash.ToLower()
        $sumFile = "$builtApk.sha256"
        [IO.File]::WriteAllText($sumFile, "$apkHash  $apkName`n", [Text.UTF8Encoding]::new($false))

        Write-Host 'Committing the Makefile and integration files in the packages checkout...'
        if ((Invoke-Native git @('-C', $PackagesDir, 'rev-parse', 'HEAD')) -ne $packagesHead) { throw 'Package HEAD changed during release.' }
        $otherChanges = @(Invoke-Native git @('-C', $PackagesDir, 'status', '--porcelain') | Where-Object {
            $_ -notmatch 'admin/flab-ui/(Makefile|files/usr/share/rpcd/acl\.d/flab-.*\.json)$'
        })
        if ($otherChanges.Count) { throw "Other package changes appeared during release; refusing to commit them: $($otherChanges -join ', ')" }
        $null = Invoke-Native git @('-C', $PackagesDir, 'add', 'admin/flab-ui/Makefile', 'admin/flab-ui/files/usr/share/rpcd/acl.d')
        if ($Amend) {
            $null = Invoke-Native git @('-C', $PackagesDir, 'commit', '--quiet', '--amend', '--no-edit')
        }
        else {
            $null = Invoke-Native git @('-C', $PackagesDir, 'commit', '--quiet', '--signoff', '-m', "flab-ui: update to $Version")
        }
        $packagesCommit = Invoke-Native git @('-C', $PackagesDir, 'rev-parse', 'HEAD')
        # Pin the lease to the pre-release remote tip, not a tracking ref a background fetch can advance.
        $pushArgs = @('-C', $PackagesDir, 'push', '--quiet')
        if ($Amend) { $pushArgs += "--force-with-lease=refs/heads/${packagesBranch}:$remoteHead" }
        $null = Invoke-Native git ($pushArgs + @($Remote, "HEAD:refs/heads/$packagesBranch"))
        $packagesPushed = $true

        $notes = @"
flab-ui $Version

$changelog

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
            try {
                Restore-PackageCheckout -Baseline $packagesHead -ExpectedHead $packagesCommit -Branch $packagesBranch -OriginalBytes $originalBytes
            }
            catch { Write-Warning "Automatic local package recovery failed: $($_.Exception.Message). Baseline: $packagesHead; release commit: $packagesCommit." }
            if ($tagPushAttempted) {
                Write-Warning "Retaining ${tag}: a published feed may reference it even if push reported failure. Remote package work was not modified by recovery. Inspect both remotes before retrying."
            }
            elseif ($tagCreated) { $null = Invoke-Native git @('-C', $root, 'tag', '-d', $tag) }
        }
        throw
    }
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
    configuration apply is waiting for confirmation, because the rollback timer lives in rpcd's memory. Files removed
    from rpcd/ are not removed on the router. The result is not an installed package version: use Deploy for that.
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
            $stage = Join-Path $work 'stage'
            foreach ($pair in @(@('acl.d', 'usr/share/rpcd/acl.d'), @('ucode', 'usr/share/rpcd/ucode'), @('lib/flab', 'usr/share/ucode/flab'))) {
                $target = Join-Path $stage $pair[1]
                New-Item -ItemType Directory $target -Force | Out-Null
                Copy-Item (Join-Path (Join-Path $root 'rpcd') $pair[0] | Join-Path -ChildPath '*') $target
            }
            $backendTar = Join-Path $work 'backend.tar'
            $null = Invoke-Native tar @('--format', 'ustar', '-cf', $backendTar, '-C', $stage, '.')
            scp -O -q $backendTar "${Router}:/tmp/flab-backend.tar"
            if ($LASTEXITCODE -ne 0) { throw "scp failed with exit code $LASTEXITCODE" }
            $backendScript = @'
find /usr/share/rpcd/ucode -maxdepth 1 -type f -name 'flab.*.uc' -exec rm -f {} +
find /usr/share/ucode/flab -maxdepth 1 -type f -name '*.uc' -exec rm -f {} +
find /usr/share/rpcd/acl.d -maxdepth 1 -type f -name 'flab-*.json' -exec rm -f {} +
tar -xof /tmp/flab-backend.tar -C /
chmod 0644 /usr/share/rpcd/acl.d/flab-*.json /usr/share/rpcd/ucode/flab.*.uc /usr/share/ucode/flab/*.uc
rm -f /tmp/flab-backend.tar
/etc/init.d/rpcd reload
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
    $hostName = $Router.Split('@')[-1]
    $page = Invoke-WebRequest -Uri "https://$hostName/flab/" -SkipCertificateCheck
    if ($page.StatusCode -ne 200) { throw "The page answered HTTP $($page.StatusCode)." }
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
switch ($Action) {
    'Build' { $null = Build-Package -FromFeed:$UseFeedSource }
    'Deploy' { Install-Package (Build-Package -FromFeed:$UseFeedSource) }
    'Sync' { Sync-Router }
    'Check' { Test-Consistency }
    'Remove' {
        Invoke-Remote 'if apk info -e flab-ui >/dev/null 2>&1; then apk del flab-ui; else echo "flab-ui is not installed."; fi' | Write-Host
        Wait-Objects
        Write-Host 'Removed; no flab.* ubus object is left.'
    }
    'Release' { Publish-Release }
}
#endregion
