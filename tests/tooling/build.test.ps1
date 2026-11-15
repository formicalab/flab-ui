#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region Fixture
. (Join-Path $PSScriptRoot '..\..\tools\package.ps1') -Action Build
$workspace = Join-Path $PSScriptRoot ('.build-work-' + [guid]::NewGuid().ToString('N'))
$work = ConvertTo-BuildPath $workspace
$repository = ConvertTo-BuildPath $root
New-Item -ItemType Directory $workspace | Out-Null
$setup = @'
set -eu
WORK='@@WORK@@'
REPOSITORY='@@REPOSITORY@@'
mkdir -p "$WORK/source/www" "$WORK/source/rpcd" "$WORK/source/tools"
printf 'current tree\n' > "$WORK/source/www/index.html"
printf 'plugin fixture\n' > "$WORK/source/rpcd/plugin.uc"
printf 'license fixture\n' > "$WORK/source/LICENSE"
cp "$REPOSITORY/tools/stage-source.sh" "$WORK/source/tools/"
mkdir -p "$WORK/sdk/package/feeds/test" "$WORK/sdk/dependency" "$WORK/feed"
printf 'CONFIG_PACKAGE_flab-ui=m\n' > "$WORK/sdk/.config"
printf 'dependency source\n' > "$WORK/sdk/dependency/CMakeLists.txt"
cat > "$WORK/sdk/dependency/Makefile" <<'MAKE'
all:
	@test -z "$(USE_SOURCE_DIR)"
	@test -z "$$USE_SOURCE_DIR"
	@test -f CMakeLists.txt
MAKE
cat > "$WORK/feed/Makefile" <<'MAKE'
all:
	@test "$$(cat "$(USE_SOURCE_DIR)/www/index.html")" = "current tree"
	@test ! -e "$(TEST_SDK)/fail"
MAKE
cp "$WORK/feed/Makefile" "$WORK/original-Makefile"
ln -s "$WORK/feed" "$WORK/sdk/package/feeds/test/flab-ui"
cat > "$WORK/sdk/Makefile" <<'MAKE'
export TEST_SDK:=$(CURDIR)
package/flab-ui/clean:
	@touch .cleaned
package/flab-ui/compile:
	@$(MAKE) --no-print-directory -C dependency
	@$(MAKE) --no-print-directory -C package/feeds/test/flab-ui
	@mkdir -p bin/packages/x86_64/test
	@printf 'current tree artifact\n' > bin/packages/x86_64/test/flab-ui-0.1.4-r1.apk
MAKE
# Keep Windows native stdin's final CRLF out of the heredoc delimiter.
'@
try {
    $null = Invoke-Bash ($setup.Replace('@@WORK@@', $work).Replace('@@REPOSITORY@@', $repository))
    # Execute the production build template unchanged, including its SDK-entry redirection and EXIT recovery.
    foreach ($fail in @($false, $true)) {
        $toggle = if ($fail) { "touch '$work/sdk/fail'" } else { "rm -f '$work/sdk/fail'" }
        $null = Invoke-Bash "set -eu`n$toggle`nrm -rf '$work/out'`n#"
        $script = $buildScript.Replace('@@SRC@@', "$work/source").Replace('@@OUT@@', "$work/out").Replace('@@SDK@@', "$work/sdk").Replace('@@FEED@@', '0')
        $caught = $false
        try { $null = Invoke-Bash $script }
        catch { $caught = $true }
        if ($caught -ne $fail) { throw "Unexpected working-tree build result (injected failure: $fail)." }
        $check = @'
set -eu
WORK='@@WORK@@'
test "$(readlink "$WORK/sdk/package/feeds/test/flab-ui")" = "$WORK/feed"
cmp "$WORK/feed/Makefile" "$WORK/original-Makefile"
test ! -e "$WORK/sdk/.flab-ui-package-original"
test ! -L "$WORK/sdk/.flab-ui-package-original"
test ! -e "$WORK/sdk/.flab-ui-package"
test "$(cat "$WORK/sdk/dependency/CMakeLists.txt")" = "dependency source"
# Keep Windows native stdin's final CRLF out of the last assertion.
'@
        $null = Invoke-Bash ($check.Replace('@@WORK@@', $work))
        if ($fail) {
            if (Test-Path (Join-Path $workspace 'out')) { throw 'Failed build returned a stale package.' }
        }
        elseif ([IO.File]::ReadAllText((Join-Path $workspace 'out\flab-ui-0.1.4-r1.apk')).Trim() -ne 'current tree artifact') {
            throw 'The output package did not come from the working source.'
        }
        Write-Host "PASS developer build: current source, isolated dependencies, unchanged feed, SDK restoration (failure=$fail)"
    }
    $null = Invoke-Bash "set -eu`nrm -f '$work/sdk/.cleaned'`nln -s '$work/feed' '$work/sdk/.flab-ui-package-original'`n#"
    $script = $buildScript.Replace('@@SRC@@', "$work/source").Replace('@@OUT@@', "$work/out").Replace('@@SDK@@', "$work/sdk").Replace('@@FEED@@', '1')
    $caught = $false
    try { $null = Invoke-Bash $script }
    catch { $caught = $true }
    if (-not $caught) { throw 'Feed-source build accepted an interrupted working-tree override.' }
    if (Test-Path (Join-Path $workspace 'sdk\.cleaned')) { throw 'Interrupted SDK entry was used before recovery.' }
    Write-Host 'PASS feed-source build refuses an interrupted working-tree SDK override before changing it'
}
finally {
    Remove-Item -LiteralPath $workspace -Recurse -Force
}
#endregion
