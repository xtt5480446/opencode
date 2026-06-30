param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [int]$McpLoops = 0,
  [int]$McpServers = 20,
  [int]$StartupSeconds = 20,
  [int]$PtySeconds = 120
)

$ErrorActionPreference = "Stop"

function Write-Section([string]$Name) {
  Write-Host ""
  Write-Host "==== $Name ===="
}

function Read-TextFile([string]$Path) {
  if (!(Test-Path $Path)) {
    return ""
  }
  return [System.IO.File]::ReadAllText($Path)
}

function Test-CrashText([string]$Text) {
  if ($Text -match "Segmentation fault") { return $true }
  if ($Text -match "Bun has crashed") { return $true }
  if ($Text -match "ACCESS_VIOLATION") { return $true }
  if ($Text -match "0xC0000005") { return $true }
  if ($Text -match "322122") { return $true }
  if ($Text -match "panic\(main thread\)") { return $true }
  return $false
}

function Invoke-Opencode {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [Parameter(Mandatory = $true)]
    [string]$Exe,
    [string[]]$Args = @(),
    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory,
    [int]$TimeoutSeconds = 60,
    [switch]$AllowNonZero,
    [switch]$AllowTimeout
  )

  Write-Section $Label
  Write-Host "cwd=$WorkingDirectory"
  Write-Host "cmd=$Exe $($Args -join ' ')"

  $safe = ($Label -replace "[^A-Za-z0-9_.-]", "_")
  $stdout = Join-Path $env:RUNNER_TEMP "$safe.out.log"
  $stderr = Join-Path $env:RUNNER_TEMP "$safe.err.log"
  Remove-Item -ErrorAction SilentlyContinue $stdout, $stderr

  $process = Start-Process -FilePath $Exe -ArgumentList $Args -WorkingDirectory $WorkingDirectory -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $exited = $process.WaitForExit($TimeoutSeconds * 1000)
  if (!$exited) {
    Write-Host "timeout after ${TimeoutSeconds}s; terminating process id $($process.Id)"
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
  }

  $outText = Read-TextFile $stdout
  $errText = Read-TextFile $stderr
  if ($outText.Length -gt 0) {
    Write-Host "--- stdout ---"
    Write-Host $outText
  }
  if ($errText.Length -gt 0) {
    Write-Host "--- stderr ---"
    Write-Host $errText
  }

  $combined = $outText + "`n" + $errText
  if (Test-CrashText $combined) {
    throw "native crash signature detected in $Label"
  }

  if (!$exited) {
    if ($AllowTimeout) {
      Write-Host "timeout accepted for long-running TUI startup check"
      return
    }
    throw "timeout in $Label"
  }

  $exitCode = [int64]$process.ExitCode
  Write-Host "exitCode=$exitCode"
  if (@(3, -1073741819, -1073740791, -1073741571) -contains $exitCode) {
    throw "native crash exit code $exitCode in $Label"
  }
  if (!$AllowNonZero -and $process.ExitCode -ne 0) {
    throw "unexpected exit code $($process.ExitCode) in $Label"
  }
}

function Invoke-PtyScenario {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Scenario,
    [Parameter(Mandatory = $true)]
    [string]$Exe,
    [Parameter(Mandatory = $true)]
    [string]$Project,
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [Parameter(Mandatory = $true)]
    [int]$Seconds
  )

  node (Join-Path $PSScriptRoot "repro-windows-opentui-pty-session.mjs") -- --exe $Exe --project $Project --version $Version --seconds $Seconds --scenario $Scenario
  if ($LASTEXITCODE -ne 0) {
    $script:PtyFailures += "PTY scenario '$Scenario' failed with exit code $LASTEXITCODE"
    Write-Host "::error::$($script:PtyFailures[-1])"
  }
}

Write-Section "Environment"
node --version
npm --version
Write-Host "RUNNER_OS=$env:RUNNER_OS RUNNER_ARCH=$env:RUNNER_ARCH"
Write-Host "PROCESSOR_ARCHITECTURE=$env:PROCESSOR_ARCHITECTURE"

Write-Section "Install opencode-ai@$Version"
npm uninstall -g opencode-ai opencode-windows-x64 2>$null | Out-Host
npm install -g "opencode-ai@$Version"
if ($LASTEXITCODE -ne 0) {
  throw "npm install opencode-ai@$Version failed with exit code $LASTEXITCODE"
}

$npmRoot = (npm root -g).Trim()
$exe = Join-Path $npmRoot "opencode-ai\bin\opencode.exe"
if (!(Test-Path $exe)) {
  $cmd = Get-Command opencode -ErrorAction Stop
  $exe = $cmd.Source
}
Write-Host "opencode executable=$exe"
if (Test-Path $exe) {
  $info = (Get-Item $exe).VersionInfo
  Write-Host "FileDescription=$($info.FileDescription) FileVersion=$($info.FileVersion) ProductVersion=$($info.ProductVersion) CompanyName=$($info.CompanyName)"
}

$root = Join-Path $env:RUNNER_TEMP "opencode-windows-opentui-$Version"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $root
New-Item -ItemType Directory -Force $root | Out-Null
$env:XDG_CONFIG_HOME = Join-Path $root "xdg-config"
$env:XDG_DATA_HOME = Join-Path $root "xdg-data"
$env:XDG_CACHE_HOME = Join-Path $root "xdg-cache"
$env:XDG_STATE_HOME = Join-Path $root "xdg-state"
$env:APPDATA = Join-Path $root "appdata"
$env:LOCALAPPDATA = Join-Path $root "localappdata"
$env:OPENCODE_DISABLE_AUTOUPDATE = "1"
$env:OPENCODE_DISABLE_EXTERNAL_SKILLS = "1"
$env:OPENCODE_DISABLE_LSP_DOWNLOAD = "1"
$env:OPENCODE_PURE = "1"
New-Item -ItemType Directory -Force $env:XDG_CONFIG_HOME, $env:XDG_DATA_HOME, $env:XDG_CACHE_HOME, $env:XDG_STATE_HOME, $env:APPDATA, $env:LOCALAPPDATA | Out-Null

$emptyProject = Join-Path $root "empty-project"
$mcpProject = Join-Path $root "mcp-project"
$sessionProject = Join-Path $root "session-project"
New-Item -ItemType Directory -Force $emptyProject, $mcpProject, $sessionProject | Out-Null

Invoke-Opencode -Label "version" -Exe $exe -Args @("--version") -WorkingDirectory $emptyProject -TimeoutSeconds 30
Invoke-Opencode -Label "help" -Exe $exe -Args @("--help") -WorkingDirectory $emptyProject -TimeoutSeconds 30

Write-Section "Write MCP spawn-storm config"
$servers = [ordered]@{}
for ($i = 1; $i -le $McpServers; $i++) {
  $name = "server$($i.ToString('00'))"
  $servers[$name] = [ordered]@{
    type = "local"
    command = @("node", "-e", "setTimeout(() => {}, 30000)")
    timeout = 350
  }
}
$config = [ordered]@{
  autoupdate = $false
  mcp = $servers
}
($config | ConvertTo-Json -Depth 10) | Set-Content -Encoding UTF8 (Join-Path $mcpProject "opencode.json")
Get-Content (Join-Path $mcpProject "opencode.json") | Write-Host

for ($i = 1; $i -le $McpLoops; $i++) {
  Invoke-Opencode -Label "mcp-list-$i" -Exe $exe -Args @("mcp", "list") -WorkingDirectory $mcpProject -TimeoutSeconds 90 -AllowNonZero
}

Invoke-Opencode -Label "empty-startup-tui" -Exe $exe -Args @() -WorkingDirectory $emptyProject -TimeoutSeconds $StartupSeconds -AllowTimeout -AllowNonZero

Write-Section "Install PTY dependency"
$ptyRoot = Join-Path $root "pty-harness"
New-Item -ItemType Directory -Force $ptyRoot | Out-Null
Push-Location $ptyRoot
try {
  npm init -y | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "npm init for PTY harness failed with exit code $LASTEXITCODE"
  }
  npm install "@lydell/node-pty@1.2.0-beta.12" | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "npm install @lydell/node-pty failed with exit code $LASTEXITCODE"
  }
  $script:PtyFailures = @()
  Invoke-PtyScenario -Scenario "text" -Exe $exe -Project $sessionProject -Version $Version -Seconds $PtySeconds
  if ($Version -eq "1.17.10") {
    Invoke-PtyScenario -Scenario "markdown-no-native-render" -Exe $exe -Project $sessionProject -Version $Version -Seconds $PtySeconds
  }
  Invoke-PtyScenario -Scenario "markdown" -Exe $exe -Project $sessionProject -Version $Version -Seconds $PtySeconds
  Invoke-PtyScenario -Scenario "bash-permission" -Exe $exe -Project $sessionProject -Version $Version -Seconds $PtySeconds
  Invoke-PtyScenario -Scenario "task-permission" -Exe $exe -Project $sessionProject -Version $Version -Seconds $PtySeconds
  Invoke-PtyScenario -Scenario "mcp-npx" -Exe $exe -Project $sessionProject -Version $Version -Seconds $PtySeconds
  if ($Version -eq "1.17.10") {
    Invoke-PtyScenario -Scenario "mcp-npx-no-native-render" -Exe $exe -Project $sessionProject -Version $Version -Seconds $PtySeconds
  }
  if ($script:PtyFailures.Count -gt 0) {
    Write-Section "PTY Failures"
    $script:PtyFailures | ForEach-Object { Write-Host $_ }
    throw "$($script:PtyFailures.Count) PTY scenario(s) failed"
  }
} finally {
  Pop-Location
}

Write-Section "Result"
Write-Host "No native crash signature detected for opencode-ai@$Version"
