#Requires -Version 7.0
<#
.SYNOPSIS
Tests editing the wireless configuration on the Wi-Fi page without changing the router.

.DESCRIPTION
1. Unit tests of the editing model (reading the plugins' replies, the draft, the review list, validation, the UCI operations, the
   check after a save, what to wait for after the change).
2. The backend: the repository's flab.radio.uc runs on the router against fixtures (FLAB_FIXTURES), so it executes nothing: a router
   with three radios (one running, one switched off, one whose phy is unknown), access points and a client network that hold every
   kind of secret, a mesh interface, an unnamed section and sections of other types, and routers with a smaller hostapd, without
   hostapd, and without radios. It asserts that no secret appears in any reply of `config` or `status`. It also runs both methods
   once for real, which only read, and checks that none of the router's stored Wi-Fi secrets is in what they return.
3. With -Browser, opens the deployed UI in Edge with a temporary rpcd session (tests/TestSession.ps1). The page is first shown
   against the router's own configuration with every write blocked (and failing the test if one is attempted), then driven
   against mocked flab.radio replies and a stateful mock of rpcd's uci object: the whole editing flow (radio settings, adding,
   changing and removing networks, the write-only passwords, validation, the warnings, saving, a change the router does not keep,
   a radio that does not come back, a login that may not write, a router whose plugin cannot report the configuration) WITHOUT
   touching the router's configuration.

Needs ssh/scp access to the router and Node.js. -Browser also needs the deployed UI (deploy.ps1 -Action Deploy) and installs
playwright-core into the temporary work folder. Everything created on the router (/tmp/flab-wifiedit-test) and locally is removed
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
$plugin = Join-Path $root 'rpcd\ucode\flab.radio.uc'
$libs = Join-Path $root 'rpcd\lib\flab'
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-wifiedit-test'
$remote = '/tmp/flab-wifiedit-test'
$scenarios = 'main', 'basic', 'nohostapd', 'empty'

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
    Write-Host '1/3 Unit tests: the Wi-Fi editing model'
    Invoke-Native 'node' @((Join-Path $here 'model.test.mjs'))

    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory (Join-Path $work 'out') -Force | Out-Null

    #region Backend against fixtures
    Write-Host '2/3 Backend: flab.radio against fixtures (nothing is executed), and a read-only run on the router'
    Invoke-Native 'node' @((Join-Path $here 'mkfx.mjs'), (Join-Path $work 'fx'))
    Invoke-Remote "rm -rf $remote; mkdir -p $remote"
    Invoke-Native 'scp' @('-O', '-r', $libs, $plugin, (Join-Path $here 'harness.uc'), (Join-Path $work 'fx'), "${Router}:$remote/")
    Invoke-Remote (@'
set -e
cd @REMOTE@
# The plugin as a Windows checkout deploys it: with CRLF line endings.
tr -d '\r' < flab.radio.uc > p.uc; tr -d '\r' < harness.uc > h.uc
for f in flab/*.uc; do tr -d '\r' < $f > $f.l && mv $f.l $f; done
for sc in @SCENARIOS@; do
  FLAB_PLUGIN=@REMOTE@/p.uc FLAB_CASES=@REMOTE@/fx/cases.json FLAB_FIXTURES=@REMOTE@/fx/$sc ucode -L "@REMOTE@/*.uc" h.uc > out-$sc.json 2> err-$sc.txt || { echo "$sc failed:"; cat err-$sc.txt; exit 1; }
  if [ -s err-$sc.txt ]; then echo "$sc wrote to stderr:"; cat err-$sc.txt; exit 1; fi
done
# The real router: both methods only read.
{ printf '[{"id":"config","method":"config","args":{}},{"id":"status","method":"status","args":{}}]'; } > live-cases.json
FLAB_PLUGIN=@REMOTE@/p.uc FLAB_CASES=@REMOTE@/live-cases.json ucode -L "@REMOTE@/*.uc" h.uc > out-real.json
# The stored secrets of the router's wireless config: the value of every option that holds one, split at spaces (a list is shown by
# uci as quoted words), words of 8 characters or more only. How often one appears in the reply: only the counts leave the router.
uci show wireless 2>/dev/null | grep -E "\.(key|key[1-4]|sae_password|auth_secret|acct_secret|dae_secret|identity|password|priv_key_pwd|wps_pin|r0kh|r1kh)=" | sed "s/^[^=]*=//; s/'//g" | tr ' ' '\n' | awk 'length($0) >= 8' > secrets.txt
leaks=0
while read -r v; do
  c=$(grep -c -F -- "$v" out-real.json || true)
  leaks=$((leaks + c))
done < secrets.txt
echo $leaks > real-leaks.txt
wc -l < secrets.txt | tr -d ' ' > real-checked.txt
rm -f secrets.txt
'@ -replace '@REMOTE@', $remote -replace '@SCENARIOS@', ($scenarios -join ' '))
    foreach ($sc in $scenarios) {
        Invoke-Native 'scp' @('-O', "${Router}:$remote/out-$sc.json", (Join-Path $work "out\$sc.json"))
    }
    Invoke-Native 'scp' @('-O', "${Router}:$remote/out-real.json", "${Router}:$remote/real-leaks.txt", "${Router}:$remote/real-checked.txt", (Join-Path $work 'out'))
    Rename-Item (Join-Path $work 'out\out-real.json') 'real.json' -ErrorAction SilentlyContinue
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
