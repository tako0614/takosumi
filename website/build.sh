#!/usr/bin/env bash
# Build the takosumi.com landing into ./.output/public/ and overlay the
# VitePress docs site onto the same Pages artifact.
#
# Cloudflare Pages serves the landing and docs from one Pages artifact. This
# script:
#
#   1. Builds the Solid Start landing (`vinxi build`) → `.output/public/`
#   2. Builds the VitePress docs (`takosumi/docs/`) → `.vitepress/dist/`
#      and copies it onto `.output/public/docs/`
# The merged `.output/public/` is the `pages_build_output_dir` declared
# in `wrangler.toml`.

set -euo pipefail

WEBSITE_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${WEBSITE_DIR}/.." && pwd)"

OUTPUT_PUBLIC="${WEBSITE_DIR}/.output/public"
DOCS_DIR="${REPO_ROOT}/docs"
DOCS_DIST="${DOCS_DIR}/.vitepress/dist"

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

echo "[takosumi/website] built ${OUTPUT_PUBLIC}/ (landing + /docs/)"
