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

local_substrate_runner_preparation() {
	local preparation="${TAKOSUMI_LOCAL_SUBSTRATE_RUNNER_PREPARATION:-v1}"
	case "$preparation" in
		v1|v2)
			printf '%s\n' "$preparation"
			;;
		*)
			echo "TAKOSUMI_LOCAL_SUBSTRATE_RUNNER_PREPARATION must be v1 or v2 (got: $preparation)" >&2
			return 1
			;;
	esac
}

local_substrate_validate_runner_preparation_profiles() {
	local preparation="$1"
	shift
	[[ "$preparation" == "v2" ]] || return 0

	local action=""
	local profile=""
	local expect_profile=0
	local profiles=()
	for argument in "$@"; do
		if ((expect_profile)); then
			profiles+=("$argument")
			expect_profile=0
			continue
		fi
		case "$argument" in
			--profile)
			expect_profile=1
			;;
			--profile=*)
			profiles+=("${argument#--profile=}")
			;;
			up|down|ps|run|start|stop|restart|logs|exec|config|images|pull|build|create|rm|kill|top|events|port|stats|version|wait|cp|attach|export|convert|watch)
			[[ -n "$action" ]] || action="$argument"
			;;
		esac
	done

	if [[ "$action" == "down" ]]; then
		# down.sh deliberately supplies both profiles so it can remove either
		# service set with the same Compose model used to start it.
		for profile in "${profiles[@]}"; do
			case "$profile" in
				postgres|workers) ;;
				*)
					echo "runner preparation v2 down supports only postgres/workers profiles (got: $profile)" >&2
					return 1
					;;
			esac
		done
		return 0
	fi

	if [[ "${TAKOSUMI_LOCAL_SUBSTRATE_PROFILE:-}" != "postgres" ]]; then
		echo "runner preparation v2 requires TAKOSUMI_LOCAL_SUBSTRATE_PROFILE=postgres" >&2
		return 1
	fi
	if ((expect_profile)) || ((${#profiles[@]} != 1)) || [[ "${profiles[0]:-}" != "postgres" ]]; then
		echo "runner preparation v2 requires exactly --profile postgres" >&2
		return 1
	fi
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
	local preparation
	preparation="$(local_substrate_runner_preparation)" || return 1
	local_substrate_validate_runner_preparation_profiles "$preparation" "$@" || return 1
	if [[ "$preparation" == "v2" ]]; then
		args+=(-f compose.runner-preparation-v2.yml)
	fi
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
