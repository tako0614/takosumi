# LAN dev setup runbook — LAN client (Linux PC) で dev hostname access を有効化

> このページでわかること: LAN 内別マシンで dev stack を起動し、 ブラウザを 開く
> Linux PC から `https://*.takosumi.test` 等を踏むための setup 手順。

dev environment を LAN 内別マシンに移した場合 (= browser を開く Linux PC と、
dev stack を起動するマシンが LAN 内別ホスト) の LAN client 側手順。 dev
マシン側手順は takosumi の `deploy/local-substrate/docs/lan-host.md` を参照。

本 runbook は **Linux + systemd-resolved** 環境を前提。 macOS / Windows は scope
外。

## 前提

- LAN client (= 本 setup を実行する PC): Linux + systemd-resolved + 管理者権限
- dev マシン: 別 LAN ホストで local-substrate が LAN mode で起動済 (=
  `TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_IP` + `DNS_HOST_BIND` 設定済、 詳細は
  lan-host.md)
- dev マシンが LAN 内 **static IP** を持つ (= 例: `192.168.1.50`、 DHCP
  reservation でも可)
- LAN client と dev マシンが同一 LAN にあり、 互いに reachable

## Operator setup

このページのコマンドは ecosystem checkout (= `takos/` / `takosumi/` を含む
monorepo) を root として実行します。 dev マシン側の local-substrate stack の
場所 (`takosumi/deploy/local-substrate/`) と、本 runbook が取得する root CA /
DNS 設定の参照先を前提にします。 example の checkout path は `/root/dev/takos`
ですが、 自分の checkout 先に読み替えてください。

## 全体像

LAN client は以下 2 つを設定する:

1. **Pebble root CA を trust store に install** (= dev マシンが Pebble で issue
   した cert を browser / curl が緑鍵で verify するため)
2. **systemd-resolved の per-domain split** (= `*.takosumi.test` 等のクエリを
   dev マシンの CoreDNS (`<dev-LAN-IP>:53`) に向ける)

両方とも dev マシン側 script (`scripts/ca-install.sh` +
`scripts/configure-dns.sh`) の **LAN client 向け variant** として扱う (= dev
マシン側 script を流用 + 引数 override で動く)。

## Step 1 — Pebble root CA を LAN client の trust store に install

dev マシン側の `caddy/runtime/pebble-issuance-root.pem` を LAN client に転送し、
trust store に install する。

```bash
# dev マシン (= local-substrate を起動した側) から取得
scp <dev-user>@<dev-LAN-IP>:/path/to/takosumi/deploy/local-substrate/caddy/runtime/pebble-issuance-root.pem \
  /tmp/pebble-issuance-root.pem

# LAN client の trust store に install
sudo cp /tmp/pebble-issuance-root.pem \
  /usr/local/share/ca-certificates/takos-local-substrate-pebble.crt
sudo update-ca-certificates

# verify (root CA 1 件追加されている)
sudo update-ca-certificates 2>&1 | grep "1 added"
```

Pebble は **stack restart 毎に root CA を regenerate する**。
`docker compose
down -v` で完全 tear down → `up.sh` 後は root CA が変わるので、
上記の `scp` + `update-ca-certificates` を **再実行する**。 long-running dev
session 中なら気にしなくて良い。

## Step 2 — systemd-resolved per-domain split を `<dev-LAN-IP>:53` に向ける

```bash
sudo tee /etc/systemd/resolved.conf.d/takos-local-substrate-lan.conf <<'EOF'
# LAN client → dev マシンの CoreDNS へ *.takosumi.test を per-domain split
[Resolve]
DNS=192.168.1.50
Domains=~takosumi.test ~takos.test ~yurucommu.test
EOF

sudo systemctl restart systemd-resolved
```

`DNS=` の値は dev マシンの LAN IP (= `lan-host.md` で
`TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_IP` に設定した値) に書き換える。 `Domains=` は
dev hostname zone を `~` (= 接尾一致) で列挙: 今後 dev hostname zone を
追加した場合はここに append する。

`~takosumi.test` の leading tilde は **「`takosumi.test` で終わるクエリ のみ
この DNS server に送る」** の意。 他の DNS 解決は通常 path を踏むので WAN
解決が壊れない。

## Step 3 — 動作確認

```bash
# DNS: dev マシンの CoreDNS が LAN client から見えるか
dig hello.takosumi.test +short
# → 192.168.1.50 (= dev マシン IP) が返る

# 直接 dev マシン CoreDNS を叩く
dig hello.takosumi.test @192.168.1.50 +short
# → 192.168.1.50

# TLS: Pebble-issued cert が trust されているか
curl -v https://hello.takosumi.test/ 2>&1 | grep -E "Connected to|subject="
# → Connected to hello.takosumi.test (192.168.1.50) port 443
# → subject: CN=hello.takosumi.test

# trust が通っているか (curl -k 無しで成功するか)
curl https://hello.takosumi.test/
# → "hello from local-substrate (Phase 0)"
```

profile=postgres / workers を起動済なら (accounts plane と control plane は
`app.takosumi.test` の単一 worker origin に in-process mount される。issuer は
bare origin):

```bash
curl https://app.takosumi.test/.well-known/openid-configuration
curl https://app.takosumi.test/healthz
```

ブラウザでも `https://app.takosumi.test/` を開いて緑鍵 + SPA 表示を確認。

## tear down / 解除

```bash
# 1. DNS split を解除
sudo rm /etc/systemd/resolved.conf.d/takos-local-substrate-lan.conf
sudo systemctl restart systemd-resolved

# 2. Pebble root CA を trust store から削除
sudo rm /usr/local/share/ca-certificates/takos-local-substrate-pebble.crt
sudo update-ca-certificates --fresh
```

## トラブルシューティング

| 症状                                         | 原因                                                                                                                 | 対処                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `dig` で答えない                             | dev マシン側 CoreDNS が LAN listen していない                                                                        | dev マシン側 `lan-host.md` Step 1-2 を確認 (`DNS_HOST_BIND=0.0.0.0`)                                                               |
| `dig` は答えるが `127.0.0.1` を返す          | zone file が render 済でない or dev 側 `INGRESS_IP` 未設定                                                           | dev マシン側 `bash scripts/dns-zone-render.sh` を `TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_IP=<dev-LAN-IP>` で再実行 + caddy restart      |
| `curl: SSL certificate problem`              | LAN client に root CA install していない / Pebble restart で root が変わった                                         | Step 1 を再実行                                                                                                                    |
| ブラウザだけ緑鍵にならない                   | Firefox は OS trust store と独立 (`security.enterprise_roots.enabled=true` を設定するか、 ブラウザ専用 trust に追加) | Firefox: `about:config` で `security.enterprise_roots.enabled=true`、 Chrome / Chromium は OS trust store を見るので Step 1 で十分 |
| DNS は引けるが `curl` が timeout             | LAN firewall が `:443` を blocking、 または dev マシン側 firewall                                                    | dev マシン側で `sudo ss -ltnp \| grep 443` を確認、 LAN firewall (e.g., `ufw`) が 443/80/53 を allow しているか確認                |
| dev マシン IP が変わった (= DHCP lease 更新) | static IP / DHCP reservation 未設定                                                                                  | dev マシンを static IP 化、 LAN client の resolved.conf.d も更新                                                                   |

## Binary-native variant (= Docker 未 install な dev マシン)

dev マシンが Docker を持っていない場合は、 host 上に `dnsmasq` + `caddy` を
native binary install する **binary-native variant** で代用可能。 Pebble +
CoreDNS の代わりに Caddy `tls internal` で self-signed CA を発行する単純化
された stack。 詳細は `takosumi/deploy/local-substrate/docs/lan-host.md` の
「Binary-native variant」 section を参照。

LAN client (= 本 runbook の対象) 側手順は **同じ** で、 違いは Step 1 で
取得する root CA だけ:

| variant                              | root CA path (= dev マシン側)                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| Docker compose (= Pebble)            | `<repo>/takosumi/deploy/local-substrate/caddy/runtime/pebble-issuance-root.pem` |
| Binary-native (= Caddy tls internal) | `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`              |

`scp` で取得 + `update-ca-certificates` で install + systemd-resolved per-domain
split (= Step 2) は同 procedure。 dnsmasq の上流は CoreDNS と同じく
`<dev-LAN-IP>:53`、 wildcard `*.takosumi.test` / `*.takos.test` /
`yurucommu.test` を返す。

## Ecosystem dev hostname (= production hostname と 1:1 mirror)

LAN client が踏める dev hostname は production hostname を `.com/jp → .test`
に置換した形のみ。 invented subdomain (= `docs.takos.test` / `slide.takos.test`
等の production に存在しない hostname) は廃止 (Wave M-F)。

| dev hostname (= production mirror) | 用途                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `https://takosumi.test/`           | takosumi.com landing + `/docs/` VitePress                                                 |
| `https://app.takosumi.test/`       | app.takosumi.com (single worker: dashboard SPA + accounts plane + control plane + runner) |
| `https://takos.test/`              | takos.jp (admin / Takos product UI)                                                       |
| `https://road.takos.test/`         | road.takos.jp                                                                             |
| `https://yurucommu.test/`          | yurucommu.com                                                                             |
| `https://<tenant>.app.takos.test/` | Takosumi が deploy した app の動的 tenant subdomain                                       |

installable apps (= `takos-office` / `takos-computer` / `yurucommu`)
は Takos Workspace 内 install で `*.app.takos.jp` tenant subdomain で serve される
ため、 専用 dev hostname を持たない。

## 関連 runbook

- `takosumi/deploy/local-substrate/docs/lan-host.md` — dev マシン側 setup
  (= 本 runbook の対岸)、 binary-native variant の手順も含む
- `takosumi/deploy/local-substrate/docs/root-ca-install.md` — single-machine
  版 root CA + DNS split (= 本 runbook の参照元)
