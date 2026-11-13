#Requires -Version 7.0
<#
.SYNOPSIS
Tests the Dynamic DNS page without changing the router.

.DESCRIPTION
1. Unit tests of the page model (reading the plugin's reply, the draft, the review list, validation, the UCI operations, the
   check after a save, the verdict on each service, the intervals and the log).
2. The backend: the repository's flab.ddns.uc runs on the router against fixtures (FLAB_FIXTURES), so it executes nothing: a router
   with five services (secrets in several places, three address sources, a stopped updater, a custom provider, a log over the size
   limit), the restart of an updater under every outcome of the init script (success, failure, timeout, no exit code), and a router
   without ddns-scripts. It asserts that no secret appears in any reply and that every refused request ran nothing. It also runs
   `status` and `log` once for real, which only read, and checks that none of the router's stored secrets is in what they return.
3. With -Browser, opens the deployed UI in Edge with a temporary rpcd session (tests/TestSession.ps1). The page is first shown
   against the router's own configuration with every write blocked (and failing the test if one is attempted), then driven
   against mocked flab.ddns replies and a stateful mock of rpcd's uci object: the status of every kind of service, the actions and
   the log, the whole editing flow (validation, the write-only password, adding and removing services, saving, a change the router
   does not keep, a login that may not write) WITHOUT touching the router's configuration or its updater.

Needs ssh/scp access to the router and Node.js. -Browser also needs the deployed UI (deploy.ps1 -Action Deploy) and installs
playwright-core into the temporary work folder. Everything created on the router (/tmp/flab-ddns-test) and locally is removed
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
$plugin = Join-Path $root 'rpcd\ucode\flab.ddns.uc'
$libs = Join-Path $root 'rpcd\lib\flab'
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-ddns-test'
$remote = '/tmp/flab-ddns-test'
$scenarios = 'main', 'fail', 'timeout', 'noresult', 'empty'

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
    Write-Host '1/3 Unit tests: the Dynamic DNS model'
    Invoke-Native 'node' @((Join-Path $here 'model.test.mjs'))

    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory (Join-Path $work 'out') -Force | Out-Null

    #region Backend against fixtures
    Write-Host '2/3 Backend: flab.ddns against fixtures (nothing is executed), and a read-only run on the router'
    Invoke-Native 'node' @((Join-Path $here 'mkfx.mjs'), (Join-Path $work 'fx'))
    Invoke-Remote "rm -rf $remote; mkdir -p $remote"
    Invoke-Native 'scp' @('-O', '-r', $libs, $plugin, (Join-Path $here 'harness.uc'), (Join-Path $work 'fx'), "${Router}:$remote/")
    Invoke-Remote (@'
set -e
cd @REMOTE@
# The plugin as a Windows checkout deploys it: with CRLF line endings.
tr -d '\r' < flab.ddns.uc > p.uc; tr -d '\r' < harness.uc > h.uc
for f in flab/*.uc; do tr -d '\r' < $f > $f.l && mv $f.l $f; done
for sc in @SCENARIOS@; do
  FLAB_PLUGIN=@REMOTE@/p.uc FLAB_CASES=@REMOTE@/fx/cases.json FLAB_FIXTURES=@REMOTE@/fx/$sc ucode -L "@REMOTE@/*.uc" h.uc > out-$sc.json 2> err-$sc.txt || { echo "$sc failed:"; cat err-$sc.txt; exit 1; }
  if [ -s err-$sc.txt ]; then echo "$sc wrote to stderr:"; cat err-$sc.txt; exit 1; fi
done
# The real router: only reads (the harness refuses `control` when no fixtures are set), `status` and the log of every service.
names=$(uci show ddns 2>/dev/null | sed -n 's/^ddns\.\([^.=]*\)=service$/\1/p')
printf '%s\n' "$names" | sed '/^$/d' > real-sections.txt
{ printf '[{"id":"status","method":"status","args":{}}'; for n in $names; do printf ',{"id":"log:%s","method":"log","args":{"section":"%s"}}' "$n" "$n"; done; printf ']'; } > live-cases.json
FLAB_PLUGIN=@REMOTE@/p.uc FLAB_CASES=@REMOTE@/live-cases.json ucode -L "@REMOTE@/*.uc" h.uc > out-real.json
# How often a stored secret appears in the reply: only the count leaves the router, never the secret.
leaks=0
for v in $(uci show ddns 2>/dev/null | sed -n "s/^ddns\.[^.]*\.\(password\|[a-z_]*passw[a-z_]*\|[a-z_]*secret[a-z_]*\|[a-z_]*token[a-z_]*\|api_key\|apikey\)='\(.*\)'$/\2/p"); do
  [ ${#v} -ge 4 ] || continue
  c=$(grep -c -F -- "$v" out-real.json || true)
  leaks=$((leaks + c))
done
echo $leaks > real-leaks.txt
'@ -replace '@REMOTE@', $remote -replace '@SCENARIOS@', ($scenarios -join ' '))
    foreach ($sc in $scenarios) {
        Invoke-Native 'scp' @('-O', "${Router}:$remote/out-$sc.json", (Join-Path $work "out\$sc.json"))
    }
    Invoke-Native 'scp' @('-O', "${Router}:$remote/out-real.json", (Join-Path $work 'out\real.json'))
    Invoke-Native 'scp' @('-O', "${Router}:$remote/real-sections.txt", "${Router}:$remote/real-leaks.txt", (Join-Path $work 'out'))
    Invoke-Native 'node' @((Join-Path $here 'assert.mjs'), (Join-Path $work 'out'))

    # The script that makes the updater pass every character of a password, tested on a copy of the router's ddns-scripts files.
    Write-Host '    The ddns-scripts password patch, on a copy of the files'
    Invoke-Native 'scp' @('-O', (Join-Path $root 'tools\patch-ddns-scripts.sh'), (Join-Path $here 'patch-test.sh'), "${Router}:$remote/")
    Invoke-Remote "cd $remote && tr -d '\r' < patch-ddns-scripts.sh > p.sh && tr -d '\r' < patch-test.sh > t.sh && sh t.sh $remote/p.sh"
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
