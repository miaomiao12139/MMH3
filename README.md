# MiniMax H3 Studio

## CLI + Skill（1.1.16）

Windows PowerShell 一键安装（安装 CLI 与 Codex Skill，不重复下载模型）：

```powershell
irm https://raw.githubusercontent.com/miaomiao12139/MMH3/8a135aa/cli/install.ps1 | iex
```

Windows Git Bash：

```bash
curl -fsSL https://raw.githubusercontent.com/miaomiao12139/MMH3/8a135aa/cli/install.sh | bash
```

需要已安装 H3 1.1.16+ 并打开桌面程序。自定义位置可下载 install.ps1 后运行 `powershell -File .\install.ps1 -AppRoot "D:\H3\App"`。安装包按发布版本下载并校验 SHA256；仅安装 Python 标准库客户端和 Skill，不下载数十 GB 的模型。H3 引擎目前支持 Windows x64。

```powershell
h3 auth login --app-root "Z:\MiniMax-H3-Studio\App"
h3 doctor
h3 capabilities
h3 task voice --input @voice.json --wait
h3 jobs list
h3 outputs
h3 skill install --target claude
```

voice.json 内容为 `{"text":"你好，欢迎使用 H3","engine":"kokoro","voice":"zf_001","speed":1}`。其他软件可解析 stdout JSON 和退出码。`auth login` 验证本机连接，无需云账号；连接凭据每次启动自动刷新，不需用户复制 token。新终端可直接使用 h3；当前终端若未刷新 PATH 可运行 `%LOCALAPPDATA%\H3CLI\h3.cmd`。

开放视频六种生成工作流、图片/视频增强、补帧、自动/点选/框选/画笔分割、图像理解、Kokoro/Melo 语音、批量抠图，以及队列、工作流配置、偏好与输出历史管理。任务与桌面使用相同服务和 GPU 忙碌检查。`h3 task` 接受去重键；等待超时不会自动重新生成。删除和清空需 `--confirm`。

详细参数与调用例子见 [CLI Skill](cli/skills/h3-studio/SKILL.md) 和 [接口参数](cli/skills/h3-studio/references/api.md)。`h3 openapi` 获取当前运行版本的 OpenAPI；`h3 api` 可直接调用本机 HTTP 接口。接口监听 127.0.0.1 并校验 Bearer token，未开放公网。

MiniMax H3 Studio is an Electron desktop interface for local ComfyUI video workflows.

## Scope

This repository contains the application source, bundled workflow definitions, and build scripts. It intentionally does not contain model weights, the portable Python runtime, ComfyUI's runtime tree, generated videos, or user queue/history data.

## Requirements

- Windows x64
- Node.js 20 or newer
- A local ComfyUI installation with the MiniMax H3 nodes and models
- NVIDIA CUDA runtime suitable for the installed models

## Development

```powershell
npm install
npm test
npm run build
```

To create a Windows portable build:

```powershell
npm run dist
```

The portable executable is named `MiniMax H3 Studio.exe`. The application expects a sibling portable runtime layout containing `ComfyUI`, `python`, `models`, `workflows`, `input`, `output`, and `user` directories. Use the portable package's `build_portable.ps1` to assemble that layout from an existing ComfyUI installation without committing it to this repository.

## Updates

The desktop app checks the GitHub Releases page for `miaomiao12139/MMH3`. A
release should include the portable exe asset (`MiniMax H3 Studio.exe`, which
GitHub may display as `MiniMax.H3.Studio.exe`); model files are never replaced
during an app update.

Version 1.0.4 stores settings and drafts in `App/user/studio-preferences.json`,
imports existing local settings on first launch, and relocates managed media
paths when the portable folder is moved. Keep the whole `App` directory when
copying to another computer. External source images must have been imported
beforehand to have a portable copy.

The updater waits for the app to exit, checks the downloaded file, and restores
the original executable if replacement fails. Pending generation tasks must be
completed or cancelled before updating. Runtime dependency pins are recorded in
`runtime-requirements.txt`; they do not change the bundled CUDA/PyTorch version.

`npm test` includes isolated cancellation, migration, asset cleanup and Windows
updater rollback checks. Browser interaction checks can be run with
`node test/cutout-browser.mjs <path-to-playwright> [sample.png]`.

## Local speech synthesis (1.1.9)

The native Speech Synthesis page defaults to Kokoro-82M-v1.1-zh with 100 Chinese and 3 English voices. It also retains MeloTTS Chinese as an alternative. Model and voice selection, mixed Chinese/English text, speed control, WAV playback/export, cancellation and history all work locally. History stores the model and voice, and older MeloTTS records remain playable. Kokoro outputs 24 kHz WAV; MeloTTS outputs 44.1 kHz. The Clear All action confirms before deleting all generated WAV files and their sidecars, including records beyond the latest 100 shown on screen. It is unavailable during generation and preserves metadata for audio files that could not be deleted. Files exported elsewhere are unaffected.

Portable runtime layout:

- `App/models/tts/MeloTTS-Chinese/`: checkpoint, configuration and BERT assets.
- `App/models/tts/Kokoro-82M-v1.1-zh/`: official checkpoint, configuration, all 103 voice packs and upstream documentation. The checkpoint SHA-256 is `b1d8410fa44dfb5c15471fd6c4225ea6b4e9ac7fa03c98e8bea47a9928476e2b`.
- `App/voice/python/`: isolated Python 3.12 with both TTS engines, Misaki, spaCy's offline English pronunciation model and bundled eSpeak, separate from ComfyUI Python. Exact dependencies are recorded in `App/voice/requirements-lock.txt`.
- `App/voice/MeloTTS/` and `App/voice/nltk_data/`: inference code and offline pronunciation resources.
- `App/output/tts/`: WAV outputs and portable JSON metadata sidecars.
- `App/logs/voice.log`: inference diagnostics.

The packaged executable includes `voice.cjs` and `runtime/voice-worker.py`. Models and the Python runtime remain outside the executable and source repository. Copy the complete `App` folder to move the software. Voice generation and H3 jobs run sequentially; each voice worker exits when finished or cancelled to release GPU memory. Cached video models are unloaded before speech synthesis.

Run `npm test` for application and voice service regressions. Real synthesis requires the portable voice runtime and models.

## Interactive cutout (1.1.12)

The AI Tools cutout page supports MobileSAM positive/negative clicks and object boxes, followed by exact keep/erase brush corrections. Undo, clear, brush size, transparent result preview and repeated edits are available. Exported PNGs preserve the original image dimensions. Automatic InSPyReNet background removal remains available as a separate tool mode.

The local checkpoint is `App/models/sams/mobile_sam.pt` (SHA-256 `6dbb90523a35330fedd7f1d3dfc66f995213d81b29a5ca8108dbcdd4e37d6c2f`). The bundled custom node is copied into ComfyUI at engine startup. Install models and the pinned MobileSAM package with `tools/install-ai-tool-models.ps1`; inference makes no network requests. Run `test/interactive-segment.py` using the App Python for real two-object, click, box, brush and RGBA checks.
