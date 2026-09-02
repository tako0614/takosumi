#!/usr/bin/env bash
# PKCE (RFC 7636) helpers for the local-substrate OAuth smoke scripts.
#
# The caller owns the PKCE pair: /oauth/upstream/authorize forwards the
# code_challenge upstream, and /oauth/upstream/callback requires the matching
# code_verifier before it will exchange the code. Every script that walks the
# dance mints its own pair, so no two flows can be confused for each other.
#
# Sourced, never executed.

# 64 hex characters — inside the 43..128 length window the callback enforces,
# and a strict subset of the unreserved PKCE alphabet.
mint_pkce_verifier() {
	openssl rand -hex 32
}

# base64url(SHA-256(verifier)), unpadded: the S256 challenge.
pkce_challenge() {
	printf '%s' "$1" |
		openssl dgst -binary -sha256 |
		openssl base64 -A |
		tr '+/' '-_' |
		tr -d '='
}
