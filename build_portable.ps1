param(
  [string]$ComfyInstall = 'Z:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI',
  [string]$PythonEnvironment = 'Z:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\.venv',
  [string]$SharedModels = 'Z:\Comfy-Desktop\ComfyUI-Shared\models',
  [switch]$SkipModels
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$destination = $root

function Ensure-Directory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
}

foreach ($dir in @('ComfyUI', 'python', 'models', 'input', 'output', 'user', 'logs', 'workflows')) {
  Ensure-Directory (Join-Path $destination $dir)
}
Ensure-Directory (Join-Path $destination 'user\default')

if (-not (Test-Path -LiteralPath (Join-Path $ComfyInstall 'main.py'))) {
  throw "ComfyUI source directory is invalid: $ComfyInstall"
}
if (-not (Test-Path -LiteralPath (Join-Path $PythonEnvironment 'Scripts\python.exe')) -and -not (Test-Path -LiteralPath (Join-Path $PythonEnvironment 'python.exe'))) {
  throw "Portable Python was not found: $PythonEnvironment"
}

Write-Host 'Copying ComfyUI files...'
$comfyExcludedDirs = @(
  (Join-Path $ComfyInstall 'models'),
  (Join-Path $ComfyInstall '.git'),
  (Join-Path $ComfyInstall '.venv'),
  (Join-Path $ComfyInstall 'input'),
  (Join-Path $ComfyInstall 'output'),
  (Join-Path $ComfyInstall 'temp'),
  (Join-Path $ComfyInstall 'user')
)
& robocopy $ComfyInstall (Join-Path $destination 'ComfyUI') /E /XD $comfyExcludedDirs /XF '*.pyc' '*.pyo' | Out-Null
if ($LASTEXITCODE -gt 7) { throw "ComfyUI copy failed, robocopy code=$LASTEXITCODE" }

Write-Host 'Copying portable Python...'
& robocopy $PythonEnvironment (Join-Path $destination 'python') /E /XD __pycache__ /XF '*.pyc' '*.pyo' | Out-Null
if ($LASTEXITCODE -gt 7) { throw "Python copy failed, robocopy code=$LASTEXITCODE" }
# The copied venv config points back to the source computer. The package contains
# a complete base Python runtime, so remove the config to keep it relocatable.
$venvConfig = Join-Path $destination 'python\pyvenv.cfg'
if (Test-Path -LiteralPath $venvConfig) { Remove-Item -LiteralPath $venvConfig -Force }

if (-not $SkipModels) {
  $modelMap = @(
    @{ Name='minimax_h3_fl2va_pruned_int8_convrot.safetensors'; Source=(Join-Path $ComfyInstall 'models\diffusion_models'); Target='models\diffusion_models' },
    @{ Name='minimax_h3_ref2va_pruned_int8_convrot.safetensors'; Source=(Join-Path $ComfyInstall 'models\diffusion_models'); Target='models\diffusion_models' },
    @{ Name='qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'; Source=(Join-Path $ComfyInstall 'models\text_encoders'); Target='models\text_encoders' },
    @{ Name='minimax_h3_video_vae_fp16.safetensors'; Source=(Join-Path $ComfyInstall 'models\vae'); Target='models\vae' },
    @{ Name='minimax_h3_audio_vae_fp32.safetensors'; Source=(Join-Path $ComfyInstall 'models\vae'); Target='models\vae' },
    @{ Name='minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'; Source=(Join-Path $SharedModels 'loras'); Target='models\loras' },
    @{ Name='minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'; Source=(Join-Path $SharedModels 'loras'); Target='models\loras' }
  )
  foreach ($item in $modelMap) {
    $sourceFile = Join-Path $item.Source $item.Name
    if (-not (Test-Path -LiteralPath $sourceFile)) { throw "Model was not found: $sourceFile" }
    $targetDir = Join-Path $destination $item.Target
    Ensure-Directory $targetDir
    Write-Host ("Copying model {0} ({1:N2} GB)..." -f $item.Name, ((Get-Item -LiteralPath $sourceFile).Length / 1GB))
    & robocopy $item.Source $targetDir $item.Name /COPY:DAT /R:2 /W:2 | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Model copy failed, robocopy code=$LASTEXITCODE" }
  }
}

$sourceWorkflows = Join-Path $root 'workflows'
Ensure-Directory $sourceWorkflows
Write-Host 'Portable package is ready. Run the launcher CMD file.'
