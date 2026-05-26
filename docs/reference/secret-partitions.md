# Secret Partitions

::: info
内部設計メモ public contract は [Installer API](./installer-api.md) を参照。
:::

The operator manages secret storage, partitioning, rotation, and runtime delivery.

## Partition model

secret partition は **Space と operator-defined partition tag の組** に対して 1:1 で分離される独立した暗号箱である。Takosumi core は partition の中身を永続化したり cache したりしない。各 partition から復号する際に partition key を request scope で一時的に derive する。

| 概念              | 内容                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------ |
| Space             | secret partition の **scope owner**。Space を消すと partition も消える               |
| partition tag     | operator-defined string。例: `aws` / `gcp` / `cloudflare` / `k8s` / `local-adapters` |
| partition key     | `(spaceId, partitionTag)` から derive される 256-bit AES-GCM 用 key                  |
| master passphrase | env (後述) から取得する partition key の seed                                        |
| generation        | partition rotation の世代 counter (整数、increment-only)                             |

不変条件:

- 同一 `(spaceId, partitionTag)` でも generation が違えば partition key は異なる。世代越し復号は AAD verify で fail する。
- Takosumi core は raw secret value を永続化、cache、log しない。 decrypt は **request scope** に閉じ、transient buffer を越えて保持しない。 decrypt 結果を受け取る connector / runtime-agent は、自分の process lifetime、zeroization、 log rejection の責務を負う。
- partition / Space を跨ぐ raw value の複製は禁止。`${secret:...}` reference は caller Space 内の partition entry だけを指せる。
- implementation binding / connector 実行に渡せる credential ref は `secret://providers/<provider>` scope に限定される。runtime secret (`secret://runtime/...` など) や他 backend の credential ref は materialization 前に fail-closed し、implementation binding には渡らない。
- Deployment outputs、platform service evidence、Installation export bundle は public/non-secret projection だけを持つ。raw token / password / private key / backend credential は `secretRef` / `configRef` の背後に置き、output や export へ混入した場合は redaction ではなく reject を標準動作にする。

## Encryption scheme

すべての partition entry は AES-GCM (256-bit) で暗号化される。

### Key derivation

partition key は HKDF-SHA256 で derive する。

- IKM (input key material): master passphrase (env から取得)
- salt: `HKDF salt = HMAC-SHA256("takosumi.secret-partition.v1", spaceId || partitionTag)`
- info: `"takosumi.secret-partition.v1/" + spaceId + "/" + partitionTag + "/g" + generation`
- output: 32 bytes (256-bit AES key)

salt が `(spaceId, partitionTag)` から derive される。 master passphrase が同じでも Space や partition tag が違えば独立 key になる。 `info` に generation を含めることで rotation 時の世代分離が成立する。

### AAD (Additional Authenticated Data)

各 ciphertext には以下の AAD を結合して GCM tag を計算する:

```
AAD = "takosumi.secret-partition.v1"
   || 0x1F || spaceId
   || 0x1F || partitionTag
   || 0x1F || generation
   || 0x1F || entryKey
```

AAD verify 失敗は `secret_partition_tag_swap` error code で fail-closed する。検出されるケース:

- partition tag swap (`aws` の ciphertext を `gcp` partition で復号しようとした)
- generation mismatch (旧世代の ciphertext を新世代 key で復号しようとした)
- entry key tampering (storage 層で key 部分だけ書き換えられた)
- Space cross-link (別 Space の ciphertext を流し込まれた)

### Nonce

GCM nonce は 96-bit ランダムを entry ごとに生成する。同 partition / 同 key での nonce 再利用は **記録ごとに禁止**。 Takosumi は nonce を ciphertext header に保存し、 decrypt 時にそのまま読み戻す。

## Env override registry

master passphrase は env から取得される。優先順位は **tag-specific > global**。 partition tag が `aws` の partition は `..._AWS` env があればそれを使い、無ければ global にフォールバックする。下表の provider 名は reference operator examples です。operator が別 tag を使う場合は uppercase `[A-Z0-9_]+` に正規化した `TAKOSUMI_SECRET_STORE_PASSPHRASE_<TAG>` を使います。

| Env                                               | 用途                                          |
| ------------------------------------------------- | --------------------------------------------- |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE`                | global default。すべての partition の seed 元 |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE_AWS`            | AWS partition 専用 master passphrase          |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE_GCP`            | GCP partition 専用                            |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE_CLOUDFLARE`     | Cloudflare partition 専用                     |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE_AZURE`          | Azure partition 専用                          |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE_K8S`            | Kubernetes partition 専用                     |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE_LOCAL_ADAPTERS` | local-adapters partition 専用                 |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE_NEXT`           | rotation 中の new-generation passphrase       |
| `TAKOSUMI_SECRET_STORE_PASSPHRASE_<TAG>_NEXT`     | rotation 中の tag-specific new passphrase     |

resolution rule:

1. partition tag に対応する `..._<TAG>` env が set されていればそれを使う
2. 無ければ `TAKOSUMI_SECRET_STORE_PASSPHRASE` (global) を使う
3. どちらも未設定で、当該 partition に entry が存在する場合は Takosumi boot が `readiness_probe_failed` で停止する

env を一切使わずに `factories.ts` 経由で passphrase resolver を inject する deployment も可能。その場合も resolver の優先順位はこの順序に従う。

## Partition tag boundary

partition tag ごとに partition を分ける目的は **blast radius の遮断** である。

- `aws` credential が漏れても `gcp` / `cloudflare` / `k8s` / `local-adapters` など別 tag の partition は復号されない (key が独立、 AAD でも分離)
- tag-specific passphrase rotation を独立に実施できる (other partition は影響を受けない)
- audit / compliance scope を tag 単位で切れる (PCI-DSS / HIPAA / SOX で scope を絞りたい partition だけを再暗号化対象にできる)

secret reference 参照ルール:

- `${secret:...}` などの reference は caller Space 内の partition entry だけを指す。effective `spaceId` が caller context と異なる secret URI は reject。
- 同一 Space 内で別 partition を参照する場合も、operator policy が許可した credential class だけを connector / runtime-agent に渡す。
- raw value を別 partition の entry として複製するのは禁止 (operator policy 違反として audit に記録される)
- runtime-agent には decrypt 済み value がそのまま渡る。agent 側は manifest digest 単位で短命 buffer に置くだけで永続化しない
- export/import で別 operator に移す場合、source operator の partition tag を target operator の tag に map するか、map できない entry を reject する。raw secret value を export bundle に入れて tag 差し替えで移植することはしない。

## Partition rotation

rotation は `(spaceId, partitionTag)` 単位で実施する。世代 counter を 1 増やして全 entry を re-encrypt する。

### Rotation sequence

1. operator が `TAKOSUMI_SECRET_STORE_PASSPHRASE_NEXT` (または tag-specific `..._<TAG>_NEXT`) を set し、 Takosumi に rotation 開始を request する
2. Takosumi は old + new の 2 世代 key を **並走** させる:
   - decrypt は AAD の generation に応じて old / new どちらかの key を選ぶ
   - encrypt は新規 entry にも update entry にも new generation を使う
3. background worker が partition 内の old-generation entry を順次 re-encrypt する。 world view は entry 単位で更新される (atomic per entry)
4. 全 entry の re-encrypt が完了すると generation pointer を new に確定する
5. operator が `..._NEXT` env を解除し、 `TAKOSUMI_SECRET_STORE_PASSPHRASE` (または tag-specific env) を new passphrase に置き換える
6. Takosumi は old generation の key derive を停止し、 old key を破棄する

rotation 中の不変条件:

- `apply` / `activate` / `destroy` / `rollback` は rotation 進行中も継続して動く。 decrypt path は world view を読み、 encrypt path は new generation を書く
- rotation は idempotent。途中で Takosumi が再起動しても、未完了の entry を再開する。完了済み entry は AAD verify で skip 判定される

### Audit

rotation の各 step は audit event として記録される:

- `secret-partition-rotation-started` (`spaceId` / `partitionTag` / `from-generation` / `to-generation`)
- `secret-partition-rotation-progress` (entry 件数進捗、定期 emit)
- `secret-partition-rotation-completed` (古い key を破棄した時点で emit)
- `secret-partition-rotation-aborted` (operator が中止した場合 / 致命エラーで停止した場合)

audit chain は [Audit Events](./audit-events.md) の hash chain に連結される。 rotation 中は同 partition への新規 rotation 開始を fail-closed で reject する (`cross_process_lock_busy`)。

## Operator workflow

current public CLI には secret-rotation subcommand は無い。 production operator は internal control-plane tooling や deployment automation で drive する。要約:

1. operator が new passphrase を `..._NEXT` env に注入する
2. `takosumi server` (または Takosumi deployment) を再起動して new env を pick up させる
3. internal control-plane operation で対象 Space / partition の rotation を kick する
4. operator tooling が rotation 完了を polling し、 `completed` を確認したら `..._NEXT` を解除し、 main passphrase env を更新する
5. operator tooling で current generation を確認する

::: warning
rotation を skip して passphrase を直接書き換えると AAD verify が一斉に fail し、当該 partition の secret が **すべて読めなくなる**。必ず rotation flow を経由すること。
:::

## Failure modes

| 状況                                  | error code                          | 復旧                                  |
| ------------------------------------- | ----------------------------------- | ------------------------------------- |
| master passphrase 未設定              | `readiness_probe_failed`            | env を設定して Takosumi を再起動      |
| AAD generation mismatch               | `secret_partition_tag_swap`         | rotation flow を最初からやり直す      |
| AAD partition tag mismatch            | `secret_partition_tag_swap`         | partition の取り違えを修正            |
| nonce reuse 検出                      | `secret_partition_invariant_broken` | partition 全体を rotate して救済      |
| rotation 途中で `..._NEXT` を解除した | `cross_process_lock_busy`           | `..._NEXT` を再注入して rotation 再開 |

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — Takosumi core が raw secret reference で扱う trust 境界の rationale
- `docs/reference/architecture/space-model.md` — partition の scope owner が Space である理由と Space 削除時の partition lifecycle
- `docs/reference/architecture/approval-model.md` — secret 関連 risk taxonomy と approval invalidation の interplay

## 関連ページ

- [Environment Variables](./env-vars.md)
- [CLI](./cli.md)
- [Cross-Process Locks](./cross-process-locks.md)
- [Schema Evolution](./migration-upgrade.md)
- [Audit Events](./audit-events.md)
