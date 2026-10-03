#!/usr/bin/env sh
set -eu

export PORT="${PORT:-8080}"
export TAKOSUMI_RUNNER_START_SERVER=1

if [ "${1-}" = "--local-preparation-v2-supervisor" ] && [ "$#" -eq 1 ]; then
  exec /usr/local/bin/bun /app/runner/entrypoint.ts --local-preparation-v2-supervisor
fi

if [ "$#" -ne 0 ]; then
  printf '%s\n' 'runner startup refused' >&2
  exit 64
fi

exec /usr/local/bin/bun /app/runner/entrypoint.ts
