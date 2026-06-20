#!/usr/bin/env sh
set -eu

export PORT="${PORT:-8080}"
export TAKOSUMI_RUNNER_START_SERVER=1

exec /usr/local/bin/bun /app/runner/entrypoint.ts
