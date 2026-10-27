$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$AppRoot = 'Z:\MiniMax-H3-Studio\App'
$ModelsRoot = Join-Path $AppRoot 'models'
New-Item -ItemType Directory -Force -Path (Join-Path $ModelsRoot 'upscale_models'), (Join-Path $ModelsRoot 'frame_interpolation'), (Join-Path $ModelsRoot 'text_encoders') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ModelsRoot 'sams') | Out-Null
function Download-Model([string]$Url, [string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    if ((Get-Item -LiteralPath $Path).Length -gt 1MB) { return }
    Remove-Item -LiteralPath $Path -Force
  }
  $Temp = "$Path.download"
  Write-Host "Downloading $([IO.Path]::GetFileName($Path))"
  curl.exe -L --fail --retry 3 --retry-delay 2 -o $Temp $Url
  if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $Temp) -or (Get-Item -LiteralPath $Temp).Length -lt 1MB) { Remove-Item -LiteralPath $Temp -Force -ErrorAction SilentlyContinue; throw "Download failed: $Url" }
  Move-Item -LiteralPath $Temp -Destination $Path -Force
}
Download-Model 'https://huggingface.co/Comfy-Org/Real-ESRGAN_repackaged/resolve/main/RealESRGAN_x4plus.safetensors' (Join-Path $ModelsRoot 'upscale_models\RealESRGAN_x4plus.safetensors')
Download-Model 'https://huggingface.co/Comfy-Org/frame_interpolation/resolve/main/frame_interpolation/film_net_fp16.safetensors' (Join-Path $ModelsRoot 'frame_interpolation\film_net_fp16.safetensors')
Download-Model 'https://modelscope.cn/models/Comfy-Org/Qwen3-VL/resolve/master/text_encoders/qwen3vl_4b_fp8_scaled.safetensors' (Join-Path $ModelsRoot 'text_encoders\qwen3vl_4b_fp8_scaled.safetensors')
Download-Model 'https://huggingface.co/dhkim2810/MobileSAM/resolve/main/mobile_sam.pt' (Join-Path $ModelsRoot 'sams\mobile_sam.pt')
& (Join-Path $AppRoot 'python\python.exe') -m pip install --no-deps 'https://github.com/ChaoningZhang/MobileSAM/archive/f706ad9c4eb7f219c00d9050e46328518ffb65d2.zip'
if ($LASTEXITCODE -ne 0) { throw 'MobileSAM runtime installation failed.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\src\h3_interactive_segment.py') -Destination (Join-Path $AppRoot 'ComfyUI\custom_nodes\h3_interactive_segment.py') -Force
Write-Host 'AI tool models and interactive segmentation installed.'
