# local-substrate

`*.takosumi.test` の DNS / TLS / ingress / OIDC / installer API / cloud emulator をすべて 1 つの docker network で完結させる cloud-independent test bed。

Takosumi の deploy / account-plane / cloud-worker surface を、 public network 依存ゼロで踏むための integration test bed。Takos product の dev stack や product distribution は各 product repo 側の責務で、ここでは direct service として起動しない。

Linux native 前提 (systemd-resolved / Docker daemon)。 macOS / WSL / native Windows は対象外。

## Phases

| Phase | scope                                                                                       | DoD                                                                          |
| ----- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 0     | Pebble (ACME staging) + CoreDNS + Caddy で `*.takosumi.test` を local TLS termination       | `curl https://hello.takosumi.test/` が 200                                   |
| 1     | takosumi service + Accounts + cloud worker / dashboard を同 stack に統合                     | OIDC discovery 解決 + installer API 成功                                     |
| 2     | LocalStack / k3d / fake-gcs / Azurite / miniflare を `compose.emulators.yml` 1 本で並行統合 | `scripts/smoke.sh` 全 cloud fixture が pass                                  |
| 3     | factory で endpoint override + Caddy admin route registrar + 公開面 deny 多重防御           | dynamic subdomain が deploy 直後に hit する + `prove-no-public-leak.sh` pass |

現在 Phase 0–3 まで実装済み。`scripts/smoke.sh` は canonical installer 5 endpoint surface も含めて検証する。

## Scope — Takosumi-only

この test bed は **Takosumi (service + Accounts + cloud worker + dashboard)** の integration test 専用。 Takos product (`takos-app`) や bundled app (yurucommu) の動作確認は各 repo 内の test に任せる:

- `takos/` — Takos product 固有の test (`bun test` / Playwright 等)
- `yurucommu/` — yurucommu 固有の test

外部 app の `source fixture` 由来 fixture を installer mock で使うことはあるが、それは Takosumi の install contract を検証するための入力 fixture です。該当 product を local-substrate の service として直起動する運用は扱わない。「Takosumi 経由で yurucommu / takos-app を install して deploy する」統合シナリオは別タスク (`@takos/local-miniflare-workers` connector 実装が前提、 TODO-SMOKE.md 筆頭参照)。

## Current smoke coverage (30 checks)

`scripts/smoke.sh` のチェック一覧 — 「smoke green = Takosumi だけで動かして deploy しても 99% 動く」を目標に、 honest pass のみを数える。各ファイル詳細は [TODO-SMOKE.md](TODO-SMOKE.md) と script header を参照。

| 範疇            | 件数 | 代表 check                                                                                                |
| --------------- | ---: | --------------------------------------------------------------------------------------------------------- |
| ingress         |    3 | `phase0.hello`, `accounts.oidc-discovery`, `service.health`                                                |
| prod-mirror     |    9 | `prod-mirror.landing.*` (4) + `prod-mirror.docs.index` + `prod-mirror.cloud.*` (4)                        |
| install flow    |    2 | `install.dry-run.{takos-docs,yurucommu}` (fixture data; Takosumi API)                                     |
| OAuth           |    4 | `oauth.e2e.{google,github}`, `oauth.tls-negative`, `oauth.csrf-replay`                                    |
| tenant          |    1 | `tenant.isolation` (cross-subject installation read must fail)                                            |
| docs            |    1 | `docs.link-check` (one-hop link audit across takosumi.test/docs + accounts)                               |
| passkey         |    1 | `passkey.e2e` (register + authenticate with virtual P-256)                                                |
| installer API   |    1 | `installer.api.e2e` (install dry-run/apply, deployment dry-run/apply, rollback)                           |
| workers         |    1 | `workers.cli-smoke` (Accounts + service Worker on workerd with D1/R2/Queue/DO)                             |
| route-registrar |    1 | `registrar.alive` (service → Caddy admin sync via internal network)                                        |
| object store    |    1 | `minio.roundtrip` (mb → put → get → sha256 round-trip)                                                    |
| migrations      |    1 | `migration.idempotency` (Accounts Worker D1 restart preserves schema byte-identical)                      |
| otel            |    1 | `otel.pipeline` (synthetic OTLP trace lands in Jaeger)                                                    |
| k6 perf         |    1 | `k6.baseline` (20 RPS × 20s with `p(95)<50ms` install dry-run + `<30ms` oidc — regression watch, NOT SLO) |
| mailpit         |    1 | `mailpit` (SMTP catcher reachable + probe email delivered)                                                |
| stripe          |    1 | `stripe.webhook.e2e` (HMAC verify + idempotency + tolerance)                                              |

加えて vitest 4 case (COSE/JWK decode) + worker_test.ts 30 case (issuer policy + IPv6/CGNAT + fail-closed + R2 route-level signed export / malformed URL / data-bearing refusal) + Playwright 2 spec (install wizard happy path + TLS trust regression) を CI で並列実行する。公開面 / egress の companion gate として `scripts/prove-no-public-leak.sh` も用意している。

CI workflow は ecosystem-root の `.github/workflows/local-substrate-smoke.yml` を参照。 3 job (smoke / vitest / playwright) が submodule checkout 経由で takosumi + takosumi を揃え、 ca-install.sh の sudo run + Pebble root の NSS install を含めた full chain を毎 PR で再現する。

Latest local CLI verification: 2026-05-27 fresh Docker volumes,
`bash scripts/up.sh --profile postgres` followed by `bash scripts/smoke.sh`
completed with `30 passed, 0 failed`.

## Quick start

```bash
cd takosumi/deploy/local-substrate

# Phase 0: ingress only (Pebble + CoreDNS + Caddy)
bash scripts/up.sh

# Phase 1+: substrate (service + accounts + cloud worker + dashboard +
# route-registrar) on top of Phase 0 ingress
bash scripts/up.sh --profile postgres

# Worker-first substrate mirror: Accounts Worker on D1/R2 plus Takosumi
# service Worker on D1/R2/Queue/DO. Here service.takosumi.test is the Worker.
bash scripts/up.sh --profile workers

# one-time per host
sudo bash scripts/ca-install.sh
sudo bash scripts/configure-dns.sh

# verify
bash scripts/smoke.sh
bash scripts/prove-no-public-leak.sh
curl https://hello.takosumi.test/
curl https://accounts.takosumi.test/.well-known/openid-configuration
curl https://service-worker.takosumi.test/healthz  # postgres profile mirror
curl https://service.takosumi.test/healthz         # workers profile
```

Dashboard browser E2E uses the static dashboard artifact served by Caddy, so
rebuild it through the compose builder that supplies local dev sign-in env and
then recreate Caddy. The yurucommu CTA regression also expects the yurucommu
Vite server on host port 5173:

```bash
# from the repository root
(
  cd takosumi/deploy/local-substrate
  docker compose -f compose.substrate.yml --profile postgres run --rm takosumi-dashboard-build
  docker compose -f compose.ingress.yml up -d --force-recreate caddy
)

# separate shell, from the repository root
cd yurucommu
bun run dev:web

# from the repository root
cd takosumi/packages/dashboard-ui
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 bun run e2e
```

詳細は [docs/root-ca-install.md](docs/root-ca-install.md) と [docs/operator-runbook.md](docs/operator-runbook.md)。

## ファイル layout

```
takosumi/deploy/local-substrate/
├── README.md
├── docs/
│   ├── architecture.md
│   ├── root-ca-install.md
│   ├── operator-runbook.md
│   └── browser-test-playbook.md
├── compose.ingress.yml          # Pebble + CoreDNS + Caddy
├── compose.substrate.yml        # service + accounts + cloud worker + dashboard + route-registrar
├── compose.emulators.yml        # opt-in: localstack, k3d
├── caddy/
│   ├── Caddyfile
│   └── runtime/                 # up.sh が生成 (gitignored)
├── coredns/
│   ├── Corefile
│   └── zones/{takosumi.test.zone, deny-letsencrypt.zone}
├── pebble/pebble-config.json
├── factories/
│   └── local-substrate-factories.ts   # 公開 DNS provider import-time deny
├── wrappers/
│   ├── service-with-embedded-agent.ts  # postgres profile service + agent in-process
│   └── takosumi-service-worker-runner.mjs # local-only Miniflare D1/R2/Queue/DO runner
├── route-registrar/
│   ├── package.json
│   └── mod.ts                   # preserve Caddy dynamic-route partition
└── scripts/
    ├── up.sh
    ├── down.sh
    ├── ca-install.sh
    ├── configure-dns.sh
    ├── smoke.sh
    └── prove-no-public-leak.sh
```

## Browser trust (Chrome / Firefox 上で `.test` を踏める状態にする)

Pebble は毎回 root CA を再生成するので、ホストの trust store にも、 Chrome / Firefox の NSS DB にも root を入れる必要がある。 `ca-install.sh` は両方を一括で処理する:

```bash
sudo bash deploy/local-substrate/scripts/ca-install.sh
```

実行後の手動確認 checklist:

- [ ] Chromium / Chrome を完全終了 (タスクトレイ含む) → 再起動 → `https://takosumi.test/` で privacy error が出ないこと
- [ ] 同じく `https://accounts.takosumi.test/` が緑鍵で開くこと
- [ ] Firefox (snap か deb どちらでも) を再起動 → 同様に確認
- [ ] `scripts/up.sh` で Pebble を再起動した場合は root が rotation されているので、 `sudo bash scripts/ca-install.sh` を再実行 + ブラウザ再起動

`certutil` が無い場合 `sudo` ありで実行すれば `libnss3-tools` を自動 install する。非 sudo で実行すると system trust は skip、 NSS DB のみ更新する (NSS は per-user)。

最後に手動 verification した日付を以下に記録:

| 日付     | Chrome | Firefox (snap) | 確認者 | 環境 | メモ                                                                                                                                      |
| -------- | ------ | -------------- | ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| _未確認_ | _-_    | _-_            | _-_    | _-_  | _CI (.github/workflows/local-substrate-smoke.yml) で毎 PR 自動実行されている (smoke + dashboard-ui-playwright job)。ローカル目視は別途要_ |

CI で自動検証されるパス:

- ecosystem-root の `.github/workflows/local-substrate-smoke.yml`
  - `smoke` job: `up.sh → sudo bash scripts/ca-install.sh → bash scripts/smoke.sh`
  - `dashboard-ui-playwright` job: 同 install + Playwright が **`ignoreHTTPSErrors=false`** で Chromium が Pebble 経由の cert を NSS DB から validate するかを assert
  - `dashboard-ui-vitest` job: COSE/JWK unit test

ローカル目視は dev iteration の中で実行し、上記 table に行追加して commit する。

## 制約

- **公開面は絶対に出さない**: ACME は Pebble 固定、 DNS は CoreDNS 固定、 emulator は内部 network。 Phase 3 で多重防御 guard と `prove-no-public-leak.sh` を追加
- **実 cloud compute は credentials で叩いてよい**: emulator 無し compute (Fargate / Cloud Run / Container Apps / Cloudflare Container) は `.env` に credentials を入れた場合に限り real cloud を呼ぶ。 default では factory が register せず "provider not configured" で fail させる
- **Takosumi-owned fixture に閉じる**: endpoint override は `deploy/local-substrate/factories/` と local wrapper に閉じ、 Takos product service をこの compose topology に戻さない
