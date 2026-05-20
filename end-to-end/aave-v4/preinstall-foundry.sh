#!/usr/bin/env bash
set -euo pipefail

FOUNDRY_VERSION="nightly-5e88010a83d1b87b8f4d13058e42a2949d3e9dc0"

export PATH="$HOME/.foundry/bin:$PATH"

if ! command -v foundryup >/dev/null 2>&1; then
  curl -L https://foundry.paradigm.xyz | bash
fi

foundryup --install "$FOUNDRY_VERSION"
