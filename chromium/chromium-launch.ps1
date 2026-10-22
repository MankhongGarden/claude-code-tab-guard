param([Parameter(ValueFromRemainingArguments)] [string[]] $Rest)

. (Join-Path $PSScriptRoot 'chromium-env.ps1')
$exe = $ChromiumExe
$dataDir = $ChromiumDataDir
New-Item -ItemType Directory -Force $dataDir | Out-Null
$stamp = Join-Path $dataDir '.last-update-check'

$running = Get-ChromiumMain

if ($env:CHROMIUM_WINGET_ID) {
  $due = -not (Test-Path $stamp) -or ((Get-Date) - (Get-Item $stamp).LastWriteTime).TotalHours -ge 20
  if (-not $running -and $due) {
    $before = (Get-Item $exe).VersionInfo.ProductVersion
    winget upgrade --id $env:CHROMIUM_WINGET_ID -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Null
    Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
    $after = (Get-Item $exe).VersionInfo.ProductVersion
    New-Item $stamp -ItemType File -Force | Out-Null
    "[chromium-launch] update check: $before -> $after"
  } elseif ($running -and $due) {
    "[chromium-launch] update check skipped (Chromium is running) - close it and relaunch to update"
  }
}

$quoted = $Rest | ForEach-Object {
  if ($_ -match '^(--[^=]+=)(.*\s.*)$') { "$($Matches[1])`"$($Matches[2])`"" }
  elseif ($_ -match '\s') { "`"$_`"" }
  else { $_ }
}
if (-not ($quoted | Where-Object { $_ -like '--profile-directory=*' })) { $quoted = @('--profile-directory=Default') + $quoted }
$args2 = @("--user-data-dir=`"$dataDir`"", "--remote-debugging-port=$CdpPort", '--no-default-browser-check', '--no-first-run') + $quoted
Start-Process $exe -ArgumentList ($args2 -join ' ')
