#Requires -Version 7.0
<#
.SYNOPSIS
Tests the editors of the Devices and Interfaces page (the network board, with the interface, device and port panels) without changing the router.

.DESCRIPTION
1. Unit tests of the editor's pure model (value checks, the option tables, reading the plugin's reply, the draft, the review list, validation
   of addresses, subnets, gateways, devices, ports and VLANs, the dangerous changes, the UCI operations, the check after a save).
2. The backend: the repository's flab.network.uc runs its `config` call on the router against fixtures (FLAB_FIXTURES): a router with a
   secret in every kind of place (a PPPoE password, a WireGuard private and pre-shared key, a SIM PIN, a modem password, psk and key
   options), an empty config and a missing one. It asserts that no secret appears in any reply. It also runs `config` once for real, which
   only reads, compares the reply with the router's config and counts how often a stored secret appears in it (only the count leaves the
   router). The harness refuses every other call.
3. With -Browser, opens the deployed UI in Edge with a temporary rpcd session (tests/TestSession.ps1). The board is first shown against
   the router's own configuration with every write blocked (and failing the test if one is attempted), then driven against a mocked router:
   a stateful mock of rpcd's uci object and mocked flab.network and netifd replies drive the whole editing flow (validation, the write-only
   password, adding and removing interfaces and devices, moving a port between bridges, the warnings and the confirmation before a risky
   change, saving, a change the router does not keep, an interface that does not come up, a login that may not write, a missing plugin
   method, an expired session) WITHOUT touching the router's configuration.

Needs ssh/scp access to the router and Node.js. -Browser also needs the deployed UI (tools/package.ps1 -Action Deploy) and installs playwright-core
into the temporary work folder. Everything created on the router (/tmp/flab-ifedit-test) and locally is removed afterwards.

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
$plugin = Join-Path $root 'rpcd\ucode\flab.network.uc'
$libs = Join-Path $root 'rpcd\lib\flab'
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-ifedit-test'
$remote = '/tmp/flab-ifedit-test'
$scenarios = 'main', 'empty', 'missing'

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
    Write-Host '1/3 Unit tests: the network editor model'
    Invoke-Native 'node' @((Join-Path $here 'model.test.mjs'))

    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory (Join-Path $work 'out') -Force | Out-Null

    #region Backend against fixtures
    Write-Host '2/3 Backend: flab.network config against fixtures, and a read-only run on the router'
    Invoke-Native 'node' @((Join-Path $here 'mkfx.mjs'), (Join-Path $work 'fx'))
    Invoke-Remote "rm -rf $remote; mkdir -p $remote"
    Invoke-Native 'scp' @('-O', '-r', $libs, $plugin, (Join-Path $here 'harness.uc'), (Join-Path $work 'fx'), "${Router}:$remote/")
    Invoke-Remote (@'
set -e
cd @REMOTE@
# The plugin as a Windows checkout deploys it: with CRLF line endings.
tr -d '\r' < flab.network.uc > p.uc; tr -d '\r' < harness.uc > h.uc
for f in flab/*.uc; do tr -d '\r' < $f > $f.l && mv $f.l $f; done
for sc in @SCENARIOS@; do
  FLAB_PLUGIN=@REMOTE@/p.uc FLAB_CASES=@REMOTE@/fx/cases.json FLAB_FIXTURES=@REMOTE@/fx/$sc ucode -L "@REMOTE@/*.uc" h.uc > out-$sc.json 2> err-$sc.txt || { echo "$sc failed:"; cat err-$sc.txt; exit 1; }
  if [ -s err-$sc.txt ]; then echo "$sc wrote to stderr:"; cat err-$sc.txt; exit 1; fi
done
# The real router: only reads.
FLAB_PLUGIN=@REMOTE@/p.uc FLAB_CASES=@REMOTE@/fx/cases.json ucode -L "@REMOTE@/*.uc" h.uc > out-real.json
printf 'interface %s\ndevice %s\nglobals %s\n' "$(uci show network 2>/dev/null | grep -c '=interface$')" "$(uci show network 2>/dev/null | grep -c '=device$')" "$(uci show network 2>/dev/null | grep -c '=globals$')" > real-counts.txt
# How often a stored secret appears in the reply: only the count leaves the router, never the secret.
leaks=0
for v in $(uci show network 2>/dev/null | sed -n "s/^network\.[^=]*\.\(password\|passwd\|private_key\|preshared_key\|psk\|key\|pin\|pincode\)='\(.*\)'$/\2/p"); do
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
    Invoke-Native 'scp' @('-O', "${Router}:$remote/real-counts.txt", "${Router}:$remote/real-leaks.txt", (Join-Path $work 'out'))
    Invoke-Native 'node' @((Join-Path $here 'assert.mjs'), (Join-Path $work 'fx'), (Join-Path $work 'out'))
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
