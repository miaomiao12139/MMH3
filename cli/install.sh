#!/usr/bin/env bash
set -euo pipefail
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *) echo 'H3 currently requires Windows x64. Run the PowerShell installer on your H3 PC.' >&2; exit 1 ;;
esac
installer=$(mktemp --suffix=.ps1)
trap 'rm -f "$installer"' EXIT
curl --fail --location --silent --show-error https://raw.githubusercontent.com/miaomiao12139/MMH3/868adeed26eab0721b6a9f0248afde36f501cfc3/cli/install.ps1 -o "$installer"
# Use Windows PowerShell's own bundled modules even from a clean or PS7 shell.
module_root="$(cygpath -w "${WINDIR:-C:/Windows}/System32/WindowsPowerShell/v1.0/Modules")"
PSModulePath="$module_root" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$installer")" "$@"
