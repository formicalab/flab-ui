#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '..\..\tools\package.ps1') -Action Release

function Assert-HostedRelease {
    <#
    .SYNOPSIS
    Asserts a hosted-release dispatch invariant.
    .DESCRIPTION
    Throws immediately when the local dispatcher produces an unexpected Git or gh operation.
    .PARAMETER Condition
    Whether the invariant holds.
    .PARAMETER Message
    Failure explanation.
    #>
    param([bool]$Condition, [string]$Message)

    if (-not $Condition) { throw $Message }
}

$calls = [Collections.Generic.List[string]]::new()
$runId = 123456789

function Invoke-Native {
    <#
    .SYNOPSIS
    Simulates Git and GitHub CLI release operations.
    .DESCRIPTION
    Models a clean, pushed main branch and a newly created hosted workflow run without touching GitHub.
    .PARAMETER File
    Program name.
    .PARAMETER Arguments
    Program arguments.
    .OUTPUTS
    Deterministic Git and workflow-run fixture output.
    #>
    param([string]$File, [string[]]$Arguments)

    $command = "$File $($Arguments -join ' ')"
    $calls.Add($command)
    if ($File -eq 'git') {
        if ($Arguments -contains 'branch') { return 'main' }
        if ($Arguments -contains 'rev-parse') { return '0123456789abcdef' }
        if ($Arguments -contains 'status' -or $Arguments -contains 'tag' -or $Arguments -contains 'ls-remote') {
            return @()
        }
        return @()
    }
    if ($Arguments.Count -ge 2 -and $Arguments[0] -eq 'run' -and $Arguments[1] -eq 'list') {
        $createdAt = [DateTime]::UtcNow.AddMinutes(1).ToString('o')
        return '[{"databaseId":' + $runId + ',"createdAt":"' + $createdAt + '"}]'
    }
    if ($Arguments.Count -ge 2 -and $Arguments[0] -eq 'run' -and $Arguments[1] -eq 'view') {
        return 'https://github.com/example/flab-ui/actions/runs/' + $runId
    }
    return @()
}

$Version = '99.0.0'
$NotesFile = Join-Path $root 'CHANGELOG.md'
$Amend = [switch]$true
$Draft = [switch]$true
$DryRun = [switch]$true

try { Start-HostedRelease }
catch {
    Write-Host ($calls -join "`n")
    throw
}

$dispatch = @($calls | Where-Object { $_ -like 'gh workflow run *' })
Assert-HostedRelease ($dispatch.Count -eq 1) 'The release workflow was not dispatched exactly once.'
Assert-HostedRelease ($dispatch[0] -like '*release.yml*') 'The wrong workflow was dispatched.'
Assert-HostedRelease ($dispatch[0] -like '*version=99.0.0*') 'The release version was not dispatched.'
Assert-HostedRelease ($dispatch[0] -like '*notes_file=CHANGELOG.md*') 'The release notes path was not dispatched.'
Assert-HostedRelease ($dispatch[0] -like '*amend=true*') 'The amend option was not dispatched.'
Assert-HostedRelease ($dispatch[0] -like '*draft=true*') 'The draft option was not dispatched.'
Assert-HostedRelease ($dispatch[0] -like '*dry_run=true*') 'The dry-run option was not dispatched.'
Assert-HostedRelease ([bool]($calls | Where-Object { $_ -like "gh run watch $runId *" })) 'The dispatcher did not wait for the workflow.'
Assert-HostedRelease (-not [bool]($calls | Where-Object { $_ -like 'git *tag *' -or $_ -like 'git *push *' })) 'The local release dispatcher created or pushed Git state.'
Write-Host 'PASS hosted release: dispatch and wait'

$NotesFile = $null
$caught = $false
try { Start-HostedRelease }
catch { $caught = $true }
Assert-HostedRelease $caught 'A release without a notes file was accepted.'
Write-Host 'PASS hosted release: notes required'
