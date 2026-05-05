# Secret Partitions

> Stability: stable Audience: operator See also:
> [Environment Variables](/reference/env-vars), [CLI](/reference/cli),
> [Cross-Process Locks](/reference/cross-process-locks),
> [Migration / Upgrade](/reference/migration-upgrade),
> [Audit Events](/reference/audit-events)

Takosumi v1 における secret partition の正式仕様。Space ごとの分離、AES-GCM
暗号化方式、HKDF salt 派生、AAD verify による partition tag swap detection、
multi-cloud override env catalog、partition rotation の運用 protocol を定義
する。kernel core が raw secret を保持しないという trust 境界はここで決まる。

## Partition model

secret partition は **Space と cloud partition tag の組** に対して 1:1 で
分離される、独立した暗号箱である。kernel core は partition の中身を直接
保持せず、各 partition から復号を行う際に partition key を一時的に derive
するだけで動く。

| 概念              | 内容                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------ |
| Space             | secret partition の **scope owner**。Space を消すと partition も消える               |
| partition tag     | cloud / runtime kind (`aws` / `gcp` / `cloudflare` / `azure` / `k8s` / `selfhosted`) |
| partition key     | `(spaceId, partitionTag)` から derive される 256-bit AES-GCM 用 key                  |
| master passphrase | env (後述) から取得する partition key の seed                                        |
| generation        | partition rotation の世代 counter (整数、increment-only)                             |

不変条件:

- 同一 `(spaceId, partitionTag)` でも generation が違えば partition key は
  異なる。世代越し復号は AAD verify で fail する。
- kernel core は raw secret value を memory にも disk にも保持しない。 decrypt
  は **request scope** に閉じる。decrypt 結果を keep する側 (connector /
  runtime-agent) が secret hygiene を負う。
- partition の cross 参照は禁止。reference (`${secret:...}`) は許されるが、 raw
  value を Space 間で運ぶ運用は不可。

## Encryption scheme

すべての partition entry は AES-GCM (256-bit) で暗号化される。

### Key derivation

partition key は HKDF-SHA256 で derive する。

- IKM (input key material): master passphrase (env から取得)
- salt:
  `HKDF salt = HMAC-SHA256("takosumi.secret-partition.v1", spaceId || partitionTag)`
- info:
  `"takosumi.secret-partition.v1/" + spaceId + "/" + partitionTag + "/g" + generation`
- output: 32 bytes (256-bit AES key)

salt が `(spaceId, partitionTag)` から derive されるため、master passphrase
が同じでも Space や cloud partition が違えば独立 key になる。`info` に
generation を含めることで rotation 時の世代分離が成立する。

### AAD (Additional Authenticated Data)

各 ciphertext には以下の AAD を結合して GCM tag を計算する:

```
AAD = "takosumi.secret-partition.v1"
   || 0x1F || spaceId
   || 0x1F || partitionTag
   || 0x1F || generation
   || 0x1F || entryKey
```

AAD verify が失敗したケースは `secret_partition_tag_swap` error code で
fail-closed する。具体的には以下が検出される:

- partition tag swap (`aws` の ciphertext を `gcp` partition で復号しようとした)
- generation mismatch (旧世代の ciphertext を新世代 key で復号しようとした)
- entry key tampering (storage 層で key 部分だけ書き換えられた)
- Space cross-link (別 Space の ciphertext を流し込まれた)

### Nonce

GCM nonce は 96-bit ランダムを entry ごとに生成する。同 partition / 同 key での
nonce 再利用は **記録ごとに禁止**。kernel は nonce を ciphertext header
に保存し、decrypt 時にそのまま読み戻す。

## Env override catalog

master passphrase は env から取得される。優先順位は **cloud-specific > global**
で、partition tag が `aws` の partition は AWS 専用 env が
あればそれを使い、無ければ global にフォールバックする。

| Env                                           | 用途                                          |
| --------------------------------------------- | --------------------------------------------- |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE`            | global default。すべての partition の seed 元 |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE_AWS`        | AWS partition 専用 master passphrase          |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE_GCP`        | GCP partition 専用                            |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE_CLOUDFLARE` | Cloudflare partition 専用                     |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE_AZURE`      | Azure partition 専用                          |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE_K8S`        | Kubernetes partition 専用                     |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE_SELFHOSTED` | self-hosted runtime 用 partition 専用         |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE_NEXT`       | rotation 中の new-generation passphrase       |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE_<TAG>_NEXT` | rotation 中の cloud-specific new passphrase   |

resolution rule:

1. partition tag に対応する `..._<TAG>` env が set されていればそれを使う
2. 無ければ `TAKOSUMI_SECRET_STORE_PASSPHRASE` (global) を使う
3. どちらも未設定で、当該 partition に entry が存在する場合は kernel boot が
   `readiness_probe_failed` で停止する

env を一切使わずに `factories.ts` 経由で passphrase resolver を inject する
deployment も可能だが、その場合も resolver の優先順位はこの順序に従う。

## Multi-cloud partition boundary

cloud ごとに partition を分ける目的は **blast radius の遮断** である。

- AWS credential が漏れても GCP / Cloudflare / Azure / K8s / self-hosted の
  partition は復号されない (key が独立、AAD でも分離)
- cloud-specific passphrase rotation を独立に実施できる (other partition は
  影響を受けない)
- audit / compliance scope を cloud 単位で切れる (PCI-DSS / HIPAA / SOX で scope
  を絞りたい partition だけを再暗号化対象にできる)

cross-partition 参照ルール:

- `${secret:...}` などの reference は別 partition / 別 Space を指して **よい**
  (kernel が解決時に対応 partition を decrypt する)
- raw value を別 partition の entry として複製するのは禁止 (operator policy
  違反として audit に記録される)
- runtime-agent には decrypt 済み value がそのまま渡るが、agent 側は
  `manifest digest` 単位で短命 buffer に置くだけで永続化しない

## Partition rotation

rotation は `(spaceId, partitionTag)` 単位で実施し、世代 counter を 1 増やして全
entry を re-encrypt する。

### Rotation sequence

1. operator が `TAKOSUMI_SECRET_STORE_PASSPHRASE_NEXT` (または cloud-specific
   `..._<TAG>_NEXT`) を set し、kernel に rotation 開始を request する
2. kernel は old + new の 2 世代 key を **並走** させる:
   - decrypt は AAD の generation に応じて old / new どちらかの key を選ぶ
   - encrypt は新規 entry にも update entry にも new generation を使う
3. background worker が partition 内の old-generation entry を順次 re-encrypt
   する。world view は entry 単位で更新される (atomic per entry)
4. 全 entry の re-encrypt が完了すると generation pointer を new に確定する
5. operator が `..._NEXT` env を解除し、`TAKOSUMI_SECRET_STORE_PASSPHRASE`
   (または cloud-specific) を new passphrase に置き換える
6. kernel は old generation の key derive を停止し、old key を破棄する

rotation 中の不変条件:

- `apply` / `activate` / `destroy` / `rollback` は rotation 進行中も継続して
  動く。decrypt path は world view を読み、encrypt path は new generation を
  書く
- rotation は idempotent。途中で kernel が再起動しても、未完了の entry を
  再開する。完了済み entry は AAD verify で skip 判定される

### Audit

rotation の各 step は audit event として記録される:

- `secret-partition-rotation-started` (`spaceId` / `partitionTag` /
  `from-generation` / `to-generation`)
- `secret-partition-rotation-progress` (entry 件数進捗、定期 emit)
- `secret-partition-rotation-completed` (古い key を破棄した時点で emit)
- `secret-partition-rotation-aborted` (operator が中止した場合 / 致命エラー
  で停止した場合)

audit chain は [Audit Events](/reference/audit-events) の hash chain に
連結される。rotation 中は同 partition への新規 rotation 開始を fail-closed で
reject する (`cross_process_lock_busy`)。

## Operator workflow

Current public CLI does not expose a secret-rotation subcommand. A production
operator should drive this through internal control-plane tooling or deployment
automation. 要約のみ:

1. operator が new passphrase を `..._NEXT` env に注入する
2. `takosumi server` (または kernel deployment) を再起動して new env を pick up
   させる
3. internal control-plane operation で対象 Space / partition の rotation を kick
   する
4. operator tooling が rotation 完了を polling し、`completed` を確認したら
   `..._NEXT` を解除し、main passphrase env を更新する
5. operator tooling で current generation を確認する

rotation を skip して passphrase を直接書き換えると AAD verify が一斉に fail
し、当該 partition の secret が **すべて読めなくなる** ため、必ず rotation flow
を経由する必要がある。

## Failure modes

| 状況                                  | error code                          | 復旧                                  |
| ------------------------------------- | ----------------------------------- | ------------------------------------- |
| master passphrase 未設定              | `readiness_probe_failed`            | env を設定して kernel を再起動        |
| AAD generation mismatch               | `secret_partition_tag_swap`         | rotation flow を最初からやり直す      |
| AAD partition tag mismatch            | `secret_partition_tag_swap`         | partition の取り違えを修正            |
| nonce reuse 検出                      | `secret_partition_invariant_broken` | partition 全体を rotate して救済      |
| rotation 途中で `..._NEXT` を解除した | `cross_process_lock_busy`           | `..._NEXT` を再注入して rotation 再開 |

## Related architecture notes

関連 architecture notes:

- `docs/reference/architecture/operator-boundaries.md` — kernel core が raw
  secret を持た ない trust 境界の rationale
- `docs/reference/architecture/space-model.md` — partition の scope owner が
  Space である 理由と Space 削除時の partition lifecycle
- `docs/reference/architecture/policy-risk-approval-error-model.md` — secret
  関連 risk taxonomy と approval invalidation の interplay
