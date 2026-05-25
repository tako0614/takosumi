# Kernel {#kernel}

Public concepts: AppSpec / Installation / Deployment。Public Installer API:
[Installer API](../installer-api.md)。

## Kernel の責務 {#responsibility}

| Concept      | 説明                                    |
| ------------ | --------------------------------------- |
| AppSpec      | source root に置く `.takosumi.yml`      |
| Installation | Space に入った AppSpec の current state |
| Deployment   | 1 回の apply 結果。rollback の根拠      |

## Operator / application responsibilities {#operator-application-responsibilities}

operator distribution または consumer application は次を扱います。

- user account / login / passkey
- billing / subscription / invoice
- OIDC issuer / consent screen
- customer onboarding UI
- workflow runner / cron / scheduler
- application-specific UI / DB schema / queue

kernel docs では、これらの外部 surface が AppSpec component と接続する必要がある
場合に external publication として扱います。

## Space {#space}

Space は Installation を置く install scope です。同じ AppSpec でも、Space が違え
ば Deployment history、resource state、external publication resolution、secret
material は 別になります。

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

| 内部概念 | 説明                                                           |
| -------- | -------------------------------------------------------------- |
| Resource | operator-selected execution が apply した runtime state record |
| Material | publication / listen で解決される material registry            |
| Secret   | listen や provider operation に使う secret reference           |
| Event    | append-only audit event                                        |

Resource は provider-specific です。AppSpec author は Resource を直接作らず、
Component を宣言します。

## Installer pipeline {#installer-pipeline}

```text
1. caller or build service posts source to POST /v1/installations/dry-run
2. kernel fetches source and parses resolved .takosumi.yml
3. kernel validates syntax / schema / publish-listen graph / Space context
4. kernel computes changes[] and expected.{commit, manifestDigest, sourceDigest?}
5. caller posts apply with the same source and expected values
6. kernel resolves the submitted source descriptor and verifies expected values
7. kernel resolves publish/listen DAG
8. reference kernel dispatches the operator-selected implementation binding for each component
9. kernel persists Deployment/apply records linked to the Space-scoped Installation
```

`manifestDigest` は Installer API の wire field name です。source root の
`.takosumi.yml` raw file bytes の sha256 を指し、parsed AppSpec object の正規化
digest ではありません。

source を build / prepare する場合、build service が pipeline の前に prepared
source archive を作り、`source.kind: "prepared"` として渡します。

## Execution binding {#execution-binding}

component `kind` は opaque string。operator は alias / descriptor / policy を
使って kind URI を解決し、その Space で利用できる execution binding を選ぶ。
解決できない kind、許可されない descriptor、対応する execution がない component
は副作用前に失敗する。

reference implementation の binding mechanism は operator-facing docs に置く。

→ [Provider Implementations](../providers.md)

## Runtime routing {#runtime-routing}

→ [Runtime routing](./runtime-routing.md)

## Internal APIs {#internal-apis}

kernel の public installer API は [Installer API](../installer-api.md)
に定義する 5 endpoint です。operator automation や runtime-agent 向けの internal
route は、operator runtime surface として扱います。

関連資料:

- [Reference Kernel Route Inventory](../kernel-http-api.md)
- [Reference Runtime-Agent Execution Surface](../runtime-agent-api.md)
- [Implementation / runtime-agent boundary](./implementation-operation-envelope.md)
