# MiniMax H3 Studio

MiniMax H3 Studio is an Electron desktop interface for local ComfyUI video workflows.

## Scope

This repository contains the application source, bundled workflow definitions, and build scripts. It intentionally does not contain model weights, the portable Python runtime, ComfyUI's runtime tree, generated videos, or user queue/history data.

## Requirements

- Windows x64
- Node.js 20 or newer
- A local ComfyUI installation with the MiniMax H3 custom nodes and models
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

The desktop app checks the GitHub Releases page for `miaomiao12139/MMH3`. A release should include an asset named exactly `MiniMax H3 Studio.exe`; model files are never replaced during an app update.
