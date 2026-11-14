#Requires -Version 7.0
<#
.SYNOPSIS
Tests the editable Firewall page without changing the router.

.DESCRIPTION
1. Unit tests: the editing model (reading the config, the draft, zones, forwardings, rules, port forwards and the defaults, validation, the
   lock-out check, the UCI operations and the order of sections, the check after a save) and, from the network suite, the read-only
   matrix and findings and the configuration-change helpers. They need no router.
2. The backend: the repository's flab.firewall.uc runs on the router against fixtures (FLAB_FIXTURES), so it executes nothing: a router like the
   lab one, one without a defaults section, an older config, a stopped firewall, no interface dump and a zone the firewall did not load. It
   also runs once for real, which only reads, and compares the counts with `uci show`.
3. With -Browser, opens the deployed UI in Edge with a temporary rpcd session (tests/TestSession.ps1). The page is first shown against the
   router's own firewall with every write blocked (and failing the test if one is attempted), then driven against a stateful mock of rpcd's
   uci object and mocked flab.firewall replies: the whole editing flow (zones, forwardings, rules, port forwards, defaults, validation, the
   lock-out confirmation, saving, a change the router does not keep, a firewall that stops loading, a login that may not write, a missing
   plugin, an expired session) WITHOUT touching the router's configuration.

Needs ssh/scp access to the router and Node.js. -Browser also needs the deployed UI (tools/package.ps1 -Action Deploy) and installs playwright-core
into the temporary work folder. Everything created on the router (/tmp/flab-fwedit-test) and locally is removed afterwards.

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
$plugin = Join-Path $root 'rpcd\ucode\flab.firewall.uc'
$libs = Join-Path $root 'rpcd\lib\flab'
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-fwedit-test'
$remote = '/tmp/flab-fwedit-test'

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
    Write-Host '1/3 Unit tests: the firewall editing model, the read-only model, the configuration-change helpers'
    Invoke-Native 'node' @((Join-Path $here 'model.test.mjs'))
    Invoke-Native 'node' @((Join-Path $here '..\network\firewall.test.mjs'))
    Invoke-Native 'node' @((Join-Path $here '..\network\uci.test.mjs'))

    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory (Join-Path $work 'out') -Force | Out-Null

    #region Backend against fixtures
    Write-Host '2/3 Backend: flab.firewall against fixtures (nothing is executed), and a read-only run on the router'
    Invoke-Native 'node' @((Join-Path $here 'mkfx.mjs'), (Join-Path $work 'fx'))
    $scenarios = (Get-Content (Join-Path $work 'fx\scenarios.json') -Raw | ConvertFrom-Json) -join ' '
    Invoke-Remote "rm -rf $remote; mkdir -p $remote"
    Invoke-Native 'scp' @('-O', '-r', $libs, $plugin, (Join-Path $here 'harness.uc'), (Join-Path $work 'fx'), "${Router}:$remote/")
    Invoke-Remote (@'
set -e
cd @REMOTE@
# The plugin as a Windows checkout deploys it: with CRLF line endings.
tr -d '\r' < flab.firewall.uc > p.uc; tr -d '\r' < harness.uc > h.uc
for f in flab/*.uc; do tr -d '\r' < $f > $f.l && mv $f.l $f; done
for sc in @SCENARIOS@; do
  FLAB_PLUGIN=@REMOTE@/p.uc FLAB_FIXTURES=@REMOTE@/fx/$sc ucode -L "@REMOTE@/*.uc" h.uc > out-$sc.json 2> err-$sc.txt || { echo "$sc failed:"; cat err-$sc.txt; exit 1; }
  if [ -s err-$sc.txt ]; then echo "$sc wrote to stderr:"; cat err-$sc.txt; exit 1; fi
done
# The real router: the plugin only reads.
FLAB_PLUGIN=@REMOTE@/p.uc ucode -L "@REMOTE@/*.uc" h.uc > out-real.json
{
  echo "rules=$(uci show firewall | grep -c '=rule$')"
  echo "zones=$(uci show firewall | grep -c '=zone$')"
  echo "redirects=$(( $(uci show firewall | grep -c '=redirect$') + $(uci show firewall | grep -c '=nat$') ))"
  # How often a stored private key appears in the reply: only the count leaves the router, never the key.
  leaks=0
  for v in $(uci show network 2>/dev/null | sed -n "s/^network\.[^.]*\.\(private_key\|preshared_key\)='\(.*\)'$/\2/p"); do
    [ ${#v} -ge 8 ] || continue
    c=$(grep -c -F -- "$v" out-real.json || true)
    leaks=$((leaks + c))
  done
  echo "privatekeys=$leaks"
} > real-facts.txt
'@ -replace '@REMOTE@', $remote -replace '@SCENARIOS@', $scenarios)
    foreach ($sc in ($scenarios -split ' ') + 'real') {
        Invoke-Native 'scp' @('-O', "${Router}:$remote/out-$sc.json", (Join-Path $work "out\$sc.json"))
    }
    Invoke-Native 'scp' @('-O', "${Router}:$remote/real-facts.txt", (Join-Path $work 'out'))
    Invoke-Native 'node' @((Join-Path $here 'assert.mjs'), $work)
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
