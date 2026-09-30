# OSS lifecycle evidence map

このページは、Takosumi OSS の source と既存検証が何を証明するかを整理する
evidence map です。新しい GA / release gate、承認、deploy authorization を作りません。
Takosumi Hosted と Takoserver の権限・手順も所有しません。各 operator は対象環境と
その操作を所有する repository の手順を使います。

## 証拠のつながり

```text
reviewed source commit
  → exact-head quality CI + portable checks
  → [local image build + native qualification | exact-commit CI candidate + attestation verification]
  → immutable Runner image publication
  → private /runs/:id/plan-state-metadata readback
  → dependent platform Worker Version
  → Runner application readback
  → real install/serving journey and separately qualified recovery
```

それぞれの段階は別の対象を証明します。source check の成功は image の公開を、公開済み
image は稼働中 Container を、Worker Version の readback はアプリの実動作を証明しません。
証跡には、実行した exact commit、artifact digest または immutable Version identity、対象環境、
実際の結果を対応付けます。branch / pull request の状態、通常の `/healthz`、一般の Plan
成功だけから次の段階を推定しません。

| Evidence | 確認できること | 確認できないこと |
| --- | --- | --- |
| Source / portable | exact source tree に対する `bun run check` と、その commit に対する exact-head quality CI。`bun run test:critical-journeys` は既存の portable Bun tests を使う read-only lane で、source install、Plan/Apply approval、Output readback、Destroy/recreate と dashboard install contract の負例を確認する | 公開済み Runner image、deployed Worker、live install、recovery/DR |
| Native image qualification | 既存 local-image build path では exact local image startup、`/healthz`、provider-free runtime-input Plan を確認する。選択可能な exact-commit CI candidate path では `runner proof` workflow の `linux/amd64` image、candidate record、image を使う native smoke と real HTTP Plan/Apply proof、および両 artifact を覆う GitHub Actions attestation を検証する | どちらの経路も、それだけでは registry への公開、稼働中 Container、platform Worker の deploy を証明しない。CI candidate は公開済み image ではない |
| Image publication | `takosumi-runner-image build` が記録する exact source/config と immutable OCI descriptor digest。local-image path は `/healthz` と provider-free runtime-input Plan を実行し、CI candidate path はその exact candidate と attestation を検証する | private route の published-image readback、Worker rollout、実サービス lifecycle |
| Pre-Worker route readback | **現在は運用commandと証跡生成手順がない。** 下記の未解決項目を参照 | `/healthz`、通常の Plan、local image の runtime-input Plan ではこのrouteを通った証拠にならない |
| Deployed version | platform release の immutable Worker Version と binding readback。Runner image の postdeploy `verify` は選択した image digest と Container application identity、active/ready、rollout / instance health を照合する | `/runs/:id/plan-state-metadata` の事前readback、利用者の install/serving journey、recovery/DR |
| Real journey | install-serving E2E は app-staging 上の Yurucommu source → install plan → Plan → Apply → Output 由来の HTTP body → Destroy / URL 404 を確認する。dashboard `live` は supplied storage state、exact Worker UUID、Workspace / switch Workspace / app / URL / bucket の読み取り確認で、mutation を拒否する。`public-live` は base URL と exact Worker UUID を使い、unauthenticated OIDC/JWKS/401/deep SPA/install return link と zero-mutation を確認する | Container/native actor lifecycle や production の証拠。header 単体は source provenance / live install の証拠ではない |
| Recovery / DR | owner の実 adapter、backup、restore target で実施した private drill evidence | partial `BackupRecord` export、source-only recovery composition、StateVersion が存在するという事実だけでは restore / DR capability を証明しない |

## Runner route の未解決 readback

現在の Runner source には private な `POST /runs/:id/plan-state-metadata` があり、digest を
検証した保存済み OpenTofu Plan archive 内の `tfstate` から bounded な `{ lineage, serial }`
metadata を返します。dependent Worker の新しい caller は Apply / Destroy 前にこの route を
使います。しかし、公開済み image に対して Worker activation より先にこの route を確認し、
結果を残す owner command / operator procedure はまだありません。

Registry publication は runtime Container の activation ではありません。通常の image-literal-only
platform full deploy も、exact source pin の Worker / DO code を同じ実行で有効化し得るため、image
だけを先に進めたことにはなりません。route を使う caller と Runner route を分けて出す場合は、
[platform Worker runbook](./platform-worker-deploy.md#exact-plan-lockfile-rollout-boundary) の
A/B 手順どおり、A に互換 Runner と旧 caller を置き、A の exact source pin で image rollout と
Container 収束を readback してから、descendant B の caller を有効化します。この source map は
現在の live image / Worker Version や、その順序を実現する対象があることを確認していません。
image publication や image-literal-only full deploy だけで route の事前確認済みとは扱いません。

必要なreadbackの入力と期待結果は明確です。これを実行する既存commandがある、または
新しい権限を追加する、という意味ではありません。

- **入力:** 公開した immutable Runner image digest と一致する、既存 operator authority の範囲で
  選んだ隔離確認対象。対象の identity / image digest を先に readback します。加えて、資格確認用に
  用意した bounded saved Plan archive、その exact bytes の `sha256:` digest、archive の既知の
  期待 `lineage` / `serial` を使います。
- **期待結果:** 確認対象の private route に digest 付き archive を渡し、bounded JSON response が
  `{ lineage, serial }` の shape だけでなく、その archive から既知の期待値として得た両値とも
  一致することを確認します。rejection、malformed / oversized response、値の不一致、または別
  image への接続は失敗として扱います。
- **解除条件:** exact image digest と隔離確認対象を結んだ route-specific readback とその結果が
  そろうまで、route に依存する Worker を先行して有効化しません。運用可能な呼び出し手順と
  証跡の owner が用意されるまでは、この段階は未確認です。

既存 image build の local `/healthz` と provider-free runtime-input Plan は image 起動と別の
Plan path を確認するものです。postdeploy `verify` は Worker rollout 後に Container を読む
ので、pre-Worker確認を代替しません。health 200、通常の Plan 成功、旧 image が route を持つ
という推測から先へ進みません。public/driver API 経由で private route を呼ばず、本番の既存 Run
を資格確認用に流用しません。確認対象がなければ新しい application や権限を作らず、未確認のまま
owner procedure の不足として扱います。

## Lifecycle と recovery の読み方

[`install-serving-e2e`](./install-serving-e2e.md) は実際に app-staging へ install し、destroy
まで実行します。operator が対象 Workspace と cleanup の責任を選ぶ必要があります。失敗した
Apply を成功扱いにしたり、自動で retry / destroy したりしません。対象は Yurucommu source flow
であり、Container/native actor や production ではありません。

`bun run test:critical-journeys` と dashboard の portable browser suite はローカル検証です。
dashboard `live` と `public-live` はそれぞれ既存 session state / exact Worker identity を必要と
する別の read-only probe です。これらを live install の代わりに使ったり、live probe の成功を
production release の承認と解釈したりしません。

StateVersion rollback は新しい Run の Plan と review を経る通常の lifecycle です。failed Apply
は failed のままとし、provider state / custody を保持します。source checks の成功だけから
failed state の手動 DB/state 修復、Apply、Destroy、replay を許可しません。

現行 `BackupRecord` は partial export で、対応する OSS importer / restore route はありません。
`disaster-recovery` の証拠には、選択した persistence adapter の verified backup と isolated
restore procedure が必要です。別の operator recovery composition が source-only なら、route /
CLI、private authorization、耐久 journal、one-shot D1/R2 launcher、live recovery drill の各証拠が
そろうまでは実運用の復旧手段として扱いません。

## 既存の手順

- [Runner image release](./runner-image-release.md): immutable image publication、exact CI candidate、
  platform rollout と postdeploy image verify。
- [Platform Worker deploy](./platform-worker-deploy.md): exact source pin、Worker Version と Container
  rollout の readback。
- [Dashboard browser E2E](./dashboard-browser-e2e.md): portable、authenticated live、public-live の範囲。
- [Backup / restore drills](./backup-restore-drills.md)、[disaster recovery](./disaster-recovery.md)、
  [incident response](./incident-response.md): operator-owned restore / recovery authority。
- [Run model](../concepts/run-model.md)、[State and Outputs](../concepts/state-and-outputs.md)、
  [Sources](../concepts/sources.md): lifecycle と data ownership の contract。
- [Critical journeys](../internal/critical-journeys.md)、[Core spec](../internal/core-spec.md): portable journey
  inventory と current OSS contract。
