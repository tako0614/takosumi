# Kernel

> このページでわかること: kernel の内部構造と installer pipeline の責務境界。

> **Internal implementation**
>
> このページは kernel の internal 実装を説明します。 public contract ではなく、
> 実装は変更される可能性があります。 public contract は
> [AppSpec](../app-spec.md) と [Installer API](../installer-api.md)
> を参照してください。

> **kernel = source-to-runtime substrate**
>
> takosumi kernel は **`.takosumi.yml` を読んで Installation を作り、 apply ごと
> に Deployment を記録する PaaS** です。 identity / billing / OAuth / workflow /
> cron / consent screen / Stripe / app marketplace は kernel に **入れません**。
> identity / billing は
> [Takosumi Accounts](https://github.com/tako0614/takosumi-cloud/blob/master/docs/architecture/takosumi-accounts.md)
> (account plane / operator-owned) の責務、 workflow / CI / cron は kernel scope
> の外 (operator が別途 orchestrator で実装) です。 全体モデルは
> [Installable App Model](https://github.com/tako0614/takos-ecosystem/blob/master/docs/platform/installable-app-model.md)
> を参照。

kernel が serve する request は、 AppSpec を起点にした Installation lifecycle に
従って routing / activation / resource wiring が解決される。 中核 record は 3
つだけ:

- **Installation** — Space に入った App
- **Deployment** — 1 回の apply 結果
- **(internal) Resource** — apply された component の runtime state

Public contract は AppSpec (`apiVersion: takosumi.dev/v1` + `kind: App` +
`components[]`) と Installer API (5 endpoint) のみ。

## Consumer application と kernel の境界

> kernel は **任意 application を deploy できる generic PaaS** であり、 特定
> distribution 専用 platform ではありません。 Takos product は reference
> distribution example の 1 つで、 kernel 仕様自体はこの 1 distribution に依存
> しません。

consumer application 固有の feature (Agent / Chat、 Git hosting、 Storage、
Store、 public API gateway 等) は consumer application 側の責務であり、 kernel
には入りません。 kernel が持つのは AppSpec apply、 routing projection、 resource
provisioning、 provider reconciliation で、 これは任意の InstallableApp
に共通する責務です。

kernel が持たないもの (Installable App Model の不変条件):

- user account / login / passkey
- billing / Stripe / subscription / invoice
- OAuth / OIDC issuer / consent screen (= Takosumi Accounts 所有)
- workflow / build pipeline / cron / scheduler (= scope 外)
- group 固有の UI / DB schema / queue / background job

kernel が compute に専念するため、 上記は次の owner に集約されます。

```text
identity / billing / OIDC / Installation ledger : Takosumi Accounts
.takosumi.yml parse / git fetch / install apply : kernel (= takosumi/packages/installer)
chat / agent / memory / app-local profile       : consumer application runtime
                                                  (例: Installed Takos product)
```

## Space

Space は **Takosumi Account 配下の install scope** です。 tenant (契約・billing
主体) は **Takosumi Account** であり、 Space はその下に並ぶ install scope です。

```text
Takosumi Account  (契約 / billing / identity owner)
  └── Space       (install scope, kind: personal / team / org)
        └── Installation  (Takos などの App の installation 単位)
              └── Deployment[]  (apply 履歴)
```

- Takosumi Account = 契約・billing・identity の owner (tenant 主体)
- Space は Takosumi Account 配下の **install scope** であり、 `personal` /
  `team` / `org` の kind を持つ
- Installation は Space に属し、 Space は Installation の親になる
- compute / data / routing は Space 単位で分離される
- user は Takosumi Account の identity を持ち、 Space を通じて Installation に
  アクセスする

## Component と Resource

AppSpec は `.takosumi.yml` の `components` に名前付き Component を宣言する。 各
Component は `kind` を 1 つ持ち (catalog 5 種)、 kernel installer が apply 時に
provider plugin を解決して runtime state (= Resource) を作る。

| 公開 概念 | 説明                                                |
| --------- | --------------------------------------------------- |
| Component | AppSpec が宣言する build / use / kind を持つ 1 unit |

| 内部 概念 | 説明                                                |
| --------- | --------------------------------------------------- |
| Resource  | apply 後の provider-scope runtime state record      |
| Secret    | use edge で resolve された credential store         |
| Event     | hash-chain audit log (内部 audit、 public route 外) |

`Resource` / `Secret` / `Event` は実装内部 entity であり、 public API には登場
しません。 Installation + Deployment + (内部 resources / secrets / events) で
完全な lifecycle を扱います。

## Installer pipeline

```text
1. caller posts source { kind, url, ref } to POST /v1/installations/dry-run
2. kernel fetches source (git / catalog / bundle), parses .takosumi.yml
3. kernel runs 5-phase validation (syntax / schema / use-edge / kind-catalog / space)
4. kernel computes changes[], estimatedCost, expected.{commit, manifestDigest}
5. caller posts apply with same source + expected
6. kernel re-fetches source, verifies expected (or accepts current)
7. kernel runs each component.build (= command) to produce artifact
8. kernel solves use-edge DAG, resolves secrets / env injection
9. kernel calls provider plugin per component (topological order)
10. kernel persists Installation + Deployment record with outputs
11. kernel returns Deployment to caller
```

build / fetch / provider call は kernel が直接実行する。 workflow runner や CI
pipeline は介在しない (= AppSpec の `component.build` は最小 recipe
のみ表現可)。

実装は `takosumi/packages/installer/` package と
`takosumi/packages/kernel/src/domains/{installer,binding}/` 配下。

## Routing

kernel は `{KERNEL_DOMAIN}` で control API を serve する。 Installation 配下の
worker component は routing layer で独自の hostname を持つ:

```text
Kernel ({KERNEL_DOMAIN}):
  /v1/installations/*     → installer public API
  /api/internal/v1/*      → internal control plane
  /healthz                → health check

Installation worker (routing layer で hostname 割り当て):
  1. auto:          {space-slug}-{installation-slug}.{TENANT_BASE_DOMAIN}
  2. custom slug:   {custom-slug}.{TENANT_BASE_DOMAIN} (optional, globally unique)
  3. custom domain: 任意のドメイン (optional, DNS 検証, kind: custom-domain で宣言)
```

OAuth / OIDC の login flow は kernel 内ではなく
[Takosumi Accounts](https://github.com/tako0614/takosumi-cloud/blob/master/docs/architecture/takosumi-accounts.md)
が扱います。 AppSpec が `components.<name>.kind: oidc` を宣言すると、 kernel
installer が Installation 作成時に Takosumi Accounts で per-Installation OIDC
client を発行し、 `use: { mount: oidc }` した worker に `OIDC_ISSUER_URL` /
`OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URIS` を inject
します。 kernel 自身は OAuth issuer endpoint を **持ちません**。

## Resource broker

kernel は `components[]` に宣言された Component を provider operation に解決
する:

- worker: `kind: worker` (= JS bundle / container)
- backing resource: `kind: postgres` / `kind: object-store` / OIDC client
- entrypoint: `worker.routes` / `kind: custom-domain`
- resource は Space / Installation 単位で分離される

Resource は internal record として control plane が persist し、 Installation や
provider の lifecycle と independent な durable record を持つ。 provider 側の
observed state は ProviderObservation stream として記録され、 canonical な
desired state は AppSpec の component entry です。 compute への接続は `use:`
edge から resolve された env / binding / provider config に materialize される。

```yaml
components:
  db:
    kind: postgres
    spec:
      class: standard

  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    use:
      db:
        env: DATABASE_URL
```

kernel 自身の storage (= installations / deployments / resources / secrets /
events table) は kernel DB を使う。

## Cross-references

- [AppSpec](../app-spec.md)
- [Installer API](../installer-api.md)
- [Component Kind Catalog](../component-kind-catalog.md)
- [Architecture: Manifest model](./manifest-model.md)
- [Provider Resolution](../provider-resolution.md)
