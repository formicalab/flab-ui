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

.PARAMETER Action
Deploy or Cleanup.

.PARAMETER Router
SSH destination of the router.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Deploy', 'Cleanup')][string]$Action,
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
rm -f /www/flab
rm -rf /tmp/flab
rm -f /usr/share/rpcd/acl.d/flab*.json
rm -f /usr/share/rpcd/ucode/flab.*.uc
rm -rf /usr/share/ucode/flab
/etc/init.d/rpcd restart
'@
#endregion

switch ($Action) {
    'Cleanup' {
        Invoke-Remote $cleanup
        Invoke-Remote 'ls -d /www/flab /tmp/flab /usr/share/ucode/flab /usr/share/rpcd/acl.d/flab* /usr/share/rpcd/ucode/flab* 2>&1; true'
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
        # rpcd only reads its plugins and ACL fragments at start.
        Invoke-Remote '/etc/init.d/rpcd restart'

        $hostName = $Router.Split('@')[-1]
        Write-Host "Deployed. Open https://$hostName/flab/ and sign in as root."
    }
}
