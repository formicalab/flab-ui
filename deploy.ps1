#Requires -Version 7.0
<#
.SYNOPSIS
Deploys or removes the flab-ui dashboard on the GL-MT6000.

.DESCRIPTION
Deploy copies www/ to the router's tmpfs (/tmp/flab), links it at /www/flab, installs every
rpcd ACL (rpcd/acl.d), rpcd plugin (rpcd/ucode) and shared ucode module (rpcd/lib), and adds a
temporary rpcd login 'flab'. Cleanup reverses every change. The only flash writes are the rpcd
files, the rpcd login and the symlink; Cleanup removes all of them.

.PARAMETER Action
Deploy or Cleanup.

.PARAMETER Router
SSH destination of the router.

.PARAMETER Password
Password for the temporary 'flab' login. A random one is generated when omitted.

.PARAMETER Admin
Also creates the optional 'flab-admin' login, which holds the flab-admin ACL (rpcd/acl.d/flab-admin.json)
on top of the read-only access of 'flab'. That ACL lists no writable config yet, so this login still
cannot change anything; it prepares the configuration-change features. Without this switch, and after
Cleanup, no admin login exists.

.PARAMETER AdminPassword
Password for the 'flab-admin' login. A random one is generated when omitted.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Deploy', 'Cleanup')][string]$Action,
    [string]$Router = 'root@openwrt.lab.formicalab.casa',
    [string]$Password = ([guid]::NewGuid().ToString('N').Substring(0, 16)),
    [switch]$Admin,
    [string]$AdminPassword = ([guid]::NewGuid().ToString('N').Substring(0, 16))
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
    Normalizes line endings to LF (BusyBox sh rejects CRLF), optionally feeds one line to stdin,
    and throws on a nonzero exit code.
    .PARAMETER Script
    Shell script text.
    .PARAMETER StdIn
    Optional single line passed to the script's stdin.
    #>
    param([Parameter(Mandatory)][string]$Script, [string]$StdIn)

    $lf = $Script -replace "`r`n", "`n"
    if ($PSBoundParameters.ContainsKey('StdIn')) { $StdIn | ssh $Router $lf } else { ssh $Router $lf }
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
uci -q delete rpcd.flab_ui || true
uci -q delete rpcd.flab_admin_ui || true
uci commit rpcd
/etc/init.d/rpcd restart
'@
#endregion

switch ($Action) {
    'Cleanup' {
        Invoke-Remote $cleanup
        Invoke-Remote 'ls -d /www/flab /tmp/flab /usr/share/ucode/flab /usr/share/rpcd/acl.d/flab* /usr/share/rpcd/ucode/flab* 2>&1; uci -q show rpcd.flab_ui; true'
        Write-Host 'Router cleaned.'
    }
    'Deploy' {
        Invoke-Remote $cleanup
        Invoke-Remote 'mkdir -p /tmp/flab /usr/share/ucode/flab'

        $www = Join-Path $root 'www'
        $rpcd = Join-Path $root 'rpcd'
        Copy-ToRouter -Recurse -Path @(Get-ChildItem $www | ForEach-Object FullName) -Destination '/tmp/flab/'
        Copy-ToRouter -Path @(Get-ChildItem (Join-Path $rpcd 'acl.d') -File | ForEach-Object FullName) -Destination '/usr/share/rpcd/acl.d/'
        Copy-ToRouter -Path @(Get-ChildItem (Join-Path $rpcd 'ucode') -File | ForEach-Object FullName) -Destination '/usr/share/rpcd/ucode/'
        Copy-ToRouter -Path @(Get-ChildItem (Join-Path $rpcd 'lib\flab') -File | ForEach-Object FullName) -Destination '/usr/share/ucode/flab/'

        # The password arrives on stdin so it never appears in a process list; only its hash is stored.
        $install = @'
set -e
read -r pw
pw=$(printf %s "$pw" | tr -d '\r')
hash=$(printf %s "$pw" | openssl passwd -6 -stdin)
ln -s /tmp/flab /www/flab
uci set rpcd.flab_ui=login
uci set rpcd.flab_ui.username=flab
uci set rpcd.flab_ui.password="$hash"
uci add_list rpcd.flab_ui.read=flab
uci commit rpcd
/etc/init.d/rpcd restart
'@
        Invoke-Remote $install -StdIn $Password

        # The optional admin login: it reads like 'flab' and also holds the flab-admin ACL. Same stdin handling.
        if ($Admin) {
            $installAdmin = @'
set -e
read -r pw
pw=$(printf %s "$pw" | tr -d '\r')
hash=$(printf %s "$pw" | openssl passwd -6 -stdin)
uci set rpcd.flab_admin_ui=login
uci set rpcd.flab_admin_ui.username=flab-admin
uci set rpcd.flab_admin_ui.password="$hash"
uci add_list rpcd.flab_admin_ui.read=flab
uci add_list rpcd.flab_admin_ui.read=flab-admin
uci add_list rpcd.flab_admin_ui.write=flab-admin
uci commit rpcd
/etc/init.d/rpcd restart
'@
            Invoke-Remote $installAdmin -StdIn $AdminPassword
        }

        $hostName = $Router.Split('@')[-1]
        Write-Host "Deployed. Open https://$hostName/flab/"
        Write-Host "  user: flab"
        Write-Host "  password: $Password"
        if ($Admin) {
            Write-Host "  admin user: flab-admin (no writable config yet)"
            Write-Host "  admin password: $AdminPassword"
        }
    }
}
