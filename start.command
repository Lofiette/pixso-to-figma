#!/bin/sh
# macOS: double-click this, then press the button in the plugin window in Figma.
# Leave this window open until the migration says it is done.
#
# If double-clicking does nothing, the file has lost its executable bit — in Terminal:
#   chmod +x start.command
cd "$(dirname "$0")/tools" || exit 1

# A GUI-launched Terminal does not always inherit the PATH a package manager set up, and "node:
# command not found" tells the designer nothing about what to do. Look where Node usually is.
if ! command -v node >/dev/null 2>&1; then
  for p in /usr/local/bin /opt/homebrew/bin "$HOME/.nvm/versions/node"/*/bin; do
    [ -x "$p/node" ] && PATH="$p:$PATH" && export PATH && break
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed, or not on the PATH this window sees."
  echo "Install it from https://nodejs.org (the LTS build), then double-click this file again."
  exit 1
fi

node run.mjs "$@"
echo
echo "This window can be closed."
