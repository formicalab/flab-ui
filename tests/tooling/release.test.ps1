#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region Harness
. (Join-Path $PSScriptRoot '..\..\tools\package.ps1') -Action Release
$realNative = ${function:Invoke-Native}
$workspace = Join-Path $PSScriptRoot ('.work-' + [guid]::NewGuid().ToString('N'))

function Test-Git {
    <#
    .SYNOPSIS
    Runs Git against disposable test repositories.
    .DESCRIPTION
    Uses only local remotes and checks every native exit code.
    .PARAMETER Arguments
    Git arguments.
    .OUTPUTS
    Git output lines.
    #>
    param([Parameter(ValueFromRemainingArguments)][string[]]$Arguments)
    & $realNative git $Arguments
}

function Assert-Release {
    <#
    .SYNOPSIS
    Asserts a release recovery invariant.
    .DESCRIPTION
    Throws immediately when the observed state differs from the expected state.
    .PARAMETER Condition
    Whether the invariant holds.
    .PARAMETER Message
    Failure explanation.
    #>
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Invoke-WebRequest {
    <#
    .SYNOPSIS
    Supplies a deterministic source archive without network access.
    .DESCRIPTION
    Replaces only the release download for this isolated test script.
    .PARAMETER Uri
    Unused release URL.
    .PARAMETER OutFile
    Fixture output path.
    #>
    param([string]$Uri, [string]$OutFile)
    [IO.File]::WriteAllText($OutFile, 'source archive fixture')
}

function Build-Package {
    <#
    .SYNOPSIS
    Supplies a package fixture or injects a build failure.
    .DESCRIPTION
    Checks license metadata before building. No SDK, router, installation or public release is touched.
    .PARAMETER FromFeed
    Expected release build mode.
    .OUTPUTS
    Fixture package path.
    #>
    param([switch]$FromFeed)
    Assert-Release $FromFeed.IsPresent 'Release must build from the feed source.'
    $metadata = [IO.File]::ReadAllText((Join-Path $PackagesDir 'admin\flab-ui\Makefile'))
    $expectedLicense = if ($hasWebLicense) { 'LICENSE www/LICENSE' } else { 'LICENSE' }
    Assert-Release ($metadata -match "(?m)^PKG_LICENSE_FILES:=$([regex]::Escape($expectedLicense))`r?$") 'License metadata does not match the tagged source.'
    if ($failure -eq 'build') { throw 'injected build failure' }
    $apk = Join-Path $OutDir "flab-ui-$Version-r1.apk"
    [IO.File]::WriteAllText($apk, 'apk fixture')
    return $apk
}

function Invoke-Native {
    <#
    .SYNOPSIS
    Injects release failures around real local Git operations.
    .DESCRIPTION
    GitHub calls are recorded, not executed. Git pushes use only disposable bare repositories.
    .PARAMETER File
    Program name.
    .PARAMETER Arguments
    Program arguments.
    .OUTPUTS
    Command output or deterministic GitHub fixture output.
    #>
    param([string]$File, [string[]]$Arguments)
    if ($File -eq 'gh') {
        if ($Arguments[0] -eq 'release') {
            $script:capturedNotes = $Arguments[[Array]::IndexOf($Arguments, '--notes') + 1]
            if ($failure -eq 'release') { throw 'injected release failure' }
        }
        return
    }
    $isPackage = $Arguments.Count -gt 2 -and $Arguments[1] -eq $PackagesDir
    if ($Arguments -join ' ' -eq "-C $root remote get-url origin") { return 'https://github.com/example/flab-ui.git' }
    if ($isPackage -and $Arguments[2] -eq 'commit' -and $failure -eq 'commit') { throw 'injected commit failure' }
    if ($isPackage -and $Arguments[2] -eq 'push') {
        if ($failure -eq 'push') { throw 'injected push failure after commit' }
        if ($failure -eq 'ambiguous-push') {
            $null = & $realNative $File $Arguments
            throw 'injected lost push acknowledgement'
        }
        if ($failure -eq 'concurrent-push') {
            [IO.File]::WriteAllText((Join-Path $writer 'unrelated.txt'), 'remote work')
            $null = Test-Git -C $writer add unrelated.txt
            $null = Test-Git -C $writer commit --quiet -m 'unrelated remote work'
            $null = Test-Git -C $writer push --quiet origin feed
            $script:concurrentHead = Test-Git -C $writer rev-parse HEAD
        }
    }
    & $realNative $File $Arguments
}
#endregion

#region Cases
New-Item -ItemType Directory $workspace | Out-Null
try {
    foreach ($amendCase in @($false, $true)) {
        foreach ($failureCase in @('build', 'commit', 'push', 'concurrent-push', 'ambiguous-push', 'release', 'none')) {
            $failure = $failureCase
            $Amend = $amendCase
            $hasWebLicense = $amendCase -or $failureCase -eq 'none'
            $case = Join-Path $workspace "$failure-$Amend"
            $root = Join-Path $case 'source'
            $PackagesDir = Join-Path $case 'packages'
            $sourceRemote = Join-Path $case 'source.git'
            $packageRemote = Join-Path $case 'packages.git'
            $writer = Join-Path $case 'writer'
            $OutDir = Join-Path $case 'out'
            $NotesFile = Join-Path $case 'notes.txt'
            $Version = '0.1.4'
            $Remote = 'fork'
            $SkipInstallCheck = $true
            $Draft = $false
            $script:capturedNotes = ''
            $script:concurrentHead = ''
            New-Item -ItemType Directory $case | Out-Null
            [IO.File]::WriteAllText($NotesFile, "Fix bounded RPC execution and lazy navigation.`n")

            foreach ($repo in @($root, $PackagesDir)) {
                $null = Test-Git init --quiet --initial-branch=main $repo
                $null = Test-Git -C $repo config user.name 'Release Test'
                $null = Test-Git -C $repo config user.email 'release-test@example.invalid'
                $null = Test-Git -C $repo config core.autocrlf false
                if ($repo -eq $PackagesDir) {
                    $directory = Join-Path $repo 'admin\flab-ui'
                    New-Item -ItemType Directory $directory | Out-Null
                    [IO.File]::WriteAllText((Join-Path $directory 'Makefile'), "PKG_VERSION:=0.1.3`nPKG_RELEASE:=2`nPKG_HASH:=old`nPKG_LICENSE_FILES:=LICENSE`n")
                }
                else {
                    [IO.File]::WriteAllText((Join-Path $repo 'source.txt'), 'source')
                    if ($hasWebLicense) {
                        $web = Join-Path $repo 'www'
                        New-Item -ItemType Directory $web | Out-Null
                        [IO.File]::WriteAllText((Join-Path $web 'LICENSE'), 'Web license fixture')
                    }
                }
                $null = Test-Git -C $repo add .
                $null = Test-Git -C $repo commit --quiet -m initial
            }
            $null = Test-Git init --bare --quiet $sourceRemote
            $null = Test-Git -C $root remote add origin $sourceRemote
            $null = Test-Git -C $root push --quiet -u origin main
            $null = Test-Git -C $PackagesDir switch --quiet -c feed
            $null = Test-Git init --bare --quiet $packageRemote
            $null = Test-Git -C $PackagesDir remote add fork $packageRemote
            $null = Test-Git -C $PackagesDir push --quiet -u fork feed
            $null = Test-Git clone --quiet --branch feed $packageRemote $writer
            $null = Test-Git -C $writer config user.name 'Remote Writer'
            $null = Test-Git -C $writer config user.email 'writer@example.invalid'
            $baseline = Test-Git -C $PackagesDir rev-parse HEAD
            $baselineIndex = Test-Git -C $PackagesDir write-tree
            $makefilePath = Join-Path $PackagesDir 'admin\flab-ui\Makefile'
            $baselineBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($makefilePath))
            $caught = $false
            try { Publish-Release }
            catch { $caught = $true }
            Assert-Release ($caught -eq ($failure -ne 'none')) "Unexpected result: $failure amend=$Amend"
            $remoteNow = (Test-Git --git-dir $packageRemote rev-parse refs/heads/feed)
            if ($failure -in @('build', 'commit', 'push', 'concurrent-push', 'ambiguous-push')) {
                Assert-Release ((Test-Git -C $PackagesDir rev-parse HEAD) -eq $baseline) 'HEAD was not restored.'
                Assert-Release ((Test-Git -C $PackagesDir write-tree) -eq $baselineIndex) 'Index was not restored.'
                Assert-Release ([Convert]::ToBase64String([IO.File]::ReadAllBytes($makefilePath)) -eq $baselineBytes) 'Worktree was not restored.'
                $dirty = Test-Git -C $PackagesDir status --porcelain
                Assert-Release (-not $dirty) "Recovery left a dirty package checkout: $dirty"
            }
            if ($failure -eq 'concurrent-push') {
                Assert-Release ($remoteNow -eq $concurrentHead) 'Recovery overwrote concurrent remote work.'
            }
            elseif ($failure -in @('build', 'commit', 'push')) {
                Assert-Release ($remoteNow -eq $baseline) 'Recovery changed the remote branch.'
            }
            Assert-Release ([bool](Test-Git --git-dir $sourceRemote tag --list v0.1.4)) 'A published source tag was deleted.'
            if ($failure -in @('release', 'none')) {
                Assert-Release ((Test-Git -C $PackagesDir rev-parse HEAD) -eq $remoteNow) 'Published package tip was not retained.'
                Assert-Release ($capturedNotes -match 'Fix bounded RPC execution and lazy navigation') 'Actual changelog missing.'
                Assert-Release ($capturedNotes -match 'apk add --allow-untrusted' -and $capturedNotes -match 'SHA-256') 'Standard asset/install notes missing.'
                $publishedMetadata = (Test-Git --git-dir $packageRemote show "${remoteNow}:admin/flab-ui/Makefile") -join "`n"
                $expectedLicense = if ($hasWebLicense) { 'LICENSE www/LICENSE' } else { 'LICENSE' }
                Assert-Release ($publishedMetadata -match "(?m)^PKG_LICENSE_FILES:=$([regex]::Escape($expectedLicense))$") 'Published license metadata does not match the source.'
                Assert-Release ($publishedMetadata -match '(?m)^PKG_VERSION:=0\.1\.4$' -and $publishedMetadata -match '(?m)^PKG_RELEASE:=1$') 'Version and license metadata were not published together.'
            }
            Write-Host "PASS $failure amend=$Amend"
        }
    }
}
finally {
    Remove-Item -LiteralPath $workspace -Recurse -Force
}
#endregion
