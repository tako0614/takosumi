#!/usr/bin/env bash
# takosumi-git smoke — verify the canonical installer's package contract.
#
# Why a smoke here when cli-smoke.sh already deploys via curl: takosumi-git
# is the canonical Git URL installer that real users run as
# `takosumi-git push`. It builds the manifest envelope from
# `.takosumi/manifest.yml`, strips the private `workflowRef` extension, and
# POSTs to the kernel's POST /v1/deployments. If the deploy-client's
# envelope shape ever drifts from what the kernel accepts, this catches it
# at smoke time rather than at production install time.
#
# Approach: run takosumi-git's own workspace `deno test --allow-all`
# inside the takosumi-git submodule. The test suite covers:
#   - deploy-client manifest envelope construction + parse round-trip
#   - workflow-runner artifact resolution
#   - workflow-contract schema validation
#   - git-source webhook normalization
#   - cli install / push / upgrade / rollback unit paths
#
# Network-bound deploy verification is already covered by cli-smoke.sh
# (POST a known manifest via curl). This smoke is the per-package
# contract test that catches drift before a real user hits a 4xx/5xx
# on `takosumi-git push`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ECOSYSTEM="$(cd "$SUBSTRATE_DIR/../../.." && pwd)"
TAKOSUMI_GIT_DIR="$ECOSYSTEM/takosumi-git"

if [[ ! -d "$TAKOSUMI_GIT_DIR" ]]; then
	echo "FAIL: takosumi-git not checked out at $TAKOSUMI_GIT_DIR" >&2
	exit 1
fi

if ! command -v deno >/dev/null 2>&1; then
	echo "FAIL: deno not installed on host (required to run takosumi-git tests)" >&2
	exit 1
fi

cd "$TAKOSUMI_GIT_DIR"

# Use a scratch DENO_DIR so we don't pollute the user's cache, and pin
# stdout so the smoke output line stays under the run_script tail truncate.
SCRATCH_DENO_DIR=$(mktemp -d)
trap 'rm -rf "$SCRATCH_DENO_DIR"' EXIT

LOG=$(mktemp)
# NO_COLOR strips Deno's ANSI escape codes so the summary grep + smoke
# output line stay readable in CI logs.
if NO_COLOR=1 DENO_DIR="$SCRATCH_DENO_DIR" deno task test >"$LOG" 2>&1; then
	# Extract the final "ok | <n> passed | <m> failed" summary line so the
	# smoke output is informative without dumping the full per-test log.
	SUMMARY=$(grep -E "^(ok|FAILED) \| " "$LOG" | tail -1)
	echo "OK takosumi-git workspace tests pass; ${SUMMARY:-(summary unavailable)}"
	rm -f "$LOG"
	exit 0
fi

echo "FAIL: takosumi-git workspace tests failed" >&2
echo "      Last 30 lines of log:" >&2
tail -n 30 "$LOG" | sed 's/^/        /' >&2
rm -f "$LOG"
exit 1
