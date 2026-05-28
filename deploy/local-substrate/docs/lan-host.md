# LAN host mode — local-substrate を LAN 内別マシンの browser から踏む

local-substrate は default で「dev マシン単独 (= 127.0.0.1 完結)」構成。 **dev マシン以外の Linux PC の browser から `https://*.takosumi.test` を production-equivalent flow で踏みたい場合** にこの runbook を使う。

`root-ca-install.md` (single-machine 用) の **拡張**。 LAN client (= browser 側 Linux PC) で必要な手順は別 runbook ([`takos-private/docs/operations/lan-dev-setup.md`](../../../../takos-private/docs/operations/lan-dev-setup.md))。本 runbook は **dev マシン (= local-substrate を起動する側)** の設定を扱う。

## 前提

- dev マシン: Linux + Docker + systemd-resolved (= `root-ca-install.md` と同じ要件)
- dev マシンが LAN 内で **static IP** を持つこと (= 例 `192.168.1.50`。 DHCP reservation でも可)
- LAN client (browser 側 PC) が Linux + systemd-resolved

## 何が変わるか

| 項目                          | single-machine            | LAN host mode                       |
| ----------------------------- | ------------------------- | ----------------------------------- |
| zone file の A record target  | `127.0.0.1`               | `<dev-LAN-IP>`                      |
| CoreDNS host bind             | `127.0.0.1:53`            | `0.0.0.0:53` (= LAN 全 interface)   |
| dev マシン自身の DNS resolver | `127.0.0.1:53`            | `<dev-LAN-IP>:53`                   |
| Caddy host bind               | `0.0.0.0:80/443` (= 不変) | `0.0.0.0:80/443` (= 不変)           |
| Pebble root CA                | dev マシン trust store    | dev マシン + LAN client trust store |

## dev マシン側 setup

### 1. systemd-resolved の `:53` を空ける

CoreDNS docker は host の `:53` を bind する。 systemd-resolved の stub listener (default `127.0.0.53:53`) と衝突する場合は stub listener を無効化する:

```bash
sudo tee /etc/systemd/resolved.conf.d/disable-stub-listener.conf <<'EOF'
# CoreDNS docker container と :53 を共用するため stub listener を無効化
[Resolve]
DNSStubListener=no
EOF
sudo systemctl restart systemd-resolved
```

`/etc/resolv.conf` の symlink が `/run/systemd/resolve/stub-resolv.conf` を指している場合、上記設定後は `/run/systemd/resolve/resolv.conf` に向け直す:

```bash
sudo ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
```

### 2. up.sh を LAN mode で起動

```bash
export TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_IP=192.168.1.50   # dev マシンの LAN IP
export TAKOSUMI_LOCAL_SUBSTRATE_DNS_HOST_BIND=0.0.0.0     # LAN 全 interface listen
bash scripts/up.sh                                        # or --profile postgres
```

env var を shell profile (`~/.bashrc` 等) に export しておけば毎回設定不要。

### 3. dev マシン自身の DNS resolver を更新

dev マシンで `https://hello.takosumi.test/` を踏む場合の DNS resolver を CoreDNS に向け直す:

```bash
sudo bash scripts/configure-dns.sh --dns 192.168.1.50
```

(= LAN client と同じ `--dns <dev-LAN-IP>` 指定。 dev マシン上で `127.0.0.1` でも応答するが、 zone records が `<dev-LAN-IP>` なので結果同じ。)

### 4. Pebble root CA は従来通り install

```bash
sudo bash scripts/ca-install.sh
```

(= LAN client にも同 root CA を distribute する手順は LAN client 側 runbook 参照。)

## 動作確認 (dev マシンで)

```bash
# CoreDNS が LAN interface でも答えているか
dig hello.takosumi.test @192.168.1.50 +short
# → 192.168.1.50

# 自分の LAN IP 経由で TLS 終端
curl -v https://hello.takosumi.test/ 2>&1 | grep -E "Connected to|subject="
# → Connected to hello.takosumi.test (192.168.1.50) port 443
```

## 検証 (LAN client で)

LAN client (= 別 Linux PC) で:

```bash
# DNS が LAN client から見えるか
dig hello.takosumi.test @192.168.1.50 +short
# → 192.168.1.50

# (root CA install + configure-dns.sh --dns 192.168.1.50 適用後)
curl https://hello.takosumi.test/
# → "hello from local-substrate (Phase 0)"
```

LAN client 側の詳細手順 (root CA install + DNS split) は [`takos-private/docs/operations/lan-dev-setup.md`](../../../../takos-private/docs/operations/lan-dev-setup.md) を参照。

## tear down / single-machine mode に戻す

```bash
# 1. unset env vars (= 次回 up.sh は default 127.0.0.1 で起動)
unset TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_IP TAKOSUMI_LOCAL_SUBSTRATE_DNS_HOST_BIND

# 2. systemd-resolved stub listener を元に戻す (= optional)
sudo rm /etc/systemd/resolved.conf.d/disable-stub-listener.conf
sudo systemctl restart systemd-resolved
sudo ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf

# 3. resolved の per-domain split を 127.0.0.1 に戻す
sudo bash scripts/configure-dns.sh    # default 127.0.0.1

# 4. stack 再起動
bash scripts/down.sh && bash scripts/up.sh
```

## Ecosystem product dev hostname (Wave M-C → M-F 訂正後)

production hostname 構造を正確に mirror する dev hostname のみを Caddy が reverse_proxy する。 host.docker.internal 経由で host で起動した Vite dev server を覆う構成。

| dev hostname (= production の mirror)          | upstream (host で起動)      | 起動コマンド (= 該当 product root で)    |
| ---------------------------------------------- | --------------------------- | ---------------------------------------- |
| `https://takos.test/` (= `takos.jp`)           | `host.docker.internal:4322` | `cd takos/website && npm run dev`        |
| `https://road.takos.test/` (= `road.takos.jp`) | `host.docker.internal:1420` | `cd road-to-me/app && deno task dev`     |
| `https://yurucommu.test/` (= `yurucommu.com`)  | `host.docker.internal:5173` | `cd yurucommu/web && deno task dev`      |

bundled apps (= `takos-docs` / `takos-slide` / `takos-excel` / `takos-computer`) は **Takos space 内に install されて `*.app.takos.jp` tenant subdomain で serve される** model なので、専用 dev hostname を持たない。 dev では各 Vite dev server を localhost (= `:3001` / `:3002` / `:3003` / etc.) で直起動し、 Takos UI 内から iframe / launch する。

複数 product を同時起動する場合 default 5173 が衝突するため、各 vite.config.ts の `server.port` を別 port にずらし、 Caddyfile の該当 entry の port も同期する必要がある。

各 product の vite.config.ts は Wave M-C で `server.host = true` 化済 (= LAN binding 有効)、 Caddy 経由でなくとも `http://<dev-LAN-IP>:<port>` で直接 access も可能。ただし TLS 終端 + production-equivalent CORS / CSRF / OAuth allowlist (= Wave M-D) を経由する場合は dev hostname (= https) access が必要。

## Binary-native variant (= docker compose を使わない quick setup)

Docker compose が未 install な dev マシンでも、 host 上に `dnsmasq` + `caddy` を native binary install するだけで同じ dev hostname access を提供できる (= Pebble + CoreDNS を省略する代わりに Caddy の `tls internal` で self-signed CA を発行)。 production deploy 手順とは別で、「**docs を詰める** ためだけの最速 path」。

```bash
# 1. install
sudo apt install -y dnsmasq caddy

# 2. dnsmasq config
sudo tee /etc/dnsmasq.d/takos-local-substrate.conf <<EOF
bind-interfaces
listen-address=<DEV_LAN_IP>          # 例: 192.168.0.122
no-resolv
no-hosts
address=/takosumi.test/<DEV_LAN_IP>
address=/takos.test/<DEV_LAN_IP>
address=/yurucommu.test/<DEV_LAN_IP>
server=1.1.1.1
server=8.8.8.8
EOF

# 3. Caddyfile (= production と同 path 構造、単一 host で / + /docs/*)
sudo tee /etc/caddy/Caddyfile <<'EOF'
{ auto_https disable_redirects }

takosumi.test {
  tls internal
  encode gzip
  handle_path /docs/* {
    root * /path/to/takosumi/docs/.vitepress/dist
    try_files {path} {path}.html {path}/index.html /404.html
    file_server
  }
  handle {
    root * /path/to/takosumi/website/.output/public
    try_files {path} {path}/index.html /index.html
    file_server
  }
}
EOF

# 4. systemd-resolved の :53 stub listener を空ける (= dnsmasq と衝突回避)
sudo tee /etc/systemd/resolved.conf.d/disable-stub-listener.conf <<'EOF'
[Resolve]
DNSStubListener=no
EOF
sudo systemctl restart systemd-resolved caddy dnsmasq

# 5. Caddy internal root CA を取得 (LAN client へ distribute する用)
sudo cp /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt \
  /tmp/takos-caddy-root.crt

# 6. takosumi を build (= file_server は build 出力を都度 read)
cd <repo-root>/takosumi && deno task docs:build
cd <repo-root>/takosumi/website && npx vinxi build
```

LAN client (= browser PC) 側は [`takos-private/docs/operations/lan-dev-setup.md`](../../../../takos-private/docs/operations/lan-dev-setup.md) の手順を実行 (= root CA install + systemd-resolved per-domain split)。

docs を編集 → `deno task docs:build` を再実行 → ブラウザ refresh で反映 (= Caddy reload 不要、 file_server は file system 直読)。 production deploy が **static file_server** なので、 dev も同 method で揃え、 dev-only HMR layer を入れない方針。

## 既知の制約

- **Pebble root CA は restart 毎に regenerate**: stack を `docker compose down
  -v` で完全 tear down すると Pebble の root CA が変わる。 dev マシン + 全 LAN client で root CA install を再実行する必要がある。 long-running dev session なら気にしなくて良い。
- **single dev マシン前提**: 同 LAN に 2 つの local-substrate stack を立てる運用は scope 外 (= 各 stack が `*.takosumi.test` を奪い合う)。
- **LAN client OS**: 本 runbook + LAN client 側 runbook は Linux + systemd-resolved のみ。 macOS / Windows は別タスク。
- **Vite default port 衝突**: takos product UI / yurucommu / control が default 5173 を使う。同時起動する場合は別 port を割り当てる。
