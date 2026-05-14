# API Surface Architecture

> このページでわかること: kernel の API surface 設計と endpoint 分類。

Takosumi kernel が外部に公開する HTTP / RPC surface は、caller の信頼境界と SLA
期待値が異なる 4 つの surface に分割されます。本 doc は「なぜそう分けた
か」「error envelope の哲学」「version 戦略」「OpenAPI の意味」を architecture
レイヤで確定させるためのものです。endpoint カタログ自体は
[Kernel HTTP API reference](/reference/kernel-http-api) を一次資料とし、
ここでは設計判断のみを扱います。

## Surface split

kernel は 4 surface に分割されます。具体的な path prefix / caller / auth model
は [Kernel HTTP API § Overview](/reference/kernel-http-api#overview) を参照。
本ページは **なぜ 4 surface に分けたか** の設計判断のみを扱います。

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

具体的な credential 名 (`TAKOSUMI_DEPLOY_TOKEN` / `TAKOSUMI_INTERNAL_API_SECRET`
/ `TAKOSUMI_ARTIFACT_FETCH_TOKEN`) と endpoint への bind は
[Kernel HTTP API § Authentication](/reference/kernel-http-api#authentication)
が一次資料です。本節は **credential を分離した設計判断** を扱います。

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

すべての public / internal endpoint は closed shape の error envelope を
返します。具体的な `ApiErrorEnvelope` 型と `DomainErrorCode` 9 値の closed enum
は [Kernel HTTP API § Error envelope](/reference/kernel-http-api#error-envelope)
を参照。本節は envelope を closed にした **設計判断** を扱います。

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

- **public surface** (`/v1/deployments`、`/v1/artifacts`): current spec は
  `/v1/` を URL に固定します。breaking change は同じ変更で spec / implementation
  / tests / docs を一貫更新し、公開 docs に old/new dual-run の
  約束を置きません。breaking とは「同じ request に対する response shape / status
  code / error code の意味が変わる」ことを言い、項目追加だけでは ありません。
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
- public deploy は idempotency response を public deploy idempotency store
  (public deploy Space / tenant scope) に保存する。 OperationPlan path では 同じ
  caller intent が
  [OperationPlan / Write-Ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
  の WAL idempotency model に写像する。
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
gateway URL bundle を Ed25519 で署名して返します。具体的な header / 署名
algorithm / rotation window などの wire-level reference は
[Kernel HTTP API § Gateway manifest signing](/reference/kernel-http-api#gateway-manifest-signing)
を参照。本節は **その algorithm / rotation 方針を選んだ理由** を扱います。

設計判断:

- 採用: Ed25519。short signature / constant-time verify / kernel が credential
  を保持しない設計と整合 (private key は kernel host 限定)。
- 鍵 rotation: 旧鍵 + 新鍵を同時 publish し、retire まで **最大 7 日 window**
  で両 keyId を accept する。これは runtime-agent fleet を rolling 更新する 間に
  kernel 側で issuer 切替を強行しないため (trust store の伝播時間を確保 する)。
- header に keyId を必須にしたのは、rotation 中の signature parse 時に旧/新
  鍵を区別できるようにするため。`alg=ed25519` だけでは rotation 中の判別が
  できない。
- 署名対象を **body bytes** の digest に限定したのは、HTTP proxy が transport
  header を書き換えても body integrity は保てるようにするため。header を
  対象に含めると proxy chain で署名が壊れる risk が出る。

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
