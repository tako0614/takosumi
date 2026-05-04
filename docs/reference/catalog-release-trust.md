# CatalogRelease Trust Model

> Stability: stable
> Audience: operator, kernel-implementer, integrator
> See also: [Connector Contract](/reference/connector-contract), [Provider Plugins](/reference/providers), [Risk Taxonomy](/reference/risk-taxonomy), [Approval Invalidation Triggers](/reference/approval-invalidation), [Audit Events](/reference/audit-events), [CLI](/reference/cli), [Kernel HTTP API](/reference/kernel-http-api), [Closed Enums](/reference/closed-enums)

CatalogRelease は Takosumi v1 で「shape / provider / template の release pin」
を Space に adopt する単位です。本 reference では CatalogRelease /
Connector / Implementation の **3-tier trust chain** とその signature
verification 経路、publisher key の enroll / rotate / revoke、resolution time
の verify 失敗時挙動、operator UX を固定します。

## 3-tier trust chain

| Tier              | 内容                                                       | Signer                                | Verifier        |
| ----------------- | ---------------------------------------------------------- | ------------------------------------- | --------------- |
| CatalogRelease    | shape / provider / template の release pin descriptor 集合 | catalog publisher (operator-trusted)  | kernel          |
| Connector         | connector instance manifest (credential binding 付き)      | operator                              | runtime-agent   |
| Implementation    | provider plugin の particular implementation binding       | provider plugin author                | runtime-agent   |

### CatalogRelease tier

- catalog publisher (Takosumi-operator が enroll した trusted entity) が
  release を sign する。
- kernel が adoption / resolution 時に signature を verify する。
- CatalogRelease descriptor は Space に adopt されると、その Space の
  ResolutionSnapshot が pin する shape / provider / template の release を
  固定する。

### Connector tier

- connector instance は operator が sign する。runtime-agent が boundary で
  verify する。
- runtime-agent boundary は kernel と完全に分離されており、connector
  signature の verification 主体は **runtime-agent** であって kernel ではない。
  詳細は [Connector Contract](/reference/connector-contract) を参照。

### Implementation tier

- provider plugin author が particular implementation を sign する。
- runtime-agent が dispatch 直前に signature を verify する。
- 同じ provider plugin に複数 implementation がある場合、それぞれ独立に
  sign / verify される。

## Signature algorithm

3 tier すべてで **Ed25519** を使う。これは gateway-manifest signing と同じ
algorithm であり、kernel / runtime-agent 双方が単一 verify path を持つ。

- 鍵 size / canonical encoding / signature header layout は kernel が固定。
- 別 algorithm を adopt するには `CONVENTIONS.md` §6 RFC を要する。

## Publisher key enrollment

trusted publisher の identity は operator が明示的に enroll する。kernel は
事前知識を持たず、enroll されていない publisher の signature は verify でき
ない。

- **enroll**: operator が publisher の Ed25519 public key を kernel に登録
  する。enroll は audit event `publisher-key-enrolled` を伴う。
- **rotation**: publisher は新 key を CatalogRelease descriptor に embed
  して新 release を出す。kernel は当該 descriptor を verify する際に新 key
  を採用する (旧 key は revocation list に追加されるまで併存する)。
- **revocation**: operator が rotation の完了に合わせて revocation list に
  旧 key を載せる。kernel はこの list を即時反映し、revoked key で sign された
  CatalogRelease descriptor を以後 verify failure として扱う。

publisher key の rotation policy は CatalogRelease descriptor に embed する
形で publisher 側に主導権がある。kernel 側で rotation cadence を強制しないが、
operator policy で minimum rotation interval を要求することはできる。

## CatalogRelease descriptor との関係

- CatalogRelease descriptor は shape / provider / template の release pin
  集合と publisher key set を含む。
- descriptor digest が ResolutionSnapshot に記録され、approval record の
  binding にも乗る。
- kernel は **resolution time に signature verification を実行**する。
  verify は idempotent で、同じ descriptor digest に対して何度走らせても
  結果は変わらない。

## Verify 失敗時の挙動

verify が失敗するケースと kernel の挙動を以下に固定する。

- **signature verify failure** (descriptor の signature が publisher key で
  verify できない): resolution は **fail-closed**。当該 ResolutionSnapshot は
  確定せず、`implementation-unverified` Risk が emit される
  ([Risk Taxonomy](/reference/risk-taxonomy) §13)。approval があっても
  Risk severity が `error` のため進めない。
- **publisher key revoked** (verify は形式上通るが、key が revocation list
  に載っている): kernel は当該 publisher の CatalogRelease descriptor 全体
  を invalid 扱いし、依存する全 resolution を fail させる。adopted Space
  側の approval は catalog release change trigger で `invalidated` に落ちる
  ([Approval Invalidation Triggers](/reference/approval-invalidation) §5)。
- **publisher 未 enroll** (signature 自体は付いているが publisher 鍵が未登録):
  signature verify failure と同じ扱い。`implementation-unverified` Risk。
- **descriptor 改ざん検出** (digest が一致しない): hash 不一致で resolution
  fail-closed。

verify 失敗は ResolutionSnapshot を materialize しないため、副作用は
発生しない。operator は trust 失敗を解消するまで前進できない。

## Operator UX

CatalogRelease trust の operator surface は CLI ベースで提供する
([CLI](/reference/cli))。

- **enroll**: `takosumi catalog publisher enroll --key <pubkey>` 等の
  CLI で操作する。enrollment 成功で `publisher-key-enrolled` audit event。
- **rotate**: 新 publisher key の enroll は通常の `enroll` と同じ。旧 key
  の retire は `revoke` 経路に移す。
- **revoke**: `takosumi catalog publisher revoke --key <pubkey>` で
  revocation list に追加。即時反映され、依存 resolution が fail する。
  audit event `publisher-key-revoked`。
- **adopt**: Space に CatalogRelease を adopt するときは、kernel が verify
  を走らせ、結果を CLI に返す。fail なら adopt しない。成功で
  `catalog-release-adopted` audit event。
- **rotate adopted release**: 既 adopted Space に新 release を載せ替える
  操作は `catalog-release-rotated` audit event を発行し、approval は trigger
  5 (catalog release change) で再評価される。

## Audit events

trust model に関連する主要 audit event:

- `catalog-release-adopted` — Space が CatalogRelease を adopt した。
- `catalog-release-rotated` — adopted Space の release が変わった。
- `publisher-key-enrolled` — operator が publisher key を enroll した。
- `publisher-key-revoked` — operator が publisher key を revocation list
  に追加した。

詳細 envelope / payload は [Audit Events](/reference/audit-events) を参照。

## Trust 境界の責務分担

- kernel は **CatalogRelease tier のみ**を verify する。Connector /
  Implementation tier には触らない。これにより kernel が credential 値や
  runtime-side material を扱わずに済む。
- runtime-agent は **Connector tier と Implementation tier**を verify する。
  kernel が記録した CatalogRelease descriptor digest と integrity 上の
  rendezvous を取る。
- 3 tier それぞれが独立した signer / verifier の組を持つことで、1 tier
  の compromise が他 tier を即座に侵さない設計になる。

## Multi-publisher coexistence

operator は同一 kernel に複数 publisher を enroll できる。

- それぞれの publisher は独立した key set を持ち、CatalogRelease
  descriptor は単一 publisher で sign される。
- 異なる publisher が同じ shape / provider id について release を出して
  も、Space ごとに adopt する publisher は 1 つに固定される。同一 Space
  に複数 publisher の release を同時に adopt することはない。
- publisher 切り替えは `catalog-release-rotated` event を伴い、approval
  invalidation の trigger 5 を引く。

## Trust の境界での failure mode 整理

| Failure                              | Tier            | 検出主体        | 結果                                            |
| ------------------------------------ | --------------- | --------------- | ----------------------------------------------- |
| CatalogRelease signature 不正        | CatalogRelease  | kernel          | resolution fail-closed / `implementation-unverified` Risk |
| publisher key 未 enroll              | CatalogRelease  | kernel          | resolution fail-closed / `implementation-unverified` Risk |
| publisher key revoked                | CatalogRelease  | kernel          | 全依存 resolution fail / approval invalidated   |
| Connector signature 不正             | Connector       | runtime-agent   | runtime-agent 側で dispatch 拒否                |
| Implementation signature 不正        | Implementation  | runtime-agent   | runtime-agent 側で dispatch 拒否                |

kernel と runtime-agent はそれぞれの tier で独立に verify するため、
1 tier の failure を他 tier が暗黙に補正することはない。

## Invariants

- signature algorithm は Ed25519 で固定。
- publisher key は operator が enroll しない限り trust されない。
- verify 失敗は fail-closed。副作用なし。
- CatalogRelease descriptor digest は ResolutionSnapshot に記録され、
  approval binding に乗る。
- adopted release の rotation は approval の catalog release change trigger
  を引く。
- 1 Space に同時 adopt できる publisher は 1 つ。

## Related design notes

本文を読むのに design/ への参照は不要だが、設計の rationale は以下に残る。

- `docs/design/catalog-release-descriptor-model.md` — 3-tier trust chain と
  publisher key enroll / rotate / revoke の設計議論
- `docs/design/paas-provider-design.md` — provider plugin author signing
  と runtime-agent verification の境界 rationale
- `docs/design/operator-boundaries.md` — operator が trusted entity を
  enroll する surface と redaction trust boundary の議論
