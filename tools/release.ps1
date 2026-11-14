#Requires -Version 7.0
<#
.SYNOPSIS
Releases flab-ui: tags the source, updates the package Makefile to match, builds the apk from the tag and publishes it.

.DESCRIPTION
The version of a release is chosen once, here. The script
  1. checks that this repository is on main, clean, and pushed, that the tag does not exist, and that the packages
     checkout (-PackagesDir, a checkout of the openwrt/packages feed branch that holds admin/flab-ui) is clean;
  2. creates and pushes the tag v<Version>;
  3. downloads the tag's source tarball and writes PKG_VERSION, PKG_HASH (its SHA-256) and PKG_RELEASE:=1 into the Makefile;
  4. builds the apk from that tarball with tools/apk-deploy.ps1 -UseFeedSource, which makes the SDK check the hash, and
     installs it on -Router as a check (skipped with -SkipInstallCheck);
  5. commits the Makefile in the packages checkout and pushes it to -Remote;
  6. creates the GitHub release with the apk and its SHA-256 file.
The Makefile cannot live in this repository: PKG_HASH is the hash of the tag's tarball, which would contain the Makefile.
If a step before the release fails, the tag created by this run is deleted again and the Makefile is restored.

The commit in the packages checkout and the tag use your git identity (git config, or GIT_COMMITTER_NAME and
GIT_COMMITTER_EMAIL); it must match the Signed-off-by line of the package commit.

.PARAMETER Version
The version without the leading v, for example 0.1.1.

.PARAMETER PackagesDir
Checkout of the openwrt/packages feed branch that holds admin/flab-ui. Defaults to the FLAB_PACKAGES environment
variable, else a folder named packages next to this repository.

.PARAMETER Remote
Remote of the packages checkout that receives the branch (a fork, never openwrt/packages itself).

.PARAMETER Amend
Fold the Makefile change into the package commit at the tip of the branch (force-pushing with lease) instead of adding
a commit "flab-ui: update to <Version>". Use it while the package is not merged yet and is one commit.

.PARAMETER Router
SSH destination of the router for the install check. Defaults as in apk-deploy.ps1.

.PARAMETER SkipInstallCheck
Build only; do not install the apk on a router.

.PARAMETER Draft
Create the GitHub release as a draft.

.PARAMETER Distro
WSL distribution that holds the SDK (Windows only); passed to apk-deploy.ps1.

.PARAMETER Sdk
SDK directory; passed to apk-deploy.ps1.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [string]$PackagesDir = $(if ($env:FLAB_PACKAGES) { $env:FLAB_PACKAGES } else { Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) 'packages' }),
    [string]$Remote = 'fork',
    [switch]$Amend,
    [string]$Router,
    [switch]$SkipInstallCheck,
    [switch]$Draft,
    [string]$Distro,
    [string]$Sdk
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$tag = "v$Version"
$makefile = Join-Path (Join-Path (Join-Path $PackagesDir 'admin') 'flab-ui') 'Makefile'

#region Helpers
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

#region Checks
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
#endregion

#region Release
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

    # Build from the tarball the Makefile now names, so the SDK checks PKG_HASH; install it when a router is given.
    $outDir = Join-Path ([IO.Path]::GetTempPath()) 'flab-release'
    Remove-Item $outDir -Recurse -Force -ErrorAction SilentlyContinue
    $deploy = @{ Action = if ($SkipInstallCheck) { 'Build' } else { 'Deploy' }; UseFeedSource = $true; OutDir = $outDir }
    if ($Router -and -not $SkipInstallCheck) { $deploy.Router = $Router }
    if ($Distro) { $deploy.Distro = $Distro }
    if ($Sdk) { $deploy.Sdk = $Sdk }
    & (Join-Path $PSScriptRoot 'apk-deploy.ps1') @deploy

    $apk = Get-ChildItem $outDir -Filter 'flab-ui-*.apk' | Select-Object -First 1
    if (-not $apk -or $apk.Name -ne "flab-ui-$Version-r1.apk") { throw "Expected flab-ui-$Version-r1.apk in $outDir, found: $($apk.Name)" }
    $apkHash = (Get-FileHash $apk.FullName -Algorithm SHA256).Hash.ToLower()
    $sumFile = Join-Path $outDir "$($apk.Name).sha256"
    [IO.File]::WriteAllText($sumFile, "$apkHash  $($apk.Name)`n", [Text.UTF8Encoding]::new($false))

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
scp -O $($apk.Name) root@<router>:/tmp/
ssh root@<router> 'apk add --allow-untrusted /tmp/$($apk.Name)'
``````

Then open ``https://<router>/flab/`` and sign in as root. The package is unsigned, so apk needs ``--allow-untrusted``.

SHA-256 of ``$($apk.Name)``: ``$apkHash``
It was built by the OpenWrt SDK from the source tarball of this tag (SHA-256 ``$sourceHash``).
"@
    $releaseArgs = @('release', 'create', $tag, $apk.FullName, $sumFile, '--repo', $slug, '--verify-tag', '--title', "flab-ui $Version", '--notes', $notes)
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
#endregion
