# Shell library — source from a scenario's preinstall script.
#
# Usage:
#   . "$E2E_TEST_DIR/../_shared/foundry-install.sh"
#   install_foundry vX.Y.Z
#
# Each scenario that sources this file must also prepend $HOME/.foundry/bin
# to PATH via its scenario.json `env` block so that `forge` is discoverable
# by hyperfine benchmark commands (the preinstall script's process exits
# before those commands run).

install_foundry() {
  local version="$1"

  if ! command -v foundryup >/dev/null 2>&1; then
    curl -L https://foundry.paradigm.xyz | bash
  fi

  foundryup --install "$version"
}
