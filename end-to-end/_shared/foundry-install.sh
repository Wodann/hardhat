# Shell library — source from a scenario's preinstall script.
#
# Usage:
#   . "$E2E_TEST_DIR/../_shared/foundry-install.sh"
#   install_foundry vX.Y.Z

install_foundry() {
  local version="$1"

  export PATH="$HOME/.foundry/bin:$PATH"

  if ! command -v foundryup >/dev/null 2>&1; then
    curl -L https://foundry.paradigm.xyz | bash
  fi

  foundryup --install "$version"
}
