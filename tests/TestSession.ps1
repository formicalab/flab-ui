#Requires -Version 7.0
<#
.SYNOPSIS
Helpers for the browser tests: a temporary rpcd session that needs no password and holds what root holds.

.DESCRIPTION
The UI signs in with the router's root login. rpcd gives root read and write '*', which means every ACL group
installed on the router, so what root may call is exactly what the ACL fragments (rpcd/acl.d) grant. The browser
tests must not need root's password, so they create a session on the router over ssh and grant it the same
things as those fragments, no more: a fragment that is missing or wrong makes a test fail here just as it makes
a page fail for root. The session id and the ACLs go to the browser, which stores them as a real sign-in does.
The session lives in rpcd's memory and is destroyed when the test ends. Dot-source this file from a run.ps1.
#>

function New-TestSession {
    <#
    .SYNOPSIS
    Creates a temporary rpcd session holding the permissions of the repository's ACL fragments.
    .DESCRIPTION
    Returns an object with Sid (the session id) and Acls (the ACLs as JSON, in the shape rpcd returns at sign-in:
    { ubus: { object: [methods] }, uci: { config: [read, write] } }).
    .PARAMETER Router
    SSH destination of the router.
    #>
    param([Parameter(Mandatory)][string]$Router)

    # Merge every group of every fragment, read and write alike.
    $ubus = @{}
    $uci = @{}
    foreach ($file in Get-ChildItem (Join-Path $PSScriptRoot '..\rpcd\acl.d') -Filter *.json) {
        $groups = Get-Content $file.FullName -Raw | ConvertFrom-Json -AsHashtable
        foreach ($group in $groups.Values) {
            foreach ($mode in 'read', 'write') {
                $section = $group[$mode]
                if (-not $section) { continue }
                foreach ($object in @($section['ubus']?.Keys).Where({ $_ })) {
                    if (-not $ubus.ContainsKey($object)) { $ubus[$object] = [System.Collections.Generic.HashSet[string]]::new() }
                    foreach ($method in $section['ubus'][$object]) { [void]$ubus[$object].Add($method) }
                }
                foreach ($config in @($section['uci'])) {
                    if (-not $config) { continue }
                    if (-not $uci.ContainsKey($config)) { $uci[$config] = [System.Collections.Generic.HashSet[string]]::new() }
                    [void]$uci[$config].Add($mode)
                }
            }
        }
    }

    $sid = (ssh $Router "ubus call session create '{`"timeout`":1800}' | jsonfilter -e '@.ubus_rpc_session'").Trim()
    if ($LASTEXITCODE -ne 0 -or $sid -notmatch '^[0-9a-f]{32}$') { throw 'Could not create a test session on the router.' }

    # rpcd takes the grants as [object, function] pairs for the ubus scope and [config, access] for the uci scope.
    $ubusPairs = [System.Collections.Generic.List[object]]::new()
    foreach ($object in $ubus.Keys) { foreach ($method in $ubus[$object]) { $ubusPairs.Add([object[]]@($object, $method)) } }
    $uciPairs = [System.Collections.Generic.List[object]]::new()
    foreach ($config in $uci.Keys) { foreach ($mode in $uci[$config]) { $uciPairs.Add([object[]]@($config, $mode)) } }
    foreach ($grant in @(@('ubus', $ubusPairs), @('uci', $uciPairs))) {
        $json = [ordered]@{ ubus_rpc_session = $sid; scope = $grant[0]; objects = $grant[1] } | ConvertTo-Json -Compress -Depth 5
        $json | ssh $Router 'ubus call session grant "$(cat)"' | Out-Null
        if ($LASTEXITCODE -ne 0) {
            # The caller never receives the session id, so nobody else could destroy it.
            Remove-TestSession -Router $Router -Sid $sid
            throw "Could not grant the $($grant[0]) scope to the test session."
        }
    }

    $acls = [ordered]@{
        ubus = [ordered]@{}
        uci  = [ordered]@{}
    }
    foreach ($object in ($ubus.Keys | Sort-Object)) { $acls.ubus[$object] = @($ubus[$object] | Sort-Object) }
    foreach ($config in ($uci.Keys | Sort-Object)) { $acls.uci[$config] = @($uci[$config] | Sort-Object) }
    [pscustomobject]@{ Sid = $sid; Acls = ($acls | ConvertTo-Json -Compress -Depth 5) }
}

function Remove-TestSession {
    <#
    .SYNOPSIS
    Destroys a session made by New-TestSession; never throws.
    .PARAMETER Router
    SSH destination of the router.
    .PARAMETER Sid
    The session id.
    #>
    param([Parameter(Mandatory)][string]$Router, [string]$Sid)

    if ($Sid) { ssh $Router "ubus call session destroy '{`"ubus_rpc_session`":`"$Sid`"}'" 2>$null | Out-Null }
}
