#!/usr/bin/env bash
# Configure systemd-resolved to send *.takosumi.test queries to CoreDNS.
# Linux native (systemd-resolved) only.
#
# Single-machine 用途 (= 既定): CoreDNS は dev マシンの 127.0.0.1:53 にいる。
#   sudo bash scripts/configure-dns.sh
#
# LAN client (= 別 Linux PC) 用途: CoreDNS は dev マシン (<dev-LAN-IP>:53) にいる。
#   sudo bash scripts/configure-dns.sh --dns 192.168.1.50
set -euo pipefail

DNS_IP="127.0.0.1"
while [[ $# -gt 0 ]]; do
	case "$1" in
		--dns)
			DNS_IP="$2"
			shift 2
			;;
		--dns=*)
			DNS_IP="${1#--dns=}"
			shift
			;;
		*)
			echo "unknown arg: $1" >&2
			echo "usage: $0 [--dns <ip>]   (default: 127.0.0.1)" >&2
			exit 1
			;;
	esac
done

if [[ $EUID -ne 0 ]]; then
	echo "Must run as root (sudo bash scripts/configure-dns.sh)" >&2
	exit 1
fi

if ! command -v systemctl >/dev/null; then
	echo "systemctl not found; this script targets systemd-resolved." >&2
	exit 1
fi

CONF=/etc/systemd/resolved.conf.d/takos-local-substrate.conf
mkdir -p "$(dirname "$CONF")"
cat > "$CONF" <<EOF
# Managed by takosumi/deploy/local-substrate/scripts/configure-dns.sh
[Resolve]
DNS=$DNS_IP
Domains=~takosumi.test
EOF

systemctl restart systemd-resolved
echo "==> systemd-resolved configured for *.takosumi.test → $DNS_IP"
echo "    Remove $CONF and restart systemd-resolved to revert."
