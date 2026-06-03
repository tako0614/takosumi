#!/usr/bin/env bash
# Build the takosumi.com landing into ./.output/public/ and overlay the
# VitePress docs site and JSON-LD contexts onto the same Pages artifact.
#
# Wave M-G (= ecosystem 2026-05-20、 architectural restructure):
# Cloudflare Pages allows 1 project per custom domain. To serve
# `takosumi.com/`, `takosumi.com/docs/*`, and `takosumi.com/contexts/*`
# from a single Pages deploy (= the user-stated production shape),
# this script:
#
#   1. Builds the Solid Start landing (`vinxi build`) → `.output/public/`
#   2. Builds the VitePress docs (`takosumi/docs/`) → `.vitepress/dist/`
#      and copies it onto `.output/public/docs/`
#   3. Copies the JSON-LD context catalog (`takosumi/spec/contexts/`)
#      onto `.output/public/contexts/`
#
# The merged `.output/public/` is the `pages_build_output_dir` declared
# in `wrangler.toml`. The retired `takosumi/site/` minimal HTML landing
# and the retired `takosumi-docs` standalone Pages project are both
# superseded by this single artifact (= Wave M-G architectural goal,
# operator-side dashboard cleanup documented in `takosumi/DEPLOY.md`).

set -euo pipefail

WEBSITE_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${WEBSITE_DIR}/.." && pwd)"

OUTPUT_PUBLIC="${WEBSITE_DIR}/.output/public"
DOCS_DIR="${REPO_ROOT}/docs"
DOCS_DIST="${DOCS_DIR}/.vitepress/dist"
SPEC_CONTEXTS="${REPO_ROOT}/spec/contexts"

# 1. Landing build (Solid Start, static prerender).
echo "[takosumi/website] build landing (vinxi build)"
cd "${WEBSITE_DIR}"
if [ ! -d node_modules ]; then
  npm install --no-fund --no-audit
fi
npm run build

if [ ! -d "${OUTPUT_PUBLIC}" ]; then
  echo "[takosumi/website] FATAL: ${OUTPUT_PUBLIC} not produced by vinxi build" >&2
  exit 1
fi

# 2. Docs overlay — vitepress builds to docs/.vitepress/dist/ with
#    base = "/docs/" (see docs/.vitepress/config.ts). The output is
#    copied onto .output/public/docs/.
echo "[takosumi/website] build docs (vitepress build) + overlay /docs/"
cd "${DOCS_DIR}"
if [ ! -d node_modules ]; then
  npm install --no-fund --no-audit
fi
npx vitepress build

if [ ! -d "${DOCS_DIST}" ]; then
  echo "[takosumi/website] FATAL: ${DOCS_DIST} not produced by vitepress build" >&2
  exit 1
fi

rm -rf "${OUTPUT_PUBLIC}/docs"
mkdir -p "${OUTPUT_PUBLIC}/docs"
cp -R "${DOCS_DIST}/." "${OUTPUT_PUBLIC}/docs/"

# 3. JSON-LD context overlay — spec/contexts/v1.jsonld goes under /contexts/
#    so the wire URL `https://takosumi.com/contexts/v1.jsonld` resolves.
if [ -d "${SPEC_CONTEXTS}" ]; then
  echo "[takosumi/website] overlay /contexts/ from spec/contexts/"
  rm -rf "${OUTPUT_PUBLIC}/contexts"
  mkdir -p "${OUTPUT_PUBLIC}/contexts"
  cp -R "${SPEC_CONTEXTS}/." "${OUTPUT_PUBLIC}/contexts/"
fi

# Optional static assets — copy whatever lives under website/static/
# if it exists (favicons, og images, etc. that the Solid build does
# not already emit).
if [ -d "${WEBSITE_DIR}/static" ]; then
  cp -R "${WEBSITE_DIR}/static/." "${OUTPUT_PUBLIC}/"
fi

echo "[takosumi/website] built ${OUTPUT_PUBLIC}/ (landing + /docs/ + /contexts/)"
