#!/usr/bin/env bash
# Self-extracting installer for Project Zomboid Control (server side).
# Usage: sudo bash pz-control-server-installer.sh [options]   (see --help)
set -euo pipefail
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
SKIP=$(awk '/^__ARCHIVE_BELOW__$/ { print NR + 1; exit 0 }' "$0")
tail -n +"$SKIP" "$0" | tar -xzf - -C "$TMP"
bash "$TMP/pz-control/installer/setup.sh" "$@"
exit $?
__ARCHIVE_BELOW__
