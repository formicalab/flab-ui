#Requires -Version 7.0
<#
.SYNOPSIS
Tests the Routing page (kernel routes, tables, policy rules, the next-hop lookup and BGP) without changing the router.

.DESCRIPTION
1. Unit tests of the page model (address math, tables, findings, filtering and sorting, what a lookup answer means).
2. Captures what the flab.routing plugin reads from the router (read-only ip commands) as the "real" scenario.
3. Builds a synthetic scenario that holds every route and rule syntax the parser handles, with the lookup answers,
   and runs the repository's flab.routing.uc on the router against every scenario (FLAB_FIXTURES), asserting the JSON.
   The lookup arguments are also tried with shell metacharacters, which must be refused before any command runs.
4. With -Browser, opens the deployed UI in Edge with a temporary rpcd session (tests/TestSession.ps1) and drives the
   Routing page with mocked flab.routing replies: the Routes tab, the lookup (and its buttons into the Toolbox), the
   table and rule cards, and the BGP tab. Nothing reaches the router's configuration.

The diagnostic tools have their own suite, tests/toolbox/run.ps1.

Needs ssh/scp access to the router and Node.js. -Browser also needs the deployed UI (deploy.ps1 -Action Deploy) and
installs playwright-core into the temporary work folder. Everything created on the router (/tmp/flab-routing-test) and
locally is removed afterwards.

.PARAMETER Router
SSH destination of the router.

.PARAMETER Url
Base URL of the deployed UI (used by -Browser).

.PARAMETER Browser
Also run the browser test.

.PARAMETER KeepWork
Keep the local work folder (the plugin outputs and the browser test's node modules) after the run, so the browser test
can be repeated by hand. The folder is %TEMP%\flab-routing-test.
#>
[CmdletBinding()]
param(
    [string]$Router = 'root@openwrt.lab.formicalab.casa',
    [string]$Url = 'https://openwrt.lab.formicalab.casa/flab/',
    [switch]$Browser,
    [switch]$KeepWork
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
. (Join-Path $here '..\TestSession.ps1')
$sid = $null
$root = (Resolve-Path (Join-Path $here '..\..')).Path
$plugin = Join-Path $root 'rpcd\ucode\flab.routing.uc'
$libs = Join-Path $root 'rpcd\lib\flab'
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-routing-test'
$remote = '/tmp/flab-routing-test'

#region Helpers
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
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory (Join-Path $work 'out') -Force | Out-Null

    Write-Host '1/4 Unit tests: routing model'
    Invoke-Native 'node' @((Join-Path $here 'model.test.mjs'))

    Write-Host '2/4 Capturing the router (read-only ip commands)'
    Invoke-Remote "rm -rf $remote; mkdir -p $remote/fx-real"
    Invoke-Native 'scp' @('-O', '-r', $libs, $plugin, (Join-Path $here 'harness.uc'), "${Router}:$remote/")
    Invoke-Remote @"
set -e
cd $remote
for f in *.uc flab/*.uc; do tr -d '\r' < `$f > `$f.l && mv `$f.l `$f; done
FLAB_RECORD=$remote/fx-real FLAB_PLUGIN=$remote/flab.routing.uc ucode -L "$remote/*.uc" harness.uc > /dev/null
"@
    Invoke-Native 'scp' @('-O', '-r', "${Router}:$remote/fx-real", $work)

    Write-Host '3/4 Building scenarios and running the routing plugin on the router'
    Invoke-Native 'node' @((Join-Path $here 'mkfx.mjs'), $work)
    $scenarios = @(Get-Content (Join-Path $work 'scenarios.json') -Raw | ConvertFrom-Json)
    $lookups = @(Get-Content (Join-Path $work 'lookup-names.json') -Raw | ConvertFrom-Json)
    Invoke-Native 'scp' (@('-O', '-r') + @($scenarios | ForEach-Object { Join-Path $work $_ }) + (Join-Path $work 'lookups') + "${Router}:$remote/")
    Invoke-Remote @"
set -e
cd $remote
run() { FLAB_PLUGIN=$remote/flab.routing.uc FLAB_FIXTURES=$remote/`$1 FLAB_METHOD=`$2 FLAB_ARGS="`$3" ucode -L "$remote/*.uc" harness.uc > "`$4" 2> err.txt || { echo "`$1/`$2 failed:"; cat err.txt; exit 1; }; if [ -s err.txt ]; then echo "`$1/`$2 wrote to stderr:"; cat err.txt; exit 1; fi; }
for sc in $($scenarios -join ' '); do run `$sc status '' out-`$sc.status.json; done
for l in $($lookups -join ' '); do run rich lookup "`$(cat lookups/`$l.json)" out-rich.lookup-`$l.json; done
"@
    foreach ($sc in $scenarios) { Invoke-Native 'scp' @('-O', "${Router}:$remote/out-$sc.status.json", (Join-Path $work "out\$sc.status.json")) }
    foreach ($l in $lookups) { Invoke-Native 'scp' @('-O', "${Router}:$remote/out-rich.lookup-$l.json", (Join-Path $work "out\rich.lookup-$l.json")) }
    Copy-Item (Join-Path $work 'lookup-names.json') (Join-Path $work 'out')

    Write-Host '4/4 Asserting'
    Invoke-Native 'node' @((Join-Path $here 'assert.mjs'), (Join-Path $work 'out'))

    if ($Browser) {
        Write-Host 'Browser test'
        Copy-Item (Join-Path $here 'live.mjs') $work
        Push-Location $work
        try {
            Invoke-Native 'npm' @('init', '-y', '--silent')
            Invoke-Native 'npm' @('install', '--silent', 'playwright-core')
            $env:FLAB_URL = $Url
            $session = New-TestSession -Router $Router
            $sid = $session.Sid
            $env:FLAB_SID = $sid
            $env:FLAB_ACLS = $session.Acls
            Invoke-Native 'node' @('live.mjs', (Join-Path $work 'out'))
        }
        finally {
            Pop-Location
        }
    }
}
finally {
    # Always remove the router-side work folder and the local one, even after a failure.
    Remove-TestSession -Router $Router -Sid $sid
    ssh $Router "rm -rf $remote" 2>$null
    if (-not $KeepWork) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
}
