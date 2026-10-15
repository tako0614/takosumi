#!/bin/sh
set -eu
exec /usr/local/bin/bun --no-env-file /app/runner/hosted-metered-entrypoint.ts
