#!/usr/bin/env bash
set -euo pipefail

FOUNDRY_VERSION="v1.7.1"

export PATH="$HOME/.foundry/bin:$PATH"

if ! command -v foundryup >/dev/null 2>&1; then
  curl -L https://foundry.paradigm.xyz | bash
fi

foundryup --install "$FOUNDRY_VERSION"
