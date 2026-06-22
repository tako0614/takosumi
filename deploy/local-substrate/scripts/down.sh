#!/usr/bin/env bash
# Tear down both substrate and ingress. Pass -v to also remove volumes.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SUBSTRATE_DIR"
source "$SCRIPT_DIR/compose-helpers.sh"

compose_substrate --profile postgres --profile workers down "$@" 2>/dev/null || true
compose_ingress down "$@"
