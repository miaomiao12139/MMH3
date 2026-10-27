param(
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$Download,
  [Parameter(Mandatory=$true)][string]$ExpectedHash,
  [int]$WaitPid = 0,
  [switch]$NoRestart
)
$ErrorActionPreference = 'Stop'
$targetPath = [IO.Path]::GetFullPath($Target)
$downloadPath = [IO.Path]::GetFullPath($Download)
$updateDirectory = Join-Path ([IO.Path]::GetDirectoryName($targetPath)) '.updates'
$backupPath = Join-Path $updateDirectory 'MiniMax H3 Studio.exe.previous'
$resultPath = Join-Path $updateDirectory 'result.json'
$movedOriginal = $false
try {
  if ([IO.Path]::GetExtension($targetPath) -ne '.exe' -or
      [IO.Path]::GetDirectoryName($downloadPath) -ne $updateDirectory -or
      $downloadPath -eq $targetPath) { throw 'Invalid update paths' }
  $hasher = [Security.Cryptography.SHA256]::Create()
  $downloadStream = [IO.File]::OpenRead($downloadPath)
  try { $actualHash = [BitConverter]::ToString($hasher.ComputeHash($downloadStream)).Replace('-', '') }
  finally { $downloadStream.Dispose(); $hasher.Dispose() }
  if ($actualHash -ne $ExpectedHash) { throw 'Update checksum mismatch' }
  if ($WaitPid -gt 0) {
    $appProcess = Get-Process -Id $WaitPid -ErrorAction SilentlyContinue
    if ($appProcess -and -not $appProcess.WaitForExit(60000)) { throw 'Application did not exit; update cancelled' }
  }
  # The portable launcher may keep the exe locked briefly after Electron exits.
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
      if (Test-Path -LiteralPath $targetPath) {
        if (Test-Path -LiteralPath $backupPath) { Remove-Item -LiteralPath $backupPath -Force }
        Move-Item -LiteralPath $targetPath -Destination $backupPath
        $movedOriginal = $true
      }
      break
    } catch { if ($attempt -eq 59) { throw }; Start-Sleep -Milliseconds 500 }
  }
  try { Move-Item -LiteralPath $downloadPath -Destination $targetPath }
  catch {
    if ($movedOriginal -and -not (Test-Path -LiteralPath $targetPath)) {
      Move-Item -LiteralPath $backupPath -Destination $targetPath
      $movedOriginal = $false
    }
    throw
  }
  @{ ok=$true; updatedAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
  if (-not $NoRestart) { Start-Process -FilePath $targetPath -WorkingDirectory ([IO.Path]::GetDirectoryName($targetPath)) -WindowStyle Hidden }
  if ($movedOriginal -and (Test-Path -LiteralPath $backupPath)) { Remove-Item -LiteralPath $backupPath -Force }
  exit 0
} catch {
  if (Test-Path -LiteralPath $updateDirectory) {
    @{ ok=$false; error=$_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
  }
  if (-not $NoRestart -and (Test-Path -LiteralPath $targetPath)) {
    Start-Process -FilePath $targetPath -WorkingDirectory ([IO.Path]::GetDirectoryName($targetPath)) -WindowStyle Hidden
  }
  exit 1
}
