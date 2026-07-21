#!/usr/bin/env bash

local_substrate_profile() {
	local profile="${TAKOSUMI_LOCAL_SUBSTRATE_PROFILE:-workers}"
	case "$profile" in
		postgres|workers)
			printf '%s\n' "$profile"
			;;
		*)
			echo "TAKOSUMI_LOCAL_SUBSTRATE_PROFILE must be postgres or workers (got: $profile)" >&2
			return 1
			;;
	esac
}

# Dev fixture account session bearer for the running stack. scripts/up.sh
# generates it per bring-up and writes it to caddy/runtime/dev-session-id; there
# is deliberately no built-in literal, because a fixed bearer checked into the
# repo would hand the dev stack's OpenTofu runner to anyone who can reach it.
local_substrate_dev_session_id() {
	if [[ -n "${TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID:-}" ]]; then
		printf '%s\n' "$TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID"
		return 0
	fi
	local helpers_dir substrate_dir session_file
	helpers_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	substrate_dir="$(cd "$helpers_dir/.." && pwd)"
	session_file="$substrate_dir/caddy/runtime/dev-session-id"
	if [[ -s "$session_file" ]]; then
		tr -d '\n' <"$session_file"
		printf '\n'
		return 0
	fi
	echo "no dev fixture session: run scripts/up.sh (it generates one) or export TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID" >&2
	return 1
}

local_substrate_disable_apparmor() {
	[[ "${TAKOSUMI_LOCAL_SUBSTRATE_DISABLE_APPARMOR:-0}" == "1" ]]
}

compose_ingress() {
	local args=(-f compose.ingress.yml)
	if local_substrate_disable_apparmor; then
		args+=(-f compose.ingress.apparmor-unconfined.yml)
	fi
	docker compose "${args[@]}" "$@"
}

compose_substrate() {
	local args=(-f compose.substrate.yml)
	if local_substrate_disable_apparmor; then
		args+=(-f compose.substrate.apparmor-unconfined.yml)
	fi
	docker compose "${args[@]}" "$@"
}

compose_ingress_with_project_directory() {
	local project_dir=$1
	shift
	local args=(--project-directory "$project_dir" -f "$project_dir/compose.ingress.yml")
	if local_substrate_disable_apparmor; then
		args+=(-f "$project_dir/compose.ingress.apparmor-unconfined.yml")
	fi
	docker compose "${args[@]}" "$@"
}

local_substrate_docker_run() {
	local args=(run)
	if local_substrate_disable_apparmor; then
		args+=(--security-opt apparmor=unconfined)
	fi
	docker "${args[@]}" "$@"
}

local_substrate_timeout_docker_run() {
	local duration=$1
	shift
	local args=(run)
	if local_substrate_disable_apparmor; then
		args+=(--security-opt apparmor=unconfined)
	fi
	timeout "$duration" docker "${args[@]}" "$@"
}
