#Requires -Version 7.0
<#
.SYNOPSIS
Tests the WireGuard page's editing without changing the router.

.DESCRIPTION
1. Unit tests of the page's pure parts: the address math, the keys (X25519 against the RFC 7748 vectors, WebCrypto against the plain
   implementation), and the model (reading the plugin's reply, the draft, the review list, validation, the UCI operations, the check
   after a save, the warnings about cutting your own tunnel, the "add a client" helpers).
2. The backend: the repository's flab.wireguard.uc runs on the router against fixtures (FLAB_FIXTURES), so it executes nothing: a router
   with a running interface, a disabled one, one only the kernel has, peers with pre-shared keys, a peer whose public key option holds
   a pasted secret, and the connections /proc/net/tcp and /proc/net/tcp6 list; and a router without WireGuard. It asserts that no key
   or other secret appears in any reply. It also runs `status` once for real, which only reads, and checks that none of the router's
   stored private or pre-shared keys is in what it returns.
3. With -Browser, opens the deployed UI in Edge with a temporary rpcd session (tests/TestSession.ps1). The page is first shown against the
   router's own configuration with every write blocked (and failing the test if one is attempted, or if the page reads the network
   config with uci get), then driven against a mock of the flab.wireguard plugin built from a stateful mock of rpcd's uci object: the
   whole editing flow (validation, write-only keys, the key generator, adding and removing interfaces and peers, the add-a-client
   dialog, the warnings about your own tunnel, saving, a change the router does not keep, an interface that does not come up, a login that
   may not write) WITHOUT touching the router's configuration.

Needs ssh/scp access to the router and Node.js. -Browser also needs the deployed UI (tools/package.ps1) and installs playwright-core into the
temporary work folder. Everything created on the router (/tmp/flab-wgedit-test) and locally is removed afterwards.

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
$plugin = Join-Path $root 'rpcd\ucode\flab.wireguard.uc'
$libs = Join-Path $root 'rpcd\lib\flab'
$work = Join-Path ([IO.Path]::GetTempPath()) 'flab-wgedit-test'
$remote = '/tmp/flab-wgedit-test'
$scenarios = 'main', 'empty', 'oldproto'

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
    Write-Host '1/3 Unit tests: the WireGuard model'
    Invoke-Native 'node' @((Join-Path $here 'model.test.mjs'))

    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory (Join-Path $work 'out') -Force | Out-Null

    #region Backend against fixtures
    Write-Host '2/3 Backend: flab.wireguard against fixtures (nothing is executed), and a read-only run on the router'
    Invoke-Native 'node' @((Join-Path $here 'mkfx.mjs'), (Join-Path $work 'fx'))
    Invoke-Remote "rm -rf $remote; mkdir -p $remote"
    Invoke-Native 'scp' @('-O', '-r', $libs, $plugin, (Join-Path $here 'harness.uc'), (Join-Path $work 'fx'), "${Router}:$remote/")
    Invoke-Remote (@'
set -e
cd @REMOTE@
# The plugin as a Windows checkout deploys it: with CRLF line endings.
tr -d '\r' < flab.wireguard.uc > p.uc; tr -d '\r' < harness.uc > h.uc
for f in flab/*.uc; do tr -d '\r' < $f > $f.l && mv $f.l $f; done
for sc in @SCENARIOS@; do
  FLAB_PLUGIN=@REMOTE@/p.uc FLAB_FIXTURES=@REMOTE@/fx/$sc ucode -L "@REMOTE@/*.uc" h.uc > out-$sc.json 2> err-$sc.txt || { echo "$sc failed:"; cat err-$sc.txt; exit 1; }
  if [ -s err-$sc.txt ]; then echo "$sc wrote to stderr:"; cat err-$sc.txt; exit 1; fi
done
# The real router: only reads (uci, wg show, procfs).
FLAB_PLUGIN=@REMOTE@/p.uc ucode -L "@REMOTE@/*.uc" h.uc > out-real.json
# How often a stored key appears in the reply: only the count leaves the router, never the key.
leaks=0
for v in $(uci -q show network | sed -n "s/^network\.[^=]*\.\(private_key\|preshared_key\)='\(.*\)'$/\2/p"); do
  [ ${#v} -ge 20 ] || continue
  c=$(grep -c -F -- "$v" out-real.json || true)
  leaks=$((leaks + c))
done
echo $leaks > real-leaks.txt
uci -X show network | sed -n 's/^network\.\(cfg[0-9a-f]*\)=wireguard_.*/\1/p' > real-peers.txt
echo "${SSH_CLIENT%% *}" > real-client.txt
'@ -replace '@REMOTE@', $remote -replace '@SCENARIOS@', ($scenarios -join ' '))
    foreach ($sc in $scenarios) {
        Invoke-Native 'scp' @('-O', "${Router}:$remote/out-$sc.json", (Join-Path $work "out\$sc.json"))
    }
    Invoke-Native 'scp' @('-O', "${Router}:$remote/out-real.json", (Join-Path $work 'out\real.json'))
    Invoke-Native 'scp' @('-O', "${Router}:$remote/real-leaks.txt", "${Router}:$remote/real-peers.txt", "${Router}:$remote/real-client.txt", (Join-Path $work 'out'))
    Copy-Item (Join-Path $work 'fx\keys.json') (Join-Path $work 'out')
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
