# Operator Boundaries

Operator Boundaries は、self-host 可能な PaaS としてどこを operator が管理し、
どこを user manifest に開くかを定義する。Takosumi は自由に plugin を足せるが、
credential、storage、auth、adapter wiring、public API exposure は operator
boundary に閉じる。

## HTTP Surfaces

Takosumi には 3 種類の deploy / control API surface がある。

| Surface              | Path                 | Auth                    | Role                                                  |
| -------------------- | -------------------- | ----------------------- | ----------------------------------------------------- |
| CLI public deploy    | `/v1/deployments`    | `TAKOSUMI_DEPLOY_TOKEN` | single-token operator CLI 用                          |
| Public PaaS API      | `/api/public/v1/*`   | Actor auth              | space / group / deployment / rollback を扱う PaaS API |
| Internal control API | `/api/internal/v1/*` | HMAC-SHA256             | worker / runtime-agent / owning service 間 RPC        |

`/v1/deployments` は現在 `mode: apply | plan | destroy` を受け取り、`plan` は
`applyV2({ dryRun: true })` を実行する。

`/api/public/v1/deployments` は `mode: preview | resolve | apply | rollback` の
Core deployment flow を扱う。ここでは Deployment record、GroupHead、
ProviderObservation、approval、rollback が正本である。

次期 manifest model は短期的には CLI route の manifest parser を vNext 化し、
長期的には Core PaaS API と同じ Deployment-centric path へ寄せる。

source:

- `docs/reference/kernel-http-api.md`
- `packages/kernel/src/api/deploy_public_routes.ts`
- `packages/kernel/src/api/public_routes.ts`
- `packages/kernel/src/api/internal_routes.ts`

## Auth And Route Enablement

kernel HTTP surface は 3 credential を区別する。

| Credential               | Env var                                                              | Scope                                  |
| ------------------------ | -------------------------------------------------------------------- | -------------------------------------- |
| Deploy bearer token      | `TAKOSUMI_DEPLOY_TOKEN`                                              | `/v1/deployments`, artifact write / GC |
| Artifact read-only token | `TAKOSUMI_ARTIFACT_FETCH_TOKEN`                                      | `GET` / `HEAD` `/v1/artifacts/:hash`   |
| Internal HMAC secret     | `TAKOSUMI_INTERNAL_API_SECRET` or `TAKOSUMI_INTERNAL_SERVICE_SECRET` | `/api/internal/v1/*`                   |

`TAKOSUMI_DEPLOY_TOKEN` が unset の場合、public deploy / artifact routes は
opt-in されず、関連 endpoint は 404 になる。token 設定漏れを route mount 状態で
表す既存仕様である。

internal HMAC は method / path / query / body digest / actor / timestamp /
request id を canonicalize し、timestamp skew と replay protection を検証する。

source:

- `docs/reference/kernel-http-api.md`
- `packages/contract/src/internal-rpc.ts`
- `packages/kernel/src/api/internal_auth.ts`

## Production Self-host

production self-host で必須に近い設定:

- `TAKOSUMI_DATABASE_URL` or environment-specific database URL
- `TAKOSUMI_SECRET_STORE_PASSPHRASE` or `TAKOSUMI_SECRET_STORE_KEY`
- `TAKOSUMI_DEPLOY_TOKEN`
- `TAKOSUMI_ARTIFACT_FETCH_TOKEN`
- `TAKOSUMI_ENVIRONMENT=production`
- `TAKOSUMI_DEV_MODE` は unset

production / staging では adapter port が未 wire の場合 fail-closed する。local
/ dev では in-memory fallback が許可されるが、restart で state が消える。

public deploy route は現状 single-token / single-tenant model である。

- token は `TAKOSUMI_DEPLOY_TOKEN` 1 つ。
- tenant id は `"takosumi-deploy"` に固定。
- 複数 org / operator を分けるには kernel instance を分離する。

source:

- `docs/operator/self-host.md`
- `docs/reference/env-vars.md`
- `packages/kernel/src/config/runtime.ts`

## Credential Boundary

kernel は cloud credential を直接持たない。credential や cloud SDK 実行は
runtime-agent / provider gateway / connector 側に置く。

connector の役割:

- provider lifecycle command を実行する。
- Docker / systemd / kubectl / cloud SDK へ接続する。
- credential を operator boundary 内に閉じ込める。
- kernel に provider-neutral な result を返す。

Takosumi core は connector protocol と state orchestration を担当する。

source:

- `docs/reference/runtime-agent-api.md`
- `packages/contract/src/runtime-agent-lifecycle.ts`

## Secret Store

secret store の既存仕様:

- memory encrypted secret store は AES-GCM。
- partition ごとに key derivation する。
- partition examples: `global`, `aws`, `gcp`, `cloudflare`, `k8s`,
  `selfhosted`。
- rotation policy は `active`, `due`, `expired` を計算できる。
- automatic rotation はせず、operator が rotate する。

manifest plugin や provider plugin が secret raw value
を直接扱う場合、その境界は policy decision / approval / runtime-agent connector
側で明示する。

source:

- `packages/kernel/src/adapters/secret-store/memory.ts`

## Self-host Connector Survival

selfhost connector restart-survival:

- `@takos/selfhost-docker-compose`: `docker inspect` が source of truth。
- `@takos/selfhost-postgres`: `docker inspect` が source of truth。
- `@takos/selfhost-systemd`: on-disk unit file + `systemctl is-active` が source
  of truth。

この設計では、kernel state と provider runtime state を混同しない。provider 側を
再観測して drift / missing / degraded を表し、desired state は Deployment
に残す。

## Observability

実装済み surface:

- `/livez`
- `/readyz`
- `/status/summary`
- `audit_events` hash-chain

Prometheus `/metrics` と OTLP exporter は未実装である。production self-host で
必要な場合は observability kernel plugin port として扱う。

source:

- `docs/operator/self-host.md`
- `packages/kernel/src/services/observability/audit_chain.ts`
