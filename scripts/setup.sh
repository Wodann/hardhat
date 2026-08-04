#!/bin/bash
set -euo pipefail

sudo apt update

# libudev-dev is required by hardhat-ledger
sudo apt install -y libudev-dev

# Used for performance measurement. GNU time (the `time` package) is required by
# bench:regression to capture CPU time and peak RSS; it aborts without it.
sudo apt install -y hyperfine time

# Make sure bun is available at the cli
npm install -g bun
