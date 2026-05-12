# API Surface Architecture

Takosumi kernel が外部に公開する HTTP / RPC surface は、caller の信頼境界と SLA
期待値が異なる 4 つの surface に分割されます。本 doc は「なぜそう分けた
か」「error envelope の哲学」「version 戦略」「OpenAPI の意味」を architecture
レイヤで確定させるためのものです。endpoint カタログ自体は
[Kernel HTTP API reference](/reference/kernel-http-api) を一次資料とし、
ここでは設計判断のみを扱います。

## Surface split

kernel は 4 surface に分割されます。

| Surface           | Path prefix                         | Caller                                     | Auth model              | SLA 期待値                                           |
| ----------------- | ----------------------------------- | ------------------------------------------ | ----------------------- | ---------------------------------------------------- |
| Public deploy     | `/v1/deployments`                   | `takosumi deploy --remote` を握る operator | Bearer (deploy)         | High availability。breaking change は新 version      |
| Internal control  | `/api/internal/v1/*`                | operator 運営の CLI / dashboard            | Internal HMAC           | operator 内 close。version 規約は緩い                |
| Runtime-agent RPC | `/api/internal/v1/runtime/agents/*` | operator-installed runtime-agent process   | Internal HMAC           | kernel ↔ agent 間の internal RPC。互換は kernel 主導 |
| Artifact upload   | `/v1/artifacts/*`                   | deploy CLI (write) / runtime-agent (read)  | Bearer (deploy / fetch) | content-addressed。breaking は不可                   |

surface ごとに client / auth / SLA を完全に分離する目的:

- **caller の信頼レベルが違う**: public deploy は operator の手元 CLI、 internal
  は operator のサーバー間、runtime-agent RPC は cloud credential を握る別
  process。同一 token / 同一 path で混ぜると blast radius が unbounded
  になります。
- **互換 contract の硬さが違う**: public deploy は operator の CI に焼き
  付くため breaking 不可。internal は operator が両端を運用するため rolling
  更新で済みます。
- **可用性要件が違う**: artifact fetch は runtime-agent apply の hot path、
  deploy は人手起動。surface を分けることで rate limit / quota / scaling
  方針を独立に決められます。

## Authentication model

kernel は v1 で 4 credential を区別します。すべて env 経由で operator が inject
し、kernel は永続化しません。

| Credential                      | Scope                                                      | 分離理由                                                         |
| ------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `TAKOSUMI_DEPLOY_TOKEN`         | `/v1/deployments/*`、`/v1/artifacts/*` write               | operator CI が握る最強 token。compromise 時の影響を最小化したい  |
| `TAKOSUMI_INTERNAL_API_SECRET`  | `/api/internal/v1/*` 全体 (HMAC 鍵)                        | operator backplane だけが知る鍵。runtime-agent host にも置かない |
| `TAKOSUMI_ARTIFACT_FETCH_TOKEN` | `GET /v1/artifacts/:hash` のみ                             | runtime-agent host に置く read-only token。漏洩しても apply 不可 |
| runtime-agent enrollment token  | `POST /api/internal/v1/runtime/agents/enroll` の bootstrap | one-shot で broker される。長寿命 credential を host に焼かない  |

設計判断:

- credential を **scope ごとに最小権限** へ分離します。同一 token を多用途
  に流用しません。
- Current public deploy は `TAKOSUMI_DEPLOY_TOKEN` 1 つを
  `TAKOSUMI_DEPLOY_SPACE_ID` (default `takosumi-deploy`) の public deploy scope
  に bind します。per-actor Space routing は internal control plane の責務で、
  public manifest body から Space を選ばせません。
- `TAKOSUMI_DEPLOY_TOKEN` 未設定時は public route が **404** を返します。 401
  だと「token を忘れた operator」と「endpoint 自体が無効化された operator」
  を区別できず、accidental exposure を隠蔽するためです。
- 内部 HMAC は `method` / `path` / `query` / `body digest` / `actor` /
  `timestamp` を canonical 化して署名します。replay 防止のため `requestId` を 5
  分 TTL で記憶し、skew 5 分以上は 401 にします。

## Error envelope philosophy

すべての public / internal endpoint は closed shape の error envelope
を返します。

```ts
interface ApiErrorEnvelope {
  readonly error: {
    readonly code: DomainErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly details?: JsonValue;
  };
}
```

設計判断:

- `requestId` は **常に存在**。caller が `X-Request-Id` を送らなければ kernel が
  ULID で生成し、log と response の両方に同じ値を載せる。 operator support 時の
  grep 起点 / audit 突合 / client retry の dedup key を一本化するためです。
- envelope は closed。kernel 側で `details` 以外の field を増やしません。 detail
  は explicit に opt-in。
- `details` 内の sensitive key (`authorization` / `cookie` / `token` / `secret`
  / `password` / `credential` / `api_key` / `private_key`) は 自動 redact
  されます。redaction は serializer 層で行い、developer の
  書き忘れを許容しません。
- `DomainErrorCode` は 9 値の closed enum で、HTTP status とは多対 1 で
  写像します。HTTP status は transport 層、code は domain 層という分離を
  維持し、operator が code だけで分岐できるようにします。code → classification
  (safeFix / requiresPolicyReview / operatorFix) の対応は
  [Policy / Risk / Approval / Error Model](./policy-risk-approval-error-model.md)
  側に正本を持ちます。

## Versioning strategy

- **public surface** (`/v1/deployments`、`/v1/artifacts`): `/v1/` を URL
  に固定。breaking change は新 prefix (`/v2/`) を切って併走させ、transition
  window は最低 90 日。breaking とは「同じ request に対する response shape /
  status code / error code の意味が変わる」ことを言い、項目追加だけでは
  ありません。
- **internal surface** (`/api/internal/v1/*`): `v1` は同居していますが、
  operator が kernel と CLI / dashboard を一緒に rolling 更新するため
  rolling-compat を broken させない範囲で `v1` 内に shape 追加が許されます。
  breaking change は `Cross-references` の architecture docs を更新し、kernel /
  CLI を同時 release するのが規約です。
- **artifact** は content-addressed なので URL semantic は不変。`hash` の digest
  algorithm を変えるときだけ新 surface を切ります。

## Idempotency on writes

`POST /v1/deployments` は client retry が発生しうる write です。

- caller は `X-Idempotency-Key` を送ります。kernel は同じ key の再送に対し
  最初の outcome を replay します。
- replay は request body digest に bind されます。同じ key で byte-identical
  body が来た場合だけ最初の response を返し、同じ key で別 body が来た場合は
  `409 failed_precondition` として拒否します。1 つの operation intent が別の
  manifest に再束縛されることを防ぐためです。
- Current public deploy stores idempotency responses in the public deploy
  idempotency store, scoped by public deploy Space / tenant. In the richer
  OperationPlan path, the same caller intent maps onto the WAL idempotency model
  described in
  [OperationPlan / Write-Ahead Journal Model](./operation-plan-write-ahead-journal-model.md).
- client が key を送らなかった場合、kernel は per-request UUID を生成
  しますが、network 起因の重複再送に対する保護は得られません。これは CLI
  の責務として CLI 実装が key を必ず付与します。

## Pagination & list semantics

list endpoint は cursor pagination を採用する方針です。Current public artifact
list (`GET /v1/artifacts`) は cursor pagination を実装済みです。Current public
deployment list (`GET /v1/deployments`) は CLI status 用の scoped summary を返す
だけで、cursor / `space=*` / kind filter はまだ公開していません。これらは
internal status/control-plane surface または将来の public route として、実装・
OpenAPI・CLI pagination handling がそろった時点で公開します。

- offset 不採用。caller の view と server の order が並行 write の下で ずれると
  skip / dup が発生するためです。
- cursor は **server opaque**。caller は cursor を読み解かない契約です。
- max page size は server-side cap (default 200)。caller がそれを超える
  `pageSize` を要求すれば 400 `invalid_argument`。

## OpenAPI generation strategy

`packages/kernel/src/api/openapi.ts` は **public deploy surface と artifact
surface のみ** を export します。

- internal control plane RPC と runtime-agent RPC は OpenAPI に **含めません**。
  caller が operator backplane に閉じており、wire shape を SDK 化する利用者
  が存在しないためです。internal RPC を同居させると public consumer が 「これは
  public surface だ」と誤認しやすくなります。
- OpenAPI は generation の一次入力ではなく、kernel 内部の Hono route contract
  から **derive** されます。route 定義側を正本とし、OpenAPI は read-only
  artifact として publish します。

## Gateway-manifest signing architecture

`POST /api/internal/v1/runtime/agents/:agentId/gateway-manifest` は kernel が
gateway URL bundle を Ed25519 で署名して返します。

設計判断:

- 採用: Ed25519。short signature / constant-time verify / kernel が credential
  を保持しない設計と整合 (private key は kernel host 限定)。
- 鍵 rotation: kernel は `keys[]` で旧鍵 + 新鍵を同時 publish し、retire まで
  **最大 7 日 window** で両 keyId を accept します。runtime-agent は trust store
  を更新してから kernel が `Issuer` を切り替える運用です。
- header `X-Takosumi-Signature: ed25519=<sig>; key=<keyId>` は鍵 rotation を
  parse 時に区別できるよう keyId を必須にします。
- 署名対象は **body bytes** の SHA-256 ダイジェストに対する Ed25519 で、 HTTP
  header / status は対象外。proxy が transport header を変えても body integrity
  は保てます。

## Cross-references

- Reference: [Kernel HTTP API](/reference/kernel-http-api)
- Reference: [Runtime-Agent API](/reference/runtime-agent-api)
- Reference: [Lifecycle Protocol](/reference/lifecycle)
- Architecture:
  [Policy / Risk / Approval / Error Model](./policy-risk-approval-error-model.md)
- Architecture:
  [OperationPlan / Write-Ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
- Architecture: [Execution Lifecycle](./execution-lifecycle.md)
- Architecture: [Operator Boundaries](./operator-boundaries.md)
