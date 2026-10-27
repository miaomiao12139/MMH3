#!/usr/bin/env bash
set -euo pipefail
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *) echo 'H3 currently requires Windows x64. Run the PowerShell installer on your H3 PC.' >&2; exit 1 ;;
esac
installer=$(mktemp --suffix=.ps1)
trap 'rm -f "$installer"' EXIT
curl --fail --location --silent --show-error https://raw.githubusercontent.com/miaomiao12139/MMH3/2248c5e62d49a09c8ed4292f13b8f2d6a32aff46/cli/install.ps1 -o "$installer"
env -u PSModulePath powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$installer")" "$@"
