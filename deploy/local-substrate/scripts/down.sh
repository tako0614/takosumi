#!/usr/bin/env bash
# Tear down both substrate and ingress. Pass -v to also remove volumes.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SUBSTRATE_DIR"
source "$SCRIPT_DIR/compose-helpers.sh"

local_substrate_runner_preparation >/dev/null || exit 1

compose_substrate --profile postgres --profile workers down "$@" 2>/dev/null || true
compose_ingress down "$@"
