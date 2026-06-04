# Operations: Patch Management

> このページでわかること: Takos operated environments の container base image、
> OS-level CVE、runtime dependency update、例外処理、週次自動 scan / update
> path。

この runbook は public managed Takos launch readiness (ROADMAP.md Managed Takos
Offering gap audit) の patch management 正本です。Takos は 基本 Web/API surface
として運用し、command-line tooling は primary customer UX
として扱いません。Takosumi CLI / manifest workflows から発生する更新は
`takosumi` / Takosumi deploy control の owning repo で扱い、Takos product shell は
app / git / agent / deploy artifact の patch gate を所有します。

## Scope

| Area                             | Owner                  | Automatic path                                  |
| -------------------------------- | ---------------------- | ----------------------------------------------- |
| Takos shell submodule pointers   | `takos/`               | `.github/dependabot.yml` `gitsubmodule` updates |
| GitHub Actions versions          | each owning repo       | Dependabot `github-actions` updates             |
| Takos worker container base image | `takos/`               | Dependabot `docker` for `/deploy/docker`        |
| Takos Git container base image    | `takos/containers/git` | Dependabot `docker` for `/containers/git`       |
| Takos agent container base image  | `takos/containers/agent` | Dependabot `docker` for `/containers/agent`   |
| Takos agent Rust deps             | `takos/containers/agent` | Dependabot `cargo` for `/containers/agent`    |
| Bun/npm dependencies              | each Bun package root  | `bun outdated` during patch window              |
| OS package CVEs                  | owning Dockerfile repo | weekly Trivy filesystem scan + image rebuild    |

private な deploy credential と環境別 secret rotation は operator vault
(= operator host の `/root/.takos-secrets/<env>/`) が所有します。本 public policy
は private run log を境界経由でのみ参照し、secret 名や provider account id は
載せません。

## Base Image Rules

- Dockerfile は `latest`、未 tag image、`oven/bun:1` のような major のみの
  tag を使わないこと。
- 言語 runtime image は minor / patch tag (例: `oven/bun:1.3.14` や
  `rust:1.94-bookworm`) を使うこと。
- `debian:bookworm-slim` のような distro suite tag は、image を週次で rebuild し
  Trivy scan evidence が green の場合のみ許可。
- deploy manifest の production image 参照は build / promotion 後に immutable
  digest ref にすること。
- Dockerfile の package install は Debian 系で `--no-install-recommends`、
  Alpine 系で `--no-cache` を使うこと。

これらのルールに対する gate:

```bash
cd takos
bun run validate:patch-management
```

`validate:patch-management` は Takos release gate の一部です。

## Weekly Automation

`.github/workflows/patch-management.yml` は毎週火曜 04:24 UTC と手動 dispatch
で実行されます。

実行内容:

- `bun run validate:patch-management` による policy validation
- HIGH / CRITICAL 脆弱性と Dockerfile misconfiguration を対象とした Trivy
  filesystem scan

Dependabot が update PR を作る対象:

- `takos/` の submodule pointer
- GitHub Actions のバージョン
- `takos/` / `takos/containers/git` / `takos/containers/agent` の Docker base image
- `takos/containers/agent` の Rust 依存

Bun/npm package は週次 patch window 中、owning repo で以下を実行します:

```bash
bun outdated
bun update
bun run check
bun run test
bun run lint
bun run fmt:check
```

該当 Bun package root が全ての task を定義していない場合は、その repo の `AGENTS.md`
にある最も近い local equivalent を実行します。

## Patch Window

default の週次 patch window:

- 火曜 13:00-15:00 JST: staging update PR の review
- 水曜 13:00-15:00 JST: staging が green なら production promotion

emergency patch window:

- 現実に exploit されている CVE、既知の secret exposure、または internet-facing
  service の public remote code execution の場合は即時に開く。
- emergency patch を検証している間は関係ない deploy を freeze する。

## Severity SLA

| Severity                                 | Target      | Required action                                      |
| ---------------------------------------- | ----------- | ---------------------------------------------------- |
| Critical exploited / internet-facing RCE | 24h         | emergency patch, staging proof, production promotion |
| Critical not known exploited             | 72h         | patch PR, rebuild image, production promotion        |
| High                                     | 7 days      | normal patch window                                  |
| Medium                                   | 30 days     | next planned dependency refresh                      |
| Low                                      | best effort | batch with routine updates                           |

runtime に該当パッケージが存在しない、または脆弱な経路に到達不能なため CVE が
exploit 不可と判断できる場合は、time-boxed な exception を記録します。

## Exception Record

exception には以下を含めます:

- CVE id または advisory id
- 影響を受ける image / 依存 / package
- 影響を受ける service
- 一時的に受容する理由
- compensating control
- owner
- 期限 (expiry date)
- tracking issue または private run log のリンク

30 日を超える exception は明示的な product owner 承認が必要です。

## Promotion Checklist

patch PR を promote する前に:

- owning repo で dependency / image update PR が merge 済み
- 更新された base image で Docker image を rebuild
- Trivy scan が green、または exception が記録されている
- service-local test が green
- `takos` release gate が green
- staging deploy が 1 observation window healthy
- rollback image digest が判明している

## Evidence

public evidence:

- Dependabot PR のリンク
- `patch-management` workflow の run
- `validate:patch-management` の出力
- release gate summary

private evidence:

- provider account id
- secret rotation log
- cloud billing account evidence
- production deploy の operator log
