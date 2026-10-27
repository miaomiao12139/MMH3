param(
  [string]$AppRoot,
  [string]$InstallDir = "$env:LOCALAPPDATA\H3CLI",
  [string]$Version = 'v1.1.16',
  [switch]$SkipSkill
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$localBundle = $PSScriptRoot -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'h3.py'))
$bundle = $PSScriptRoot
if (-not $localBundle) {
  $tempDir = Join-Path ([IO.Path]::GetTempPath()) ('h3-cli-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
  $base = "https://github.com/miaomiao12139/MMH3/releases/download/$Version"
  $zip = Join-Path $tempDir 'H3-CLI-1.1.16.zip'
  Invoke-WebRequest "$base/H3-CLI-1.1.16.zip" -OutFile $zip -UseBasicParsing
  $checksFile = Join-Path $tempDir 'SHA256SUMS.txt'
  Invoke-WebRequest "$base/SHA256SUMS-1.1.16.txt" -OutFile $checksFile -UseBasicParsing
  $checks = Get-Content -LiteralPath $checksFile -Raw -Encoding UTF8
  $line = @($checks -split "`n" | Where-Object { $_ -match '^([0-9a-fA-F]{64})\s+H3-CLI-1\.1\.16\.zip\s*$' })
  if ($line.Count -ne 1) { throw 'Missing or ambiguous release checksum' }
  $expected = ($line[0] -split '\s+')[0]
  if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $expected) { throw 'CLI archive checksum mismatch' }
  Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tempDir 'bundle')
  $bundle = Join-Path $tempDir 'bundle'
}
if (-not $AppRoot -and $env:H3_APP_ROOT) { $AppRoot = $env:H3_APP_ROOT }
if (-not $AppRoot -and (Test-Path -LiteralPath "$env:LOCALAPPDATA\H3CLI\config.json")) {
  $AppRoot = (Get-Content -LiteralPath "$env:LOCALAPPDATA\H3CLI\config.json" -Raw | ConvertFrom-Json).appRoot
}
if (-not $AppRoot -and (Test-Path -LiteralPath 'Z:\MiniMax-H3-Studio\App\python\python.exe')) { $AppRoot = 'Z:\MiniMax-H3-Studio\App' }
if ($AppRoot) { $AppRoot = (Resolve-Path -LiteralPath $AppRoot).Path }
$pythonExe = if ($AppRoot -and (Test-Path -LiteralPath (Join-Path $AppRoot 'python\python.exe'))) { Join-Path $AppRoot 'python\python.exe' } else { (Get-Command python.exe -ErrorAction SilentlyContinue).Source }
if (-not $pythonExe) { throw 'Python 3 is required. Re-run with -AppRoot pointing to your H3 App folder.' }
& $pythonExe -c 'import sys; assert sys.version_info >= (3, 9), "Python 3.9+ required"'
if ($LASTEXITCODE -ne 0) { throw 'Python runtime check failed' }
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$InstallDir = (Resolve-Path -LiteralPath $InstallDir).Path
if ([IO.Path]::GetFullPath($bundle) -ne $InstallDir) {
  Copy-Item -LiteralPath (Join-Path $bundle 'h3.py') -Destination $InstallDir -Force
  Copy-Item -LiteralPath (Join-Path $bundle 'skills') -Destination $InstallDir -Recurse -Force
}
if ($pythonExe.Contains('%') -or $InstallDir.Contains('%')) { throw 'Paths containing % are unsupported by the CMD launcher' }
$launcher = "@echo off`r`nsetlocal`r`nset PYTHONUTF8=1`r`n`"$pythonExe`" `"$InstallDir\h3.py`" %*`r`nexit /b %errorlevel%`r`n"
[IO.File]::WriteAllText((Join-Path $InstallDir 'h3.cmd'), $launcher, [Text.Encoding]::Default)
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }
if (-not (($userPath -split ';') | Where-Object { $_.TrimEnd('\') -ieq $InstallDir.TrimEnd('\') })) {
  [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $InstallDir).TrimStart(';')), 'User')
}
if (-not (($env:Path -split ';') -contains $InstallDir)) { $env:Path += ";$InstallDir" }
if (-not $SkipSkill) {
  & $pythonExe (Join-Path $InstallDir 'h3.py') skill install
  if ($LASTEXITCODE -ne 0) { throw 'Skill installation failed' }
}
if ($AppRoot) {
  & $pythonExe (Join-Path $InstallDir 'h3.py') auth login --app-root $AppRoot
  if ($LASTEXITCODE -ne 0) { Write-Warning 'CLI installed. Start H3 1.1.16+ and run h3 auth login --app-root YOUR_APP_FOLDER' }
} else {
  Write-Host 'CLI installed. Start H3 1.1.16+ and run: h3 auth login --app-root YOUR_APP_FOLDER'
}
Write-Host "Installed: $InstallDir\h3.cmd"
Write-Host 'Verify: h3 doctor (open a new terminal if needed). Models are provided by your existing H3 installation.'
