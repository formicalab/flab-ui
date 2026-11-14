#Requires -Version 7.0
<#
.SYNOPSIS
Deploys or removes the flab-ui dashboard on the GL-MT6000.

.DESCRIPTION
Deploy copies www/ to the router's tmpfs (/tmp/flab), links it at /www/flab, and installs every rpcd ACL
fragment (rpcd/acl.d), rpcd plugin (rpcd/ucode) and shared ucode module (rpcd/lib). The UI signs in with the
router's own 'root' login, as LuCI does, so no login is created: root's read and write '*' means every ACL group
installed on the router, and the fragments are what add the flab-ui calls to it. Cleanup reverses every change.
The only flash writes are the rpcd files and the /www/flab symlink; Cleanup removes them.

rpcd is restarted so it loads the plugins, which ends every active rpcd session (the browser asks for a new
sign-in).

Sync copies only www/ over the deployed UI (nothing is removed, rpcd is not restarted, no session ends), for the quick
iterations of a front-end change. It needs a UI that Deploy has already installed.

.PARAMETER Action
Deploy, Cleanup or Sync.

.PARAMETER Router
SSH destination of the router.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Deploy', 'Cleanup', 'Sync')][string]$Action,
    [string]$Router = 'root@openwrt.lab.formicalab.casa'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot

#region Helpers
function Invoke-Remote {
    <#
    .SYNOPSIS
    Runs a POSIX shell script on the router over SSH.
    .DESCRIPTION
    Normalizes line endings to LF (BusyBox sh rejects CRLF) and throws on a nonzero exit code.
    .PARAMETER Script
    Shell script text.
    #>
    param([Parameter(Mandatory)][string]$Script)

    ssh $Router ($Script -replace "`r`n", "`n")
    if ($LASTEXITCODE -ne 0) { throw "Remote command failed with exit code $LASTEXITCODE" }
}

function Copy-ToRouter {
    <#
    .SYNOPSIS
    Copies local files or folders to the router with scp.
    .DESCRIPTION
    dropbear has no sftp-server, so scp must use the legacy protocol (-O). Throws on failure.
    .PARAMETER Path
    Local files or folders to copy.
    .PARAMETER Destination
    Remote directory, ending in a slash.
    .PARAMETER Recurse
    Copy folders recursively.
    #>
    param(
        [Parameter(Mandatory)][string[]]$Path,
        [Parameter(Mandatory)][string]$Destination,
        [switch]$Recurse
    )

    $scpArgs = @('-O')
    if ($Recurse) { $scpArgs += '-r' }
    scp @scpArgs @Path "${Router}:$Destination"
    if ($LASTEXITCODE -ne 0) { throw "scp to $Destination failed with exit code $LASTEXITCODE" }
}
#endregion

#region Cleanup script (also run before Deploy so it is idempotent)
$cleanup = @'
set -e
# Diagnostics still running from the Diagnostics tab are ended first; a pid is only killed when it is one of the tools or
# the shell of one of the job scripts.
for p in /tmp/flab-diag/*/pid; do
  [ -f "$p" ] || continue
  pid=$(cat "$p"); c=$(cat "/proc/$pid/comm" 2>/dev/null || true)
  case "$c" in
    timeout|ping|ping6|traceroute|traceroute6|nslookup|dig|kdig|drill) kill "$pid" 2>/dev/null || true ;;
    sh) if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'job\.sh'; then kill "$pid" 2>/dev/null || true; fi ;;
  esac
done
rm -rf /tmp/flab-diag /tmp/flab-service.out
rm -f /www/flab
rm -rf /tmp/flab
rm -f /usr/share/rpcd/acl.d/flab*.json
rm -f /usr/share/rpcd/ucode/flab.*.uc
rm -rf /usr/share/ucode/flab
# The ddns-scripts password patch is undone (the originals it kept are put back).
for f in /usr/lib/ddns/*.flab-orig; do [ -f "$f" ] && mv -f "$f" "${f%.flab-orig}" || true; done
/etc/init.d/rpcd restart
'@
#endregion

switch ($Action) {
    'Sync' {
        # The UI must already be deployed (the folder exists); only the static files are replaced.
        Invoke-Remote 'test -d /tmp/flab || { echo "The UI is not deployed: run deploy.ps1 -Action Deploy first."; exit 1; }'
        Copy-ToRouter -Recurse -Path @(Get-ChildItem (Join-Path $root 'www') | ForEach-Object FullName) -Destination '/tmp/flab/'
        Write-Host 'Synced www/ to the deployed UI.'
    }
    'Cleanup' {
        Invoke-Remote $cleanup
        Invoke-Remote 'ls -d /www/flab /tmp/flab /tmp/flab-diag /usr/share/ucode/flab /usr/share/rpcd/acl.d/flab* /usr/share/rpcd/ucode/flab* 2>&1; true'
        Write-Host 'Router cleaned.'
    }
    'Deploy' {
        Invoke-Remote $cleanup
        Invoke-Remote 'mkdir -p /tmp/flab /usr/share/ucode/flab && ln -s /tmp/flab /www/flab'

        $www = Join-Path $root 'www'
        $rpcd = Join-Path $root 'rpcd'
        Copy-ToRouter -Recurse -Path @(Get-ChildItem $www | ForEach-Object FullName) -Destination '/tmp/flab/'
        Copy-ToRouter -Path @(Get-ChildItem (Join-Path $rpcd 'acl.d') -File | ForEach-Object FullName) -Destination '/usr/share/rpcd/acl.d/'
        Copy-ToRouter -Path @(Get-ChildItem (Join-Path $rpcd 'ucode') -File | ForEach-Object FullName) -Destination '/usr/share/rpcd/ucode/'
        Copy-ToRouter -Path @(Get-ChildItem (Join-Path $rpcd 'lib\flab') -File | ForEach-Object FullName) -Destination '/usr/share/ucode/flab/'
        # ddns-scripts mangles some characters of a password; the patch makes it pass every character unchanged. A package that is
        # not the expected version is left alone (the Dynamic DNS page then warns about those characters).
        Copy-ToRouter -Path (Join-Path $root 'tools\patch-ddns-scripts.sh') -Destination '/tmp/flab-ddns-patch.sh'
        Invoke-Remote "tr -d '\r' < /tmp/flab-ddns-patch.sh > /tmp/flab-ddns-patch.run; sh /tmp/flab-ddns-patch.run apply || echo 'Warning: ddns-scripts was not patched (see above).'; rm -f /tmp/flab-ddns-patch.sh /tmp/flab-ddns-patch.run"
        # rpcd only reads its plugins and ACL fragments at start.
        Invoke-Remote '/etc/init.d/rpcd restart'

        $hostName = $Router.Split('@')[-1]
        Write-Host "Deployed. Open https://$hostName/flab/ and sign in as root."
    }
}
