#Requires -Version 7.0
<#
.SYNOPSIS
Checks the least-privilege model of the deployed UI: what the read-only 'flab' login and the optional
'flab-admin' login can and cannot do.

.DESCRIPTION
Talks to rpcd the way the browser does (JSON-RPC over HTTPS to /ubus) and only ever calls methods whose
effect would be harmless if the ACL wrongly allowed them (a nonexistent config, a file under /tmp, /bin/true).
1. As 'flab': the plugin and system calls the pages use work; everything that could change or run
   something (uci writes, file read/write/exec, service control, rc init, session grants) is denied.
2. A wrong password and an unknown user cannot sign in, and there is no 'flab-admin' login by default.
3. With -IncludeAdmin it redeploys with the admin login and checks it signs in, reads, and still cannot
   change any config because the flab-admin ACL lists none; then redeploys without -Admin and checks the
   admin login is gone again.

Needs the UI deployed (deploy.ps1 -Action Deploy). -IncludeAdmin redeploys it twice; it ends deployed
without the admin login, with the password given in -Password.

.PARAMETER Router
SSH destination of the router (used only by -IncludeAdmin, to redeploy).

.PARAMETER Url
Base URL of the router, without a path.

.PARAMETER Password
Password of the 'flab' login.

.PARAMETER IncludeAdmin
Also test the optional admin login (redeploys the UI with and without -Admin).
#>
[CmdletBinding()]
param(
    [string]$Router = 'root@openwrt.lab.formicalab.casa',
    [string]$Url = 'https://openwrt.lab.formicalab.casa',
    [string]$Password = 'flab',
    [switch]$IncludeAdmin
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$deploy = Join-Path $PSScriptRoot '..\..\deploy.ps1'
$anonymous = '0' * 32
$failed = 0

#region Helpers
function Invoke-Ubus {
    <#
    .SYNOPSIS
    Makes one ubus call over JSON-RPC and returns the parsed reply.
    .DESCRIPTION
    The reply has either a 'result' (status code and data) or an 'error' (code -32002 means access denied).
    .PARAMETER Token
    Session id; the anonymous session when omitted.
    .PARAMETER Object
    ubus object name.
    .PARAMETER Method
    Method of the object.
    .PARAMETER Arguments
    Arguments of the call as a hashtable.
    #>
    param(
        [string]$Token = $anonymous,
        [Parameter(Mandatory)][string]$Object,
        [Parameter(Mandatory)][string]$Method,
        [hashtable]$Arguments = @{}
    )

    $body = @{ jsonrpc = '2.0'; id = 1; method = 'call'; params = @($Token, $Object, $Method, $Arguments) } | ConvertTo-Json -Depth 6 -Compress
    Invoke-RestMethod -Uri "$Url/ubus" -Method Post -Body $body -ContentType 'application/json' -SkipCertificateCheck
}

function Get-Session {
    <#
    .SYNOPSIS
    Signs in and returns the session reply, or $null when the sign-in is refused.
    .PARAMETER UserName
    rpcd login name.
    .PARAMETER Secret
    Password.
    #>
    param([Parameter(Mandatory)][string]$UserName, [Parameter(Mandatory)][string]$Secret)

    $reply = Invoke-Ubus -Object 'session' -Method 'login' -Arguments @{ username = $UserName; password = $Secret; timeout = 60 }
    if ($reply.PSObject.Properties.Name -contains 'result' -and $reply.result[0] -eq 0) { return $reply.result[1] }
    return $null
}

function Test-Check {
    <#
    .SYNOPSIS
    Prints PASS or FAIL for one condition and counts failures.
    .PARAMETER Condition
    What must be true.
    .PARAMETER Message
    What the check shows.
    #>
    param([bool]$Condition, [Parameter(Mandatory)][string]$Message)

    Write-Host ("{0}  {1}" -f ($Condition ? 'PASS' : 'FAIL'), $Message)
    if (-not $Condition) { $script:failed++ }
}

function Test-Denied {
    <#
    .SYNOPSIS
    Whether a reply is an access denial.
    .DESCRIPTION
    A method the ACL does not list is refused by uhttpd with JSON-RPC error -32002. A method the login may call
    but on a config or path it may not use is refused by rpcd itself, which answers with ubus status 6
    (permission denied) as the call's result.
    .PARAMETER Reply
    The reply of Invoke-Ubus.
    #>
    param($Reply)

    $names = $Reply.PSObject.Properties.Name
    ($names -contains 'error' -and $Reply.error.code -eq -32002) -or ($names -contains 'result' -and $Reply.result[0] -eq 6)
}

function Test-Allowed {
    <#
    .SYNOPSIS
    Whether a reply is a successful call (status code 0).
    .PARAMETER Reply
    The reply of Invoke-Ubus.
    #>
    param($Reply)

    $Reply.PSObject.Properties.Name -contains 'result' -and $Reply.result[0] -eq 0
}
#endregion

#region Read-only login
Write-Host '== the read-only login (flab) =='
$ro = Get-Session -UserName 'flab' -Secret $Password
Test-Check ($null -ne $ro) 'the flab login signs in'
$token = $ro.ubus_rpc_session

# What the pages use must work.
foreach ($call in @(
        @('system', 'board'), @('system', 'info'), @('network.interface', 'dump'), @('service', 'list'),
        @('flab.network', 'status'), @('flab.firewall', 'status'), @('flab.wireguard', 'status'), @('flab.logs', 'read'))) {
    $callArgs = if ($call[1] -eq 'read') { @{ lines = 5 } } else { @{} }
    Test-Check (Test-Allowed (Invoke-Ubus -Token $token -Object $call[0] -Method $call[1] -Arguments $callArgs)) "allowed: $($call[0]) $($call[1])"
}

# Everything that could change or run something must be denied. Each call is harmless if it were allowed.
$harmless = @(
    @('uci', 'configs', @{}), @('uci', 'get', @{ config = 'flabtest' }),
    @('uci', 'set', @{ config = 'flabtest'; section = 'x'; values = @{ a = 'b' } }),
    @('uci', 'add', @{ config = 'flabtest'; type = 'x' }), @('uci', 'delete', @{ config = 'flabtest'; section = 'x' }),
    @('uci', 'revert', @{ config = 'flabtest' }),
    @('file', 'read', @{ path = '/etc/passwd' }), @('file', 'write', @{ path = '/tmp/flab-security-test'; data = 'x' }),
    @('file', 'exec', @{ command = '/bin/true' }), @('file', 'list', @{ path = '/etc' }),
    @('service', 'signal', @{ name = 'flab-no-such-service'; signal = 0 }), @('service', 'delete', @{ name = 'flab-no-such-service' }),
    @('rc', 'init', @{ name = 'flab-no-such-service'; action = 'status' }),
    @('network.interface', 'down', @{ interface = 'flab-no-such-interface' }),
    @('session', 'list', @{}),
    @('log', 'write', @{ event = 'flab security test' })
)
foreach ($call in $harmless) {
    Test-Check (Test-Denied (Invoke-Ubus -Token $token -Object $call[0] -Method $call[1] -Arguments $call[2])) "denied: $($call[0]) $($call[1])"
}
Test-Check ($null -eq (Get-Session -UserName 'flab' -Secret 'wrong-password')) 'a wrong password does not sign in'
#endregion

#region No admin login by default
Write-Host '== no admin login unless deployed with -Admin =='
Test-Check ($null -eq (Get-Session -UserName 'flab-admin' -Secret $Password)) 'flab-admin does not sign in when it has not been created'
Test-Check ($null -eq (Get-Session -UserName 'nobody' -Secret $Password)) 'an unknown user does not sign in'
#endregion

#region Admin login
if ($IncludeAdmin) {
    Write-Host '== the optional admin login (flab-admin) =='
    $adminSecret = [guid]::NewGuid().ToString('N').Substring(0, 16)
    & $deploy -Action Deploy -Router $Router -Password $Password -Admin -AdminPassword $adminSecret | Out-Null
    Start-Sleep -Seconds 3

    $admin = Get-Session -UserName 'flab-admin' -Secret $adminSecret
    Test-Check ($null -ne $admin) 'flab-admin signs in after deploying with -Admin'
    $adminToken = $admin.ubus_rpc_session
    Test-Check (Test-Allowed (Invoke-Ubus -Token $adminToken -Object 'flab.network' -Method 'status')) 'it reads everything the flab login reads'
    $uciMethods = @($admin.acls.ubus.uci)
    Test-Check (($uciMethods -contains 'set') -and ($uciMethods -contains 'apply') -and ($uciMethods -contains 'confirm')) 'its ACLs include the uci staging, apply and confirm methods'
    Test-Check (Test-Denied (Invoke-Ubus -Token $adminToken -Object 'uci' -Method 'set' -Arguments @{ config = 'network'; section = 'flabtest'; values = @{ a = 'b' } })) 'a uci set on a real config is denied: nothing is writable until a page opts a config in'
    Test-Check (Test-Denied (Invoke-Ubus -Token $adminToken -Object 'uci' -Method 'get' -Arguments @{ config = 'network'; section = 'lan' })) 'and a uci get is denied too: no config is readable through uci yet either'
    $staged = Invoke-Ubus -Token $adminToken -Object 'uci' -Method 'changes'
    Test-Check ((Test-Allowed $staged) -and @($staged.result[1].changes.PSObject.Properties).Count -eq 0) 'nothing was staged by the attempts above'
    Test-Check (Test-Denied (Invoke-Ubus -Token $adminToken -Object 'file' -Method 'exec' -Arguments @{ command = '/bin/true' })) 'and it still cannot run commands'
    Test-Check (Test-Denied (Invoke-Ubus -Token $token -Object 'uci' -Method 'configs')) 'the read-only login still cannot touch uci'

    & $deploy -Action Deploy -Router $Router -Password $Password | Out-Null
    Start-Sleep -Seconds 3
    Test-Check ($null -eq (Get-Session -UserName 'flab-admin' -Secret $adminSecret)) 'redeploying without -Admin removes the admin login again'
    Test-Check ($null -ne (Get-Session -UserName 'flab' -Secret $Password)) 'the read-only login keeps working'
}
#endregion

if ($failed) { Write-Host "`n$failed check(s) FAILED"; exit 1 }
Write-Host "`nall security checks passed"
