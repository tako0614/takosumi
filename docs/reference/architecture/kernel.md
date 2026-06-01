# Kernel {#kernel}

::: info
内部設計メモ。public contract は [Installer API](../installer-api.md) を参照。
:::

## Takosumi の責務 {#responsibility}

| Concept | 説明 |
| --- | --- |
| Source | git / prepared / local source input と resolved identity |
| Installation | Space に install された source record |
| Deployment | 1 回の apply 結果。source summary、plan snapshot、binding snapshot、outputs、status を持つ |
| PlatformService | operator inventory が提供し、install / deploy 時に選択される service capability |

Takosumi core は Source を解決し、dry-run で `InstallPlan` と
`planSnapshotDigest` を返し、apply で Deployment record を保存します。

## Operator / Application Responsibilities {#operator-application-responsibilities}

operator distribution または consumer application は次を扱います。

- user account / login / passkey
- billing / subscription / invoice
- OIDC issuer / consent screen
- customer onboarding UI
- workflow runner / cron / scheduler
- Terraform/OpenTofu/Helm/Pulumi state
- provider credential / secret store / runtime attachment
- application-specific UI / DB schema / queue

これらを workload が使う場合、operator distribution が PlatformService
inventory と binding policy として公開します。

## Space {#space}

Space は Installation を置く install scope です。同じ Source でも、Space が違えば
Deployment history、binding snapshot、secret material、account-plane projection
は別になります。

```text
Space
  └── Installation
        └── Deployment[]
```

Space ID は request token / installer context から解決されます。Takosumi は
`spaceId` を受け取り、その Space の中で Source を install / deploy します。

## Installer Pipeline {#installer-pipeline}

```text
1. caller or build service posts Source to POST /v1/installations/dry-run
2. Takosumi resolves source identity and generic repo metadata
3. operator resolver evaluates requested BindingSelection against PlatformService inventory
4. Takosumi returns InstallPlan + planSnapshotDigest
5. caller posts apply with Source and expected guard values
6. Takosumi verifies source pins / source digest / planSnapshotDigest
7. Takosumi records the Deployment attempt before runtime side effects
8. reference implementation dispatches operator-selected adapters or runtime-agent work
9. Takosumi records terminal status and moves the current pointer only on success
```

schema、auth、source guard、policy、binding resolution の失敗は runtime side effect
の前に closed error envelope で返します。lifecycle execution が始まった後の
durability rule は reference implementation の内部設計ですが、public な
current-pointer semantics は Installer API に従います。

## Execution Binding {#execution-binding}

Takosumi core は provider を選びません。operator distribution が
PlatformService inventory、binding policy、backend adapter、runtime-agent
connector を選びます。reference implementation の adapter wiring は
operator-facing docs に置きます。

→ [Reference Backend Binding](../kind-bindings.md)

## Internal APIs {#internal-apis}

Takosumi の public Installer API は [Installer API](../installer-api.md) に定義されます。operator automation や runtime-agent 向けの internal route は、operator runtime surface として扱います。

関連資料:

- [Reference Kernel Route Inventory](../kernel-http-api.md)
- [Reference Runtime-Agent Execution Surface](../runtime-agent-api.md)
- [Implementation / runtime-agent boundary](./runtime-agent-boundary.md)
