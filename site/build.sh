#!/usr/bin/env bash
# Build the takosumi.com landing site into ./dist/.
#
# This is intentionally trivial: copy index.html (and any static
# assets you add later) into dist/. The wrangler.toml points
# pages_build_output_dir at ./dist. Replace this with a real static
# site generator (Astro, 11ty, etc.) later without changing the
# wrangler / deno-task surface.

set -euo pipefail

SITE_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST="${SITE_DIR}/dist"

rm -rf "${DIST}"
mkdir -p "${DIST}"

cp "${SITE_DIR}/index.html" "${DIST}/index.html"

# Optional static assets (favicons, og images, etc.) — copy whatever
# lives under site/static/ if it exists.
if [ -d "${SITE_DIR}/static" ]; then
  cp -R "${SITE_DIR}/static/." "${DIST}/"
fi

echo "[takosumi/site] built ${DIST}/"
