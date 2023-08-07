#!/bin/bash
set -euo pipefail

rust_version=$(<rust-toolchain)

# rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain $rust_version

sudo apt update

# nodejs
# libudev-dev is required by hardhat-ledger
# pkg-config is required by EDR to use OpenSSL
sudo apt install -y nodejs libudev-dev pkg-config
