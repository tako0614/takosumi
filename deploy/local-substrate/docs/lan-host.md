# LAN host mode — local-substrate を LAN 内 別マシンの browser から踏む

local-substrate は default で「dev マシン単独 (= 127.0.0.1 完結)」 構成。 **dev
マシン以外の Linux PC の browser から `https://*.takosumi.test` を
production-equivalent flow で踏みたい場合** にこの runbook を使う。

`root-ca-install.md` (single-machine 用) の **拡張**。 LAN client (= browser 側
Linux PC) で必要な手順は別 runbook
([`takos-private/docs/operations/lan-dev-setup.md`](../../../../takos-private/docs/operations/lan-dev-setup.md))。
本 runbook は **dev マシン (= local-substrate を起動する側)** の設定を扱う。

## 前提

- dev マシン: Linux + Docker + systemd-resolved (= `root-ca-install.md` と同じ
  要件)
- dev マシンが LAN 内で **static IP** を持つこと (= 例 `192.168.1.50`。 DHCP
  reservation でも可)
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

CoreDNS docker は host の `:53` を bind する。 systemd-resolved の stub listener
(default `127.0.0.53:53`) と衝突する場合は stub listener を無効化する:

```bash
sudo tee /etc/systemd/resolved.conf.d/disable-stub-listener.conf <<'EOF'
# CoreDNS docker container と :53 を共用するため stub listener を無効化
[Resolve]
DNSStubListener=no
EOF
sudo systemctl restart systemd-resolved
```

`/etc/resolv.conf` の symlink が `/run/systemd/resolve/stub-resolv.conf` を
指している場合、 上記設定後は `/run/systemd/resolve/resolv.conf` に向け直す:

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

dev マシンで `https://hello.takosumi.test/` を踏む場合の DNS resolver を CoreDNS
に向け直す:

```bash
sudo bash scripts/configure-dns.sh --dns 192.168.1.50
```

(= LAN client と同じ `--dns <dev-LAN-IP>` 指定。 dev マシン上で `127.0.0.1`
でも応答するが、 zone records が `<dev-LAN-IP>` なので結果同じ。)

### 4. Pebble root CA は従来通り install

```bash
sudo bash scripts/ca-install.sh
```

(= LAN client にも同 root CA を distribute する手順は LAN client 側 runbook
参照。)

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

LAN client 側の詳細手順 (root CA install + DNS split) は
[`takos-private/docs/operations/lan-dev-setup.md`](../../../../takos-private/docs/operations/lan-dev-setup.md)
を参照。

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

## 既知の制約

- **Pebble root CA は restart 毎に regenerate**: stack を
  `docker compose down
  -v` で完全 tear down すると Pebble の root CA
  が変わる。 dev マシン + 全 LAN client で root CA install
  を再実行する必要がある。 long-running dev session なら気にしなくて良い。
- **single dev マシン前提**: 同 LAN に 2 つの local-substrate stack を立てる
  運用は scope 外 (= 各 stack が `*.takosumi.test` を奪い合う)。
- **LAN client OS**: 本 runbook + LAN client 側 runbook は Linux +
  systemd-resolved のみ。 macOS / Windows は別タスク。
