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

| Concept      | 説明                                     |
| ------------ | ---------------------------------------- |
| AppSpec      | source root に置く `.takosumi.yml`       |
| Installation | Space に入った AppSpec の current state  |
| Deployment   | 1 回の dry-run / apply / rollback の結果 |

内部には Resource、Namespace、Secret、Event などの record がありますが、public
authoring surface には出しません。

## Kernel が持たないもの {#not-owned-by-kernel}

kernel は次を所有しません。

- user account / login / passkey
- billing / subscription / invoice
- OIDC issuer / consent screen
- customer onboarding UI
- workflow runner / cron / scheduler
- application-specific UI / DB schema / queue

これらは operator distribution または consumer application
が持つ責務です。kernel docs では、外部 surface が AppSpec component
と接続する必要がある場合だけ namespace export として扱います。

## Space {#space}

Space は Installation を置く install scope です。同じ AppSpec でも、Space が違え
ば Deployment history、resource state、namespace resolution、secret material は
別になります。

```text
Space
  └── Installation
        └── Deployment[]
```

Space は account-plane の詳細を含みません。kernel は request token から解決され
た `spaceId` を受け取り、その Space の中で AppSpec を apply します。

## Component と Resource {#component-and-resource}

AppSpec の `components` は名前付き Component map です。Component は `kind` を
持ち、kind ごとの `spec`、`publish`、`listen` を宣言します。

| 公開概念  | 説明                                              |
| --------- | ------------------------------------------------- |
| Component | AppSpec が宣言する kind / spec / publish / listen |

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
3. kernel validates syntax / schema / kind / namespace graph / Space context
4. kernel computes changes[] and expected.{commit, manifestDigest, sourceDigest?}
5. caller posts apply with the same source and expected values
6. kernel re-fetches source and verifies expected values
7. kernel resolves publish/listen DAG
8. kernel calls provider materializer per component
9. kernel persists Installation and Deployment records
```

`manifestDigest` は Installer API の wire field name です。current docs では
AppSpec digest を指します。

source を build / prepare する step はこの pipeline の外側です。BuildSpec を
使う場合、build service が先に prepared source snapshot を作り、
`source.kind=prepared` として渡します。

## Provider materialization {#provider-materialization}

kernel は provider plugin を operator config から受け取ります。provider
selection は component `kind`、provider hint、capability requirement から決まり
ます。決定不能なら、副作用の前に失敗します。

詳細は [Provider plugin](../providers.md) と
[Provider catalog](../provider-catalog.md) を参照してください。

## Runtime routing {#runtime-routing}

Deployment が current になると、runtime routing layer は GroupHead が指す
Deployment snapshot を読み、hostname / path / resource output から target
resource を選びます。routing の詳細は [Runtime routing](./runtime-routing.md) を
参照してください。

## Internal APIs {#internal-apis}

kernel の public installer API は `/v1/installations/*` です。operator
automation や runtime-agent 向けの internal route はありますが、AppSpec
authoring contract ではありません。

関連資料:

- [Kernel HTTP API](../kernel-http-api.md)
- [Runtime-Agent API](../runtime-agent-api.md)
- [Implementation / runtime-agent boundary](./implementation-operation-envelope.md)
