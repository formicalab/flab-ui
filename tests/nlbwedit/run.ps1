#Requires -Version 7.0
<#
.SYNOPSIS
Tests the nlbwmon settings of the Traffic page without changing the router.

.DESCRIPTION
1. Unit tests of the settings model (reading the config, the draft, validation of every option, the accounting window and the
   periods a lower generation count would delete, the effect texts, the UCI plan, the check after a save and the check that the
   daemon runs with the saved settings).
2. The backend: the repository's flab.traffic.uc runs on the router against fixtures (FLAB_FIXTURES) for its nlbwmon_paths method
   (RAM, flash, USB, read-only and network storage, a missing directory, files in the path, 100+ database files, no /proc/mounts,
   every refused path), and once for real (it only reads), compared with what the router's own tools say.
3. With -Browser, opens the deployed UI in Edge with a temporary rpcd session (tests/TestSession.ps1). The Settings tab is first shown
   against the router's own nlbwmon config with every write blocked (and failing the test if one is attempted), then driven against
   a stateful mock of rpcd's uci object and mocked service and plugin replies: validation of every option, the effects, saving, a
   change the router does not keep, a change that stops nlbwmon, a login that may not write, no nlbwmon, no plugin, session expiry.
   Nothing reaches the router's configuration.

Needs ssh/scp access to the router and Node.js. -Browser also needs the deployed UI (tools/package.ps1 -Action Deploy) and installs
playwright-core into the temporary work folder. Everything created on the router (/tmp/flab-nlbwedit-test) and locally is removed
afterwards.

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
$plugin = Join-Path $root 'rpcd\ucode\flab.traffic.uc'
$libs = Join-Path $root 'rpcd\lib\flab'
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-nlbwedit-test'
$remote = '/tmp/flab-nlbwedit-test'

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
    Write-Host '1/3 Unit tests: the nlbwmon settings model'
    Invoke-Native 'node' @((Join-Path $here 'model.test.mjs'))

    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory (Join-Path $work 'out') -Force | Out-Null

    Write-Host '2/3 Backend: nlbwmon_paths against fixtures (nothing is executed), and a read-only run on the router'
    Invoke-Native 'node' @((Join-Path $here 'mkfx.mjs'), $work)
    $scenarios = @(Get-Content (Join-Path $work 'scenarios.json') -Raw | ConvertFrom-Json)
    Invoke-Remote "rm -rf $remote; mkdir -p $remote/out"
    Invoke-Native 'scp' (@('-O', '-r', $libs, $plugin, (Join-Path $here 'harness.uc'), (Join-Path $work 'cases'), (Join-Path $work 'cases.txt')) + @($scenarios | ForEach-Object { Join-Path $work $_ }) + "${Router}:$remote/")
    Invoke-Remote @"
set -e
cd $remote
# The plugin as a Windows checkout deploys it: with CRLF line endings.
for f in *.uc flab/*.uc; do tr -d '\r' < `$f > `$f.l && mv `$f.l `$f; done
while read -r name scenario method; do
  FLAB_PLUGIN=$remote/flab.traffic.uc FLAB_FIXTURES=$remote/`$scenario FLAB_METHOD=`$method FLAB_ARGS="`$(cat cases/`$name.json)" ucode -L "$remote/*.uc" harness.uc > out/`$name.json 2> err.txt || { echo "`$name failed:"; cat err.txt; exit 1; }
  if [ -s err.txt ]; then echo "`$name wrote to stderr:"; cat err.txt; exit 1; fi
done < cases.txt
# The real router: only reads the paths its own config names.
dir=`$(uci -q get nlbwmon.@nlbwmon[0].database_directory); [ -n "`$dir" ] || dir=/var/lib/nlbwmon
prot=`$(uci -q get nlbwmon.@nlbwmon[0].protocol_database); [ -n "`$prot" ] || prot=/usr/share/nlbwmon/protocols
FLAB_PLUGIN=$remote/flab.traffic.uc FLAB_METHOD=nlbwmon_paths FLAB_ARGS="{\"dir\":\"`$dir\",\"protocols\":\"`$prot\"}" ucode -L "$remote/*.uc" harness.uc > out/real.json
# What the router itself says about the same things: the filesystem type from /proc/mounts (longest mount point that is a prefix of the real path), and the periods nlbw lists.
real=`$(readlink -f "`$dir")
awk -v p="`$real" '(p == `$2 || index(p, `$2 "/") == 1 || `$2 == "/") && length(`$2) >= best { best = length(`$2); t = `$3 } END { print t }' /proc/mounts > out/real-fstype.txt
nlbw -c list 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}`$' | tr -d '-' > out/real-periods.txt || true
"@
    Invoke-Native 'scp' @('-O', '-r', "${Router}:$remote/out", $work)
    Invoke-Native 'node' @((Join-Path $here 'assert.mjs'), $work)

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
