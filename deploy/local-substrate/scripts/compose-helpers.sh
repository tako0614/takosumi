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
