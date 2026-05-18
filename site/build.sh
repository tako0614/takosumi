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

# Publish the JSON-LD kind catalog under /contexts/. The shape is
# spec/contexts/v1.jsonld + spec/contexts/kinds/v1/<name>.jsonld and
# the wire URLs are https://takosumi.com/contexts/v1.jsonld and
# https://takosumi.com/contexts/kinds/v1/<name>.jsonld.
REPO_ROOT="$(cd "${SITE_DIR}/.." && pwd)"
SPEC_CONTEXTS="${REPO_ROOT}/spec/contexts"
if [ -d "${SPEC_CONTEXTS}" ]; then
  mkdir -p "${DIST}/contexts"
  cp -R "${SPEC_CONTEXTS}/." "${DIST}/contexts/"
fi

echo "[takosumi/site] built ${DIST}/"
