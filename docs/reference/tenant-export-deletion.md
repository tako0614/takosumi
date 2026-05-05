# Tenant Export and Deletion

> Stability: stable Audience: operator, integrator, kernel-implementer See also:
> [Tenant Provisioning](/reference/tenant-provisioning),
> [Storage Schema](/reference/storage-schema),
> [Audit Events](/reference/audit-events),
> [Compliance Retention](/reference/compliance-retention),
> [Backup and Restore](/reference/backup-restore),
> [Secret Partitions](/reference/secret-partitions),
> [Space Export Share](/reference/space-export-share),
> [Artifact GC](/reference/artifact-gc),
> [Kernel HTTP API](/reference/kernel-http-api)

Takosumi v1 における tenant data export と Space deletion の kernel-side API。
顧客が自分の Space data を logical な形で取り出す経路 (data portability / GDPR
access 対応)、Space を退役させる経路 (soft-delete → hard-delete の 2-phase)、PII
field-level redaction、audit chain との 整合を固定する。本 reference は
wire-level API のみを定義し、顧客向け UI や承認 flow は扱わない。

::: info Current HTTP status The export, deletion, restore, deletion-confirm,
and redaction endpoints in this reference are a spec / service contract. The
current kernel HTTP router does not mount `/api/internal/v1/spaces/:id/exports`
or `DELETE /api/internal/v1/spaces/:id`; see
[Kernel HTTP API — Spec-Reserved Internal Surfaces](/reference/kernel-http-api#spec-reserved-internal-surfaces).
:::

## Data export API

Design-reserved operator-only internal control plane endpoint。caller は
[Kernel HTTP API](/reference/kernel-http-api) の internal HMAC credential を
保持する。

### `POST /api/internal/v1/spaces/:id/exports`

Request body:

```ts
interface SpaceExportRequest {
  readonly mode: ExportMode;
  readonly retentionRegime?: ComplianceRegime; // export artifact 自体の保持規定 (default: Space の regime)
  readonly metadata?: Record<string, string>;
}

type ExportMode =
  | "full"
  | "manifest-only"
  | "audit-only"
  | "data-portability";
```

Response:

```ts
interface SpaceExportResponse {
  readonly exportId: string; // "export:<id>" 形式
  readonly status: "queued" | "in-progress" | "completed" | "failed";
  readonly mode: ExportMode;
  readonly createdAt: string;
}
```

`Idempotency-Key` header は必須。同 key の再送は同 response を返す。

### `GET /api/internal/v1/spaces/:id/exports/:exportId`

export 1 件の status / progress / artifact reference を返す。

```ts
interface SpaceExportStatus {
  readonly exportId: string;
  readonly status: "queued" | "in-progress" | "completed" | "failed";
  readonly mode: ExportMode;
  readonly artifact?: {
    readonly hash: string; // "sha256:<hex>"
    readonly bytes: number;
    readonly downloadUrl: string; // short-TTL signed URL
    readonly expiresAt: string;
  };
  readonly failure?: {
    readonly errorCode: string;
    readonly message: string;
  };
}
```

完了 export は `artifact:<sha256>` 形式で kernel object storage に書かれ、
`downloadUrl` は短い TTL の signed URL で発行される。`downloadUrl` の TTL は
`TAKOSUMI_EXPORT_DOWNLOAD_URL_TTL_SECONDS` (default 3600) で operator
が設定する。TTL 経過後は同 endpoint で再取得する。

### `GET /api/internal/v1/spaces/:id/exports`

Space の export 履歴を cursor pagination で列挙する。

## Export mode

`mode` は closed enum で、追加には `CONVENTIONS.md` §6 RFC を要する。

| Mode               | 含まれる内容                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `full`             | Snapshot / Journal / Approval / RevokeDebt / SpaceExportShare reference / observation set / metadata の logical export。 |
| `manifest-only`    | 顧客が deploy した manifest body 集合 (resolved 前の declarative source)。                                               |
| `audit-only`       | 当 Space の audit log 全件 (chain hash 込み)。                                                                           |
| `data-portability` | 別 takosumi instance に import 可能な schema-versioned logical export。                                                  |

`full` と `data-portability` は重複する内容を持つが、`data-portability` は
import 想定の schema 安定性を保証する形式に正規化される。`full` は kernel 内部
layout を反映し、import 互換は保証しない (debugging / forensic 用)。

`manifest-only` は customer-recoverable な manifest 集合に絞った subset で、
顧客が別環境で deploy をやり直す用途を想定している。

`audit-only` は chain hash を含み、export artifact 単独で tamper-evidence を
verify できる。

## Export 整合

export は **point-in-time consistent** に作る。

- export 開始時点で対象 partition に share lock を取得し、export 中の write
  はそのまま進ませつつ snapshot isolation で読む。
- `Idempotency-Key` 単位で 1 つの consistent snapshot を共有する。
- secret partition は **encrypted reference** のみ含める。raw value は
  含まれない。受け手が master key を別経路で保持している前提で、master key
  自体は本 export には含めない。
- cross-Space data は SpaceExportShare の **reference** のみ含み、 reference 先
  Space の中身は含めない。これは
  [Space Export Share](/reference/space-export-share) の cross-Space link
  denial-by-default と整合させるため。

## Space deletion

Space deletion は **2-phase**: soft-delete → hard-delete。

### `DELETE /api/internal/v1/spaces/:id`

Request body:

```ts
interface SpaceDeleteRequest {
  readonly confirmCode: string; // 直前の status response が返す single-use code
  readonly retentionRegime?: ComplianceRegime; // hard-delete 後の audit retention 適用 regime (default: Space の regime)
  readonly reason?: string;
}
```

`confirmCode` は `GET /api/internal/v1/spaces/:id/deletion-confirm` で
発行される single-use code で、operator の意図確認を強制する。code TTL は
`TAKOSUMI_SPACE_DELETE_CONFIRM_TTL_SECONDS` (default 600) で operator が
設定する。

### Soft-delete

- Space を `frozen` 状態に置く。write API はすべて HTTP `409 Conflict` で
  reject、read API のみ通る。
- soft-delete 期間は `TAKOSUMI_SPACE_SOFT_DELETE_RETENTION_DAYS` (default 30) で
  operator が設定する。期間内は **復活可能** で、復活経路は
  `POST /api/internal/v1/spaces/:id/restore`。
- soft-delete 中の Space は quota counter から外される (新たな usage
  集計を発生させない) が、artifact-storage-bytes は依然 occupy する。
- 復活すると frozen は解除され、quota counter に再 join する。

### Hard-delete

soft-delete 期間経過後、または operator が即時 hard-delete を要求した ときに
hard-delete が走る。

- artifact / DataAsset を [Artifact GC](/reference/artifact-gc) の通常経路で GC
  対象に積む。当該 Space からのみ参照されている artifact は sweep で
  消える。dedup で他 Space からも参照されていれば残る。
- secret partition を revoke する。secret partition の master key は destroyed
  scheduled で wipe され、residual encrypted blob は読めなくなる。
- audit log は **compliance retention に従い保持** する。記録自体は残り、 raw
  artifact / journal payload は破棄され、redaction policy 後の metadata と chain
  hash が残る。retention window は
  [Compliance Retention](/reference/compliance-retention) の regime に従う。
- hard-delete 後、Space ID は再利用しない。

## Right-to-erasure (GDPR)

GDPR right-to-erasure 要求は通常の Space deletion と独立した経路を取る。
これは「Space は残したまま個別 PII を消したい」要求に対応するため。

- `POST /api/internal/v1/spaces/:id/redactions` で PII field 単位の redaction
  を要求する。
- redaction は **field-level** で、対象 audit event の payload から指定 field を
  tombstone に置き換える。
- audit chain hash は **維持** する。redaction は payload bytes を変えるが、
  chain は redaction event 自体を新 entry として記録し、`prevHash` の
  連続性は途切れない。tamper-evidence と erasure 要求を両立させる。
- redaction 対象 field は closed list で、追加は `CONVENTIONS.md` §6 RFC
  を要する。詳細 field 集合は
  [Compliance Retention](/reference/compliance-retention) と cross-link する。

redaction と Space hard-delete は独立で、両方の audit event が emit される。

## Configuration

export / deletion 周辺は以下の環境変数で operator が設定する。

| Variable                                    | Type    | Default | Notes                                              |
| ------------------------------------------- | ------- | ------- | -------------------------------------------------- |
| `TAKOSUMI_EXPORT_DOWNLOAD_URL_TTL_SECONDS`  | integer | `3600`  | export artifact signed URL の TTL。                |
| `TAKOSUMI_EXPORT_MAX_CONCURRENT_PER_SPACE`  | integer | `1`     | 同時 in-progress export 件数。                     |
| `TAKOSUMI_SPACE_DELETE_CONFIRM_TTL_SECONDS` | integer | `600`   | `confirmCode` の TTL。                             |
| `TAKOSUMI_SPACE_SOFT_DELETE_RETENTION_DAYS` | integer | `30`    | soft-delete 復活窓の長さ。                         |
| `TAKOSUMI_SPACE_HARD_DELETE_AUTO_RUN`       | boolean | `true`  | soft-delete window 経過で自動 hard-delete を起動。 |

`TAKOSUMI_SPACE_HARD_DELETE_AUTO_RUN=false` の operator は window 経過後の
hard-delete を別途 trigger する。`true` のときは kernel の background worker が
window 通過後に自動 hard-delete を進める。どちらの mode でも hard-delete
自体の挙動は同じで、操作経路が違うだけ。

## Audit events

export / deletion lifecycle に関連する audit event
([Audit Events](/reference/audit-events)):

- `space-export-started` — export request が queue / in-progress に入った。
- `space-export-completed` — export artifact 発行完了。
- `space-export-failed` — export が `failed` 状態で確定。
- `space-soft-deleted` — Space が `frozen` に遷移。
- `space-restored` — soft-delete から復活。
- `space-hard-deleted` — hard-delete 完了 (artifact GC / secret revoke / audit
  redaction を含む)。
- `space-redaction-applied` — GDPR field-level redaction が反映された。

各 event payload は `spaceId` / `exportId` (該当時) / `mode` (export 時) /
`retentionRegime` / 失敗時は `errorCode` を保持する。

## Invariants

- export は point-in-time consistent で、secret partition は encrypted reference
  のみ含む。
- export mode は 4 値 closed。
- Space deletion は soft-delete → hard-delete の 2-phase で、 `confirmCode`
  必須。
- soft-delete 期間内は復活可能、hard-delete 後の Space ID は再利用しない。
- GDPR redaction は field-level で、audit chain hash は維持される。

## kernel 範囲と外側の境界

本 reference は data export と Space deletion の wire-level API のみを
定義する。顧客向け export download UX、deletion 確認 modal、support
escalation、サブスクリプション解約 flow、退会後の data portability guarantee
の文面化等は takosumi の範囲外で、operator が `takos-private/`
等の外側で実装する。kernel は idempotent な internal API、closed export
mode、2-phase deletion、redaction primitive を提供する。

## Related architecture notes

- `docs/reference/architecture/space-model.md` — Space deletion semantics と
  soft-delete の復活窓に関する rationale
- `docs/reference/architecture/observation-drift-revokedebt-model.md` — Space
  退役時の RevokeDebt 残処理と export の関係
- `docs/reference/architecture/operator-boundaries.md` — kernel が公開する
  export / deletion primitive と operator policy 層の責務分担
