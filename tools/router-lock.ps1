#Requires -Version 7.0
<#
.SYNOPSIS
Runs a command while holding a lock on the shared test router, so several people or agents can work against one router.

.DESCRIPTION
A full deploy (tools/package.ps1 -Action Deploy) replaces the UI and reloads rpcd, so it must not run while a
browser test is running. This is a reader-writer lock kept in a folder under the temp directory:
  -Mode Read   for anything that uses the router and the installed UI without replacing them (run.ps1, run.ps1 -Browser).
               Any number of readers run at the same time.
  -Mode Write  for package.ps1 (Deploy or Remove). It waits for the readers to finish, and while it waits or runs no new reader starts.
A holder that died without releasing the lock (its process id is gone) is ignored. The command runs in a child pwsh and its exit
code becomes this script's exit code.

.PARAMETER Mode
Read or Write (see the description).

.PARAMETER Command
The command line to run, for example: pwsh -NoProfile -File tests\ddns\run.ps1 -Browser

.PARAMETER Suite
The name of the test suite (its folder under tests/) when the command runs one. Two runs of the same suite use the same folders on the router and in the temp directory, so they must not overlap: the runs of one suite queue on a named mutex.

.PARAMETER TimeoutMinutes
How long to wait for the lock before giving up.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Read', 'Write')][string]$Mode,
    [Parameter(Mandatory)][string]$Command,
    [ValidatePattern('^[A-Za-z0-9_-]*$')][string]$Suite = '',
    [int]$TimeoutMinutes = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$lockRoot = Join-Path ([IO.Path]::GetTempPath()) 'flab-router-lock'
$writerDir = Join-Path $lockRoot 'writer'
$readerDir = Join-Path $lockRoot 'readers'
$token = "$PID-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
New-Item -ItemType Directory $readerDir -Force | Out-Null

#region Helpers
function Test-Alive {
    <#
    .SYNOPSIS
    Whether the process that holds a lock entry still exists.
    .DESCRIPTION
    A lock entry is named or labelled with the process id of its holder; an entry whose process is gone is stale and is ignored.
    .PARAMETER ProcessId
    The process id of the holder.
    .OUTPUTS
    Boolean.
    #>
    param([int]$ProcessId)

    return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Get-LiveReaders {
    <#
    .SYNOPSIS
    The reader entries whose process is alive (stale entries are removed).
    .OUTPUTS
    The file objects of the live readers.
    #>
    $live = @()
    foreach ($f in Get-ChildItem $readerDir -File -ErrorAction SilentlyContinue) {
        if (Test-Alive ([int]($f.Name -split '-')[0])) { $live += $f } else { Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue }
    }
    return $live
}

function Get-WriterHeld {
    <#
    .SYNOPSIS
    Whether a writer currently holds or is waiting for the lock (a stale writer is cleared).
    .OUTPUTS
    Boolean.
    #>
    if (-not (Test-Path $writerDir)) { return $false }
    $pidFile = Join-Path $writerDir 'pid'
    $holder = if (Test-Path $pidFile) { [int](Get-Content $pidFile -Raw) } else { 0 }
    if ($holder -and (Test-Alive $holder)) { return $true }
    # A writer folder without a live owner is left over from a crash, or its owner is still writing the pid file.
    if ((Get-Item $writerDir).CreationTime -gt (Get-Date).AddSeconds(-5)) { return $true }
    Remove-Item $writerDir -Recurse -Force -ErrorAction SilentlyContinue
    return $false
}
#endregion

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$entry = Join-Path $readerDir $token
try {
    #region Acquire
    if ($Mode -eq 'Write') {
        # Taking the writer folder is atomic: only one writer gets it; the others wait. New readers stop as soon as it exists.
        while ($true) {
            if (-not (Get-WriterHeld)) {
                try {
                    New-Item -ItemType Directory $writerDir -ErrorAction Stop | Out-Null
                    Set-Content (Join-Path $writerDir 'pid') $PID
                    break
                }
                catch [System.IO.IOException] { }
            }
            if ((Get-Date) -gt $deadline) { throw 'Timed out waiting for another writer of the router lock.' }
            Start-Sleep -Seconds 2
        }
        # Wait for the readers that were already running.
        while (@(Get-LiveReaders).Count -gt 0) {
            if ((Get-Date) -gt $deadline) { throw 'Timed out waiting for the readers of the router lock.' }
            Start-Sleep -Seconds 2
        }
    }
    else {
        # A reader registers itself, then checks again that no writer arrived in between; if one did it steps back and waits.
        while ($true) {
            if (-not (Get-WriterHeld)) {
                Set-Content $entry $PID
                if (-not (Get-WriterHeld)) { break }
                Remove-Item $entry -Force
            }
            if ((Get-Date) -gt $deadline) { throw 'Timed out waiting for a writer of the router lock.' }
            Start-Sleep -Seconds 2
        }
    }
    #endregion

    #region Run
    # Runs of the same suite queue on a named mutex (an owner that died leaves it abandoned, which still means it is free).
    if ($Suite) {
        $suiteMutex = [Threading.Mutex]::new($false, "Global\flab-suite-$Suite")
        try { [void]$suiteMutex.WaitOne($TimeoutMinutes * 60000) } catch [Threading.AbandonedMutexException] { }
    }
    Write-Host "[router-lock] $Mode lock acquired: $Command"
    & pwsh -NoProfile -Command $Command
    $code = $LASTEXITCODE
    #endregion
}
finally {
    # Always release, even after a failure or Ctrl+C.
    if ($Suite -and (Test-Path variable:suiteMutex)) { try { $suiteMutex.ReleaseMutex() } catch { } }
    if (Test-Path $entry) { Remove-Item $entry -Force -ErrorAction SilentlyContinue }
    if ($Mode -eq 'Write' -and (Test-Path $writerDir)) {
        $owner = if (Test-Path (Join-Path $writerDir 'pid')) { [int](Get-Content (Join-Path $writerDir 'pid') -Raw) } else { 0 }
        if ($owner -eq $PID) { Remove-Item $writerDir -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
exit $code
