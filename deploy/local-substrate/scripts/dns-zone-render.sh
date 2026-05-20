#!/usr/bin/env bash
# coredns/zones/*.zone の {{INGRESS_IP}} placeholder を
# $TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_IP (default 127.0.0.1) で置換し、
# coredns/zones-rendered/ に書き出す。 CoreDNS は zones-rendered/ を mount する。
#
# Single-machine 起動 (= 既定):
#   bash scripts/dns-zone-render.sh
#     → 127.0.0.1 を埋め込んで zones-rendered/*.zone を生成 (backward compat)
#
# LAN 起動 (= dev マシン IP):
#   TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_IP=192.168.1.50 bash scripts/dns-zone-render.sh
#     → 192.168.1.50 を埋め込んで zones-rendered/*.zone を生成
#
# scripts/up.sh から自動で呼ばれるので、 通常 user が直接実行する必要は無い。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBSTRATE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_DIR="$SUBSTRATE_DIR/coredns/zones"
TARGET_DIR="$SUBSTRATE_DIR/coredns/zones-rendered"

INGRESS_IP="${TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_IP:-127.0.0.1}"

# 簡易 IPv4 / IPv6 validation。 完全な検証ではないが typo / undefined env を弾く。
if ! [[ "$INGRESS_IP" =~ ^[0-9a-fA-F:.]+$ ]]; then
	echo "TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_IP must be an IPv4 or IPv6 literal; got: $INGRESS_IP" >&2
	exit 1
fi

mkdir -p "$TARGET_DIR"

shopt -s nullglob
rendered=0
for src in "$SOURCE_DIR"/*.zone; do
	name="$(basename "$src")"
	dst="$TARGET_DIR/$name"
	sed "s/{{INGRESS_IP}}/$INGRESS_IP/g" "$src" > "$dst"
	rendered=$((rendered + 1))
done

if [[ "$rendered" -eq 0 ]]; then
	echo "no source zone files found under $SOURCE_DIR" >&2
	exit 1
fi

echo "==> Rendered $rendered zone file(s) into $TARGET_DIR (INGRESS_IP=$INGRESS_IP)"
