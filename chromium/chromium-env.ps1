$script:CdpPort = if ($env:TAB_GUARD_CDP_PORT) { [int]$env:TAB_GUARD_CDP_PORT } else { 9222 }
$script:ChromiumExe = if ($env:CHROMIUM_EXE) { $env:CHROMIUM_EXE } else { Join-Path $env:LOCALAPPDATA 'Chromium\Application\chrome.exe' }
$claudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$script:ChromiumDataDir = if ($env:CHROMIUM_USER_DATA_DIR) { $env:CHROMIUM_USER_DATA_DIR } else { Join-Path $claudeDir 'chromium-data' }

function Get-ChromiumMain {
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($script:ChromiumDataDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -notmatch '--type=' }
}
