param(
  [string] $Profile = 'Default',
  [string] $Url = ''
)

. (Join-Path $PSScriptRoot 'chromium-env.ps1')
$exe = $ChromiumExe
$dataDir = $ChromiumDataDir
$cdp = Join-Path $PSScriptRoot 'chromium-cdp.mjs'
$launcher = Join-Path $PSScriptRoot 'chromium-launch.ps1'
$base = "http://127.0.0.1:$CdpPort"

function Read-LocalState {
  $state = Join-Path $dataDir 'Local State'
  if (-not (Test-Path $state)) { return $null }
  for ($i = 0; $i -lt 10; $i++) {
    try {
      $fs = [IO.File]::Open($state, 'Open', 'Read', 'ReadWrite, Delete')
      try { return ([IO.StreamReader]::new($fs).ReadToEnd() | ConvertFrom-Json) } finally { $fs.Dispose() }
    } catch { Start-Sleep -Milliseconds 300 }
  }
  throw "cannot read '$state'"
}

function Resolve-ProfileDir([string] $p) {
  $ls = Read-LocalState
  if (-not $ls) { if ($p -eq 'Default') { return 'Default' } else { throw "no 'Local State' in $dataDir yet; start Chromium once with the Default profile" } }
  $cache = $ls.profile.info_cache
  foreach ($e in $cache.PSObject.Properties) {
    if ($e.Name -eq $p -or $e.Value.user_name -eq $p -or ($e.Value.user_name -split '@')[0] -eq $p) { return $e.Name }
  }
  throw "unknown profile '$p' (use a folder name like Default / 'Profile 1', an email, or the part before @)"
}

function Get-Account([string] $dir) {
  $ls = Read-LocalState
  if (-not $ls) { return $null }
  $ls.profile.info_cache.$dir.user_name
}

function Wait-Port([int] $sec = 60) {
  $end = (Get-Date).AddSeconds($sec)
  while ((Get-Date) -lt $end) {
    try { Invoke-RestMethod "$base/json/version" -TimeoutSec 2 | Out-Null; return $true } catch { Start-Sleep -Milliseconds 500 }
  }
  return $false
}

function Probe { node $cdp probe | ConvertFrom-Json }

function Out-Result($o) { $o | ConvertTo-Json -Compress -Depth 4; exit 0 }

$dir = Resolve-ProfileDir $Profile
$account = Get-Account $dir

if (-not (Get-ChromiumMain)) {
  $restarted = $true
  & $launcher "--profile-directory=$dir" $(if ($Url) { $Url }) | Out-Null
  if (-not (Wait-Port 120)) { Out-Result @{ ok = $false; reason = "Chromium did not open the debug port within 120 s" } }
}
elseif (-not (Wait-Port 30)) { Out-Result @{ ok = $false; reason = "Chromium is running but port $CdpPort does not answer" } }

$p = Probe
if ($p.error) { Out-Result @{ ok = $false; reason = "probe failed: $($p.error)" } }

if ($p.profileDir -ne $dir) {
  $busy = @($p.pages | Where-Object { -not $_.idle })
  if ($busy.Count -eq 0) {
    node $cdp close | Out-Null
    $end = (Get-Date).AddSeconds(20)
    while ((Get-ChromiumMain) -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 500 }
    Get-ChromiumMain | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    & $launcher "--profile-directory=$dir" $(if ($Url) { $Url }) | Out-Null
    if (-not (Wait-Port 60)) { Out-Result @{ ok = $false; reason = "restart: port $CdpPort did not come back" } }
    $p = Probe
    $restarted = $true
  }
}

if ($Url -and -not $restarted) {
  $o = node $cdp open $dir $Url | ConvertFrom-Json
  if ($o.opened) {
    Out-Result @{
      ok = $true; mode = 'tab'; profile = $dir; account = $account; targetId = $o.targetId; url = $Url
      note = "Opened a tab in '$dir' (targetId above, owned by this chat). Next: list_pages, then select_page the page with this URL and pass that pageId on every call. Do not use new_page: it opens in whichever profile was used last, which another chat can change at any moment."
    }
  }
}

if ($p.profileDir -eq $dir) {
  $msg = if ($restarted) { 'wrong profile and idle -> restarted on the right one' } else { 'already on the right profile' }
  $how = if ($Url) { "the $Url tab is open: list_pages, then select_page it" } else { 'pass -Url to open your page in this profile (new_page can land in another profile)' }
  Out-Result @{ ok = $true; mode = 'mcp'; profile = $dir; account = $account; note = "$msg; $how" }
}

if ($Url) { Start-Process $exe -ArgumentList "--user-data-dir=`"$dataDir`"", "--profile-directory=`"$dir`"", $Url }
else { Start-Process $exe -ArgumentList "--user-data-dir=`"$dataDir`"", "--profile-directory=`"$dir`"" }
Out-Result @{
  ok = $true; mode = 'window'; profile = $dir; account = $account; newPageProfile = $p.profileDir
  note = "new_page would open in '$($p.profileDir)' and other pages are open, so Chromium was not restarted. A '$dir' window was opened$(if ($Url) { " on $Url" }). Do NOT use new_page for this profile: wait ~2 s, list_pages, select_page the tab with that URL. To open more pages in '$dir', run this script again with -Url."
}
