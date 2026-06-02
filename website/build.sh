#!/usr/bin/env bash
# Build the takosumi.com landing into ./.output/public/ and overlay
# both the VitePress docs site and the JSON-LD context catalog onto
# the same Pages artifact.
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
#   4. Copies package-owned kind descriptor JSON-LD documents from
#      takosumi portable catalog sources onto `.output/public/kinds/v1/`
#      so canonical kind URIs resolve.
#
# The merged `.output/public/` is the `pages_build_output_dir` declared
# in `wrangler.toml`. The legacy `takosumi/site/` minimal HTML landing
# and the legacy `takosumi-docs` standalone Pages project are both
# superseded by this single artifact (= Wave M-G architectural goal,
# operator-side dashboard cleanup documented in `takosumi/DEPLOY.md`).

set -euo pipefail

WEBSITE_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${WEBSITE_DIR}/.." && pwd)"

OUTPUT_PUBLIC="${WEBSITE_DIR}/.output/public"
DOCS_DIR="${REPO_ROOT}/docs"
DOCS_DIST="${DOCS_DIR}/.vitepress/dist"
SPEC_CONTEXTS="${REPO_ROOT}/spec/contexts"
# Kind descriptors are published spec, not framework or implementation source. The single
# official catalog is flat JSON-LD under docs/kinds/v1/<name>.jsonld — both base
# kinds (worker, postgres, …) and the descriptors that extend them via
# portableBase (cloudflare-worker, aws-rds-postgres, …). Implementations are pure
# implementations that consume these descriptors; they hold no descriptor source.
KIND_CATALOG="${REPO_ROOT}/docs/kinds/v1"

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

# 4. Kind descriptor overlay — docs/kinds/v1/*.jsonld is the single
#    official descriptor catalog source. Publish both `<name>.jsonld` and
#    extensionless `<name>` so `https://takosumi.com/kinds/v1/<name>` resolves
#    as the stable kind URI while clients that prefer explicit JSON-LD can fetch
#    `.jsonld`. Strip local codegen-only `x-ts*` annotations from the public
#    catalog payload.
# Emit `descriptor_path<TAB>kind_name` for every descriptor in the single
# official catalog (flat `docs/kinds/v1/<name>.jsonld`).
list_descriptors() {
  if [ -d "${KIND_CATALOG}" ]; then
    find "${KIND_CATALOG}" -maxdepth 1 -name '*.jsonld' -type f | while read -r f; do
      printf '%s\t%s\n' "${f}" "$(basename "${f}" .jsonld)"
    done
  fi
}

descriptor_count="$(list_descriptors | wc -l | tr -d ' ')"
if [ "${descriptor_count}" != "0" ]; then
  echo "[takosumi/website] overlay /kinds/v1/ from published kind descriptors"
  rm -rf "${OUTPUT_PUBLIC}/kinds"
  mkdir -p "${OUTPUT_PUBLIC}/kinds/v1"
  list_descriptors | sort | while IFS="$(printf '\t')" read -r descriptor name; do
    node -e '
const fs = require("node:fs");
const [src, dst] = process.argv.slice(1);
function stripTooling(value) {
  if (Array.isArray(value)) return value.map(stripTooling);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "x-ts" || key === "x-ts-name" || key === "x-ts-type") continue;
      out[key] = stripTooling(child);
    }
    return out;
  }
  return value;
}
fs.writeFileSync(
  dst,
  JSON.stringify(stripTooling(JSON.parse(fs.readFileSync(src, "utf8"))), null, 2) + "\n",
);
' "${descriptor}" "${OUTPUT_PUBLIC}/kinds/v1/${name}.jsonld"
    cp "${OUTPUT_PUBLIC}/kinds/v1/${name}.jsonld" "${OUTPUT_PUBLIC}/kinds/v1/${name}"
  done
fi

# Optional static assets — copy whatever lives under website/static/
# if it exists (favicons, og images, etc. that the Solid build does
# not already emit).
if [ -d "${WEBSITE_DIR}/static" ]; then
  cp -R "${WEBSITE_DIR}/static/." "${OUTPUT_PUBLIC}/"
fi

echo "[takosumi/website] built ${OUTPUT_PUBLIC}/ (landing + /docs/ + /contexts/)"
