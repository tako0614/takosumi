#!/usr/bin/env bash
# Build the hosted Takosumi Cloud docs and embed them under the platform app
# static asset root so app.takosumi.com/docs serves them.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DOCS_DIR="${REPO_ROOT}/docs"
APP_DOCS_DIR="${REPO_ROOT}/app-docs"
APP_DOCS_DIST="${APP_DOCS_DIR}/.vitepress/dist"
DASHBOARD_DOCS_DIST="${REPO_ROOT}/dashboard/dist/docs"
VITEPRESS_BIN="${DOCS_DIR}/node_modules/.bin/vitepress"

install_docs_node_modules() {
  cd "${DOCS_DIR}"
  if command -v npm >/dev/null 2>&1; then
    npm --loglevel=error ci --no-fund --no-audit
    return
  fi
  if command -v bun >/dev/null 2>&1; then
    if [ -f bun.lock ] || [ -f bun.lockb ]; then
      bun install --frozen-lockfile
    else
      bun install
    fi
    return
  fi
  echo "[takosumi/app-docs] FATAL: npm or bun is required to install vitepress" >&2
  exit 1
}

if [ ! -x "${VITEPRESS_BIN}" ]; then
  echo "[takosumi/app-docs] install docs dependencies for vitepress"
  install_docs_node_modules
fi

echo "[takosumi/app-docs] build hosted Cloud docs"
cd "${APP_DOCS_DIR}"
VITEPRESS_BASE="${VITEPRESS_BASE:-/docs/}" "${VITEPRESS_BIN}" build

if [ ! -d "${APP_DOCS_DIST}" ]; then
  echo "[takosumi/app-docs] FATAL: ${APP_DOCS_DIST} not produced by vitepress build" >&2
  exit 1
fi

echo "[takosumi/app-docs] overlay dashboard/dist/docs"
rm -rf "${DASHBOARD_DOCS_DIST}"
mkdir -p "${DASHBOARD_DOCS_DIST}"
cp -R "${APP_DOCS_DIST}/." "${DASHBOARD_DOCS_DIST}/"

echo "[takosumi/app-docs] built ${DASHBOARD_DOCS_DIST}"
