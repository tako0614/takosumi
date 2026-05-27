# Kernel {#kernel}

::: info
内部設計メモ。public contract は [Installer API](../installer-api.md) を参照。
:::

## Takosumi の責務 {#responsibility}

| Concept      | 説明                                     |
| ------------ | ---------------------------------------- |
| manifest     | source root に置く `.takosumi.yml`       |
| Installation | Space に入った manifest の current state |
| Deployment   | 1 回の apply 結果。rollback の根拠       |

## Operator / application responsibilities {#operator-application-responsibilities}

operator の設定または consumer application は次を扱います。

- user account / login / passkey
- billing / subscription / invoice
- OIDC issuer / consent screen
- customer onboarding UI
- workflow runner / cron / scheduler
- application-specific UI / DB schema / queue

Takosumi docs では、これらの外部 surface が manifest component と接続する必要がある場合に platform service として扱います。

## Space {#space}

Space は Installation を置く install scope です。同じ manifest でも、Space が違えば Deployment history、resource state、platform service resolution、secret material は別になります。

```text
Space
  └── Installation
        └── Deployment[]
```

Space ID は request token / installer context から解決されます。Takosumi は `spaceId` を受け取り、その Space の中で manifest を apply します。

## Component と Resource {#component-and-resource}

manifest の `components` は名前付き Component map です。Component は `kind` を持ち、kind ごとの `spec`、同一 manifest 接続の `connect`、platform service 接続の `listen` を宣言します。

| manifest 内の公開構造 | 説明                                               |
| --------------------- | -------------------------------------------------- |
| Component             | manifest が宣言する kind / spec / connect / listen |

| 内部概念 | 説明                                                           |
| -------- | -------------------------------------------------------------- |
| Resource | operator-selected execution が apply した runtime state record |
| Material | connect / listen で解決される出力データ registry               |
| Secret   | listen やリソースの作成・更新に使う secret reference           |
| Event    | append-only audit event                                        |

Resource は backend-specific です。manifest author は Resource を直接作らず、 Component を宣言します。

## Installer pipeline {#installer-pipeline}

```text
1. caller or build service posts source to POST /v1/installations/dry-run
2. Takosumi fetches source and parses resolved .takosumi.yml
3. Takosumi validates syntax / schema / connection graph / Space context
4. Takosumi computes changes[] and expected.{commit, manifestDigest, sourceDigest?}
   plus currentDeploymentId for deploy dry-run
5. caller posts apply with the same source and expected values
6. Takosumi resolves the submitted source and verifies expected values
7. Takosumi resolves connect / platform listen edges
8. Takosumi creates the Deployment attempt / retained operation evidence before
   resource side effects
9. reference Takosumi dispatches the operator-selected binding for
   each component
10. Takosumi records terminal status and moves the current pointer only on success
```

schema、auth、source guard、policy、バリデーションの失敗は resource side effect の前、かつ新しい public Deployment record の前にエラーレスポンスを返します。 lifecycle execution が開始されると、reference implementation は dispatch の前またはトランザクション的に attempt を記録します。この順序は implementation の durability rule であり、public な current-pointer semantics は Installer API に定義されます。

`manifestDigest` は Installer API の wire field name です。source root の `.takosumi.yml` raw file bytes の sha256 を指し、parsed manifest object の正規化 digest ではありません。

source を build / prepare する場合、build service が pipeline の前に prepared source archive を作り、`source.kind: "prepared"` として渡します。

## Execution binding {#execution-binding}

component `kind` は不透明な string。operator は alias / kind の定義 / policy を使って kind URI を解決し、その Space で利用できる execution binding を選ぶ。解決できない kind、許可されない kind の定義、対応する execution がない component は副作用前に失敗する。

reference implementation の binding mechanism は operator-facing docs に置く。

→ [Kind Binding Implementations](../kind-bindings.md)

## Runtime routing {#runtime-routing}

→ [Runtime routing](./runtime-routing.md)

## Internal APIs {#internal-apis}

Takosumi の public installer API は [Installer API](../installer-api.md) に定義されます。operator automation や runtime-agent 向けの internal route は、operator runtime surface として扱います。

関連資料:

- [Reference Kernel Route Inventory](../kernel-http-api.md)
- [Reference Runtime-Agent Execution Surface](../runtime-agent-api.md)
- [Implementation / runtime-agent boundary](./runtime-agent-boundary.md)
