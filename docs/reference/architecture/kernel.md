# Kernel {#kernel}

> このページでわかること: Takosumi kernel が持つ責務と、AppSpec apply が
> Deployment になるまでの内部 pipeline。

このページは internal implementation note です。public contract は
[AppSpec](../app-spec.md) と [Installer API](../installer-api.md) を正本として
ください。

## Kernel の責務 {#responsibility}

Takosumi kernel は source-to-runtime substrate です。source root の
`.takosumi.yml` を AppSpec として読み、Space に Installation を作り、apply ごと
に Deployment を記録します。

kernel が public concept として扱う名詞は 3 つです。

| Concept      | 説明                                    |
| ------------ | --------------------------------------- |
| AppSpec      | source root に置く `.takosumi.yml`      |
| Installation | Space に入った AppSpec の current state |
| Deployment   | 1 回の apply / rollback の結果          |

内部 record には Resource、Namespace、Secret、Event などがあり、public authoring
surface は AppSpec / Installation / Deployment を入口にします。

## Operator / application responsibilities {#operator-application-responsibilities}

operator distribution または consumer application は次を扱います。

- user account / login / passkey
- billing / subscription / invoice
- OIDC issuer / consent screen
- customer onboarding UI
- workflow runner / cron / scheduler
- application-specific UI / DB schema / queue

kernel docs では、これらの外部 surface が AppSpec component と接続する必要がある
場合に namespace export として扱います。

## Space {#space}

Space は Installation を置く install scope です。同じ AppSpec でも、Space が違え
ば Deployment history、resource state、namespace resolution、secret material は
別になります。

```text
Space
  └── Installation
        └── Deployment[]
```

Space ID は request token / installer context から解決されます。kernel は
`spaceId` を受け取り、その Space の中で AppSpec を apply します。

## Component と Resource {#component-and-resource}

AppSpec の `components` は名前付き Component map です。Component は `kind` を
持ち、kind ごとの `spec`、`publish`、`listen` を宣言します。

| AppSpec 内の公開構造 | 説明                                              |
| -------------------- | ------------------------------------------------- |
| Component            | AppSpec が宣言する kind / spec / publish / listen |

| 内部概念  | 説明                                                 |
| --------- | ---------------------------------------------------- |
| Resource  | materializer が apply した runtime state record      |
| Namespace | publish / listen の registry                         |
| Secret    | listen や provider operation に使う secret reference |
| Event     | append-only audit event                              |

Resource は provider-specific です。AppSpec author は Resource を直接作らず、
Component を宣言します。

## Installer pipeline {#installer-pipeline}

```text
1. caller or build service posts source to POST /v1/installations/dry-run
2. kernel fetches source and parses resolved .takosumi.yml
3. kernel validates syntax / schema / namespace graph / Space context
4. kernel computes changes[] and expected.{commit, manifestDigest, sourceDigest?}
5. caller posts apply with the same source and expected values
6. kernel re-fetches source and verifies expected values
7. kernel resolves publish/listen DAG
8. reference kernel dispatches the operator-selected implementation binding for each component
9. kernel persists Installation and Deployment records
```

`manifestDigest` は Installer API の wire field name です。current docs では
AppSpec digest を指します。

source を build / prepare する場合、build service が pipeline の前に prepared
source snapshot を作り、`source.kind=prepared` として渡します。

## Provider materialization {#provider-materialization}

kernel は kind alias map と implementation binding array を operator config から
受け取ります。component `kind` は opaque string で、operator が URI
に解決します。 Takosumi reference kernel の provider materialization
では、解決した kind URI を `provides[]` に含む `KernelPlugin` adapter
を選びます。決定不能なら、副作用の前 に失敗します。

詳細は [Provider Implementations](../providers.md) を参照してください。

## Runtime routing {#runtime-routing}

Deployment が current になると、runtime routing layer は GroupHead が指す
Deployment snapshot を読み、hostname / path / resource output から target
resource を選びます。routing の詳細は [Runtime routing](./runtime-routing.md) を
参照してください。

## Internal APIs {#internal-apis}

kernel の public installer API は `/v1/installations/*` です。operator
automation や runtime-agent 向けの internal route は、operator runtime surface
として扱います。

関連資料:

- [Kernel HTTP API](../kernel-http-api.md)
- [Runtime-Agent API](../runtime-agent-api.md)
- [Implementation / runtime-agent boundary](./implementation-operation-envelope.md)
