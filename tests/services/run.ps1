#Requires -Version 7.0
<#
.SYNOPSIS
Tests the Services page and the flab.services plugin without ever starting, stopping or restarting a service.

.DESCRIPTION
1. Unit tests of the page model (merging the init scripts with procd's list, actions, confirmations, outcomes).
2. Backend: the repository's flab.services.uc runs on the router against fixtures (FLAB_FIXTURES), so it executes
   nothing: for every call it only finds, in a fixture file named after the command line it builds, what that command
   would have printed. The test checks the listing, the command lines, the results, the refusal of every invalid
   or protected request (each has a fixture that would report success if its command were run) and the background
   calls. It also runs `list` once for real, which only reads, and compares it with the router's /etc/init.d
   and /etc/rc.d. The harness refuses to run anything but `list` without fixtures.
3. With -Browser, opens the deployed UI in Edge with a temporary rpcd session (tests/TestSession.ps1). The page
   first shows the router's own services, and a `control` call reaching the router would fail the test. Then the
   `flab.services` and `service` objects are mocked and the whole flow (confirmations, outcomes, failures, a login
   that may not control services, a missing plugin, an expired session) is exercised.

Needs ssh/scp access to the router and Node.js. -Browser also needs the deployed UI (deploy.ps1 -Action Deploy)
and installs playwright-core into the temporary work folder. The router work folder (/tmp/flab-services-test), the
session and the local folder are removed afterwards.

.PARAMETER Router
SSH destination of the router.

.PARAMETER Url
Base URL of the deployed UI (used by -Browser).

.PARAMETER Browser
Also run the browser test.
#>
[CmdletBinding()]
param(
    [string]$Router = 'root@openwrt.lab.formicalab.casa',
    [string]$Url = 'https://openwrt.lab.formicalab.casa/flab/',
    [switch]$Browser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
. (Join-Path $here '..\TestSession.ps1')
$sid = $null
$root = (Resolve-Path (Join-Path $here '..\..')).Path
$plugin = Join-Path $root 'rpcd\ucode\flab.services.uc'
$libs = Join-Path $root 'rpcd\lib\flab'
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-services-test'
$remote = '/tmp/flab-services-test'
$scenarios = 'ok', 'fail', 'timeout', 'noresult'

#region Helpers
function Invoke-Native {
    <#
    .SYNOPSIS
    Runs a native command and throws on a nonzero exit code.
    .PARAMETER Command
    Executable name.
    .PARAMETER Arguments
    Argument array passed to the executable.
    #>
    param([string]$Command, [string[]]$Arguments)

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

function Invoke-Remote {
    <#
    .SYNOPSIS
    Runs a POSIX shell script on the router over ssh.
    .DESCRIPTION
    Normalizes line endings to LF because BusyBox sh rejects CRLF.
    .PARAMETER Script
    Shell script text.
    #>
    param([string]$Script)

    Invoke-Native 'ssh' @($Router, ($Script -replace "`r`n", "`n"))
}
#endregion

try {
    Write-Host '1/3 Unit tests: Services model'
    Invoke-Native 'node' @((Join-Path $here 'model.test.mjs'))

    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory (Join-Path $work 'out') -Force | Out-Null

    #region Backend against fixtures
    Write-Host '2/3 Backend: flab.services against fixtures (nothing is executed)'
    Invoke-Native 'node' @((Join-Path $here 'mkfx.mjs'), (Join-Path $work 'fx'))
    Invoke-Remote "rm -rf $remote; mkdir -p $remote"
    Invoke-Native 'scp' @('-O', '-r', $libs, $plugin, (Join-Path $here 'harness.uc'), (Join-Path $work 'fx'), "${Router}:$remote/")
    Invoke-Remote (@'
set -e
cd @REMOTE@
tr -d '\r' < flab.services.uc > p.uc; tr -d '\r' < harness.uc > h.uc
for sc in @SCENARIOS@; do
  FLAB_PLUGIN=@REMOTE@/p.uc FLAB_CASES=@REMOTE@/fx/cases.json FLAB_FIXTURES=@REMOTE@/fx/$sc ucode -L "@REMOTE@/*.uc" h.uc > out-$sc.json 2> err-$sc.txt || { echo "$sc failed:"; cat err-$sc.txt; exit 1; }
  if [ -s err-$sc.txt ]; then echo "$sc wrote to stderr:"; cat err-$sc.txt; exit 1; fi
done
# The real list: only reads. The harness refuses any other call when no fixtures are set.
echo '[{"id":"list","method":"list","args":{}}]' > live-cases.json
FLAB_PLUGIN=@REMOTE@/p.uc FLAB_CASES=@REMOTE@/live-cases.json ucode -L "@REMOTE@/*.uc" h.uc > out-real.json
find /etc/init.d -maxdepth 1 -type f -perm /111 | sed 's#.*/##' > real-init.txt
ls -1 /etc/rc.d > real-rc.txt
'@ -replace '@REMOTE@', $remote -replace '@SCENARIOS@', ($scenarios -join ' '))
    foreach ($sc in $scenarios) {
        Invoke-Native 'scp' @('-O', "${Router}:$remote/out-$sc.json", (Join-Path $work "out\$sc.json"))
    }
    Invoke-Native 'scp' @('-O', "${Router}:$remote/out-real.json", (Join-Path $work 'out\real.json'))
    Invoke-Native 'scp' @('-O', "${Router}:$remote/real-init.txt", "${Router}:$remote/real-rc.txt", (Join-Path $work 'out'))
    Invoke-Native 'node' @((Join-Path $here 'assert.mjs'), (Join-Path $work 'out'))
    #endregion

    if ($Browser) {
        Write-Host '3/3 Browser test'
        Copy-Item (Join-Path $here 'live.mjs') $work
        Push-Location $work
        try {
            Invoke-Native 'npm' @('init', '-y', '--silent')
            Invoke-Native 'npm' @('install', '--silent', 'playwright-core')
            $session = New-TestSession -Router $Router
            $sid = $session.Sid
            $env:FLAB_URL = $Url
            $env:FLAB_SID = $sid
            $env:FLAB_ACLS = $session.Acls
            Invoke-Native 'node' @('live.mjs')
        }
        finally {
            Pop-Location
        }
    }
}
finally {
    # Always remove the router-side work folder, the session and the local folder, even after a failure.
    Remove-TestSession -Router $Router -Sid $sid
    ssh $Router "rm -rf $remote" 2>$null
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
