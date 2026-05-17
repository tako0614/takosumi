# Shape Catalog

> このページでわかること: Shape catalog の一覧と各 shape の spec フィールド。

**Shape** は v1 abstract resource type で、 manifest が宣言し [provider plugin](/reference/providers) が materialize する。 各 shape は 3 つを pin する: 入力 `Spec` schema、 固定 `outputFields` 集合、 provider が selectable になるために宣伝すべき capability vocabulary。

Shape は Takosumi catalog が所有する。 新 shape の追加はエコシステムへの破壊的変更で、 `CONVENTIONS.md` §6 RFC を要する。 新しいクラウド対応は shape を fork するのではなく、 既存 shape に **provider** を追加することで提供される。

Source: `packages/contract/src/shape.ts` (contract と registry)、 `packages/plugins/src/shapes/<shape>.ts` (bundled 5 種)。

## Capability extension guide

capability は **open string**。 catalog は集合を closed enum に**ロックしない**。 v1 の規則は open string + reserved prefix。

| Prefix       | Owner                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `takos.*`    | consumer-application reserved namespace (e.g. Takos product surface); kernel assumes no Takos-specific semantics |
| `system.*`   | Takosumi kernel / runtime-agent / observation tier                                                               |
| `operator.*` | Operator-defined deployment-local capabilities                                                                   |

provider は `capabilities` に任意の kebab-case 識別子を宣言できる。 manifest は `requires` で任意の kebab-case 識別子を参照できる。 selection は subset 所属だけを検証する。 bundled shape と並んで export される closed `*Capability` union 型は compile-time check の便宜であり、contract ではない — runtime は `capabilities` を `readonly string[]` として扱う。

新 reserved prefix の追加、または `takos.*` / `system.*` 下の識別子追加は §6 RFC を要する。 `operator.*` は単一 deployment 内で operator が自由に使える。

## outputFields reserved names

5 つの field 名は catalog 横断で **reserved** され、 consumer manifest はどの provider が走っても安定 semantics に依存できる。

| reserved name | meaning                                                         |
| ------------- | --------------------------------------------------------------- |
| `url`         | scheme-bearing public URL (`https://...`)                       |
| `endpoint`    | scheme-bearing service / API endpoint URL                       |
| `status`      | reserved for shape-level health surfaces; not used by v1 shapes |
| `id`          | provider-scope identifier                                       |
| `version`     | provider-scope version / revision identifier                    |

これらの名前の field を expose する新 shape は reserved meaning を使う。 新 reserved name の追加は §6 RFC。

## Catalog

| Shape id            | version | summary                                                             |
| ------------------- | ------- | ------------------------------------------------------------------- |
| `object-store`      | `v1`    | Bucket-style object storage; provider-portable across S3-class APIs |
| `web-service`       | `v1`    | Long-running HTTP service backed by an OCI image or equivalent      |
| `database-postgres` | `v1`    | Managed PostgreSQL instance (wire-protocol portable)                |
| `custom-domain`     | `v1`    | DNS + TLS-terminated public domain                                  |
| `worker`            | `v1`    | Serverless JS function backed by a `js-bundle` artifact             |

下記 lifecycle persistence 列の表記は、 v1 object lifecycle class (managed / generated / external / operator / imported) を使う。 同梱 shape では、すべての output field は **generated** — provider が apply 中に値を書き、 kernel はそれを `${ref:...}` consume 用の resolved output マップに永続化する。

## `object-store@v1`

S3-compatible bucket-style storage.

### Spec summary

```ts
interface ObjectStoreSpec {
  readonly name: string;
  readonly public?: boolean;
  readonly versioning?: boolean;
  readonly region?: string;
  readonly lifecycle?: {
    readonly expireAfterDays?: number;
    readonly archiveAfterDays?: number;
  };
}
```

`name` は必須かつ非空。他は optional で、未設定なら provider default が適用される。

### outputFields

| field          | type   | nullable | lifecycle persistence |
| -------------- | ------ | -------- | --------------------- |
| `bucket`       | string | no       | generated             |
| `endpoint`     | string | no       | generated             |
| `region`       | string | no       | generated             |
| `accessKeyRef` | string | no       | generated             |
| `secretKeyRef` | string | no       | generated             |

### Declared capabilities (catalog vocabulary)

`versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `event-notifications`, `lifecycle-rules`, `multipart-upload`.

## `web-service@v1`

OCI image (または provider が受け入れる他の artifact) で driven する長時間稼働 HTTP service。

### Spec summary

```ts
interface WebServiceSpec {
  readonly image?: string; // shorthand for { artifact: { kind: "oci-image", uri: image } }
  readonly artifact?: Artifact; // preferred; { kind, uri | hash }
  readonly port: number;
  readonly scale: { min: number; max: number; idleSeconds?: number };
  readonly env?: Readonly<Record<string, string>>;
  readonly bindings?: Readonly<Record<string, string>>;
  readonly health?: {
    path: string;
    intervalSeconds?: number;
    timeoutSeconds?: number;
  };
  readonly resources?: { cpu?: string; memory?: string };
  readonly command?: readonly string[];
  readonly domains?: readonly string[];
}
```

`image` か `artifact` のどちらかを set する。 `bindings` は他 resource output に対して resolve される `${ref:...}` を受け入れる。 `env` は plain literal。

### outputFields

| field          | type   | nullable | lifecycle persistence |
| -------------- | ------ | -------- | --------------------- |
| `url`          | string | no       | generated             |
| `internalHost` | string | no       | generated             |
| `internalPort` | number | no       | generated             |

### Declared capabilities

`always-on`, `scale-to-zero`, `websocket`, `long-request`, `sticky-session`, `geo-routing`, `private-networking`.

## `database-postgres@v1`

wire-protocol portability のある managed PostgreSQL。

### Spec summary

```ts
interface DatabasePostgresSpec {
  readonly version: string;
  readonly size: "small" | "medium" | "large" | "xlarge";
  readonly storage?: { sizeGiB: number; type?: "ssd" | "hdd" };
  readonly backups?: { enabled: boolean; retentionDays?: number };
  readonly highAvailability?: boolean;
  readonly extensions?: readonly string[];
}
```

### outputFields

| field               | type   | nullable | lifecycle persistence |
| ------------------- | ------ | -------- | --------------------- |
| `host`              | string | no       | generated             |
| `port`              | number | no       | generated             |
| `database`          | string | no       | generated             |
| `username`          | string | no       | generated             |
| `passwordSecretRef` | string | no       | generated             |
| `connectionString`  | string | no       | generated             |

### Declared capabilities

`pitr`, `read-replicas`, `high-availability`, `backups`, `ssl-required`, `ipv6`, `extensions`.

## `custom-domain@v1`

DNS record と public domain の TLS termination。 典型 pattern は `target: "${ref:<webservice>.url}"` で `web-service@v1` output に pin する。

### Spec summary

```ts
interface CustomDomainSpec {
  readonly name: string; // FQDN
  readonly target: string; // typically ${ref:<webservice>.url}
  readonly certificate?: {
    kind: "auto" | "managed" | "provided";
    secretRef?: string;
  };
  readonly redirects?: readonly {
    from: string;
    to: string;
    code?: 301 | 302 | 307 | 308;
  }[];
}
```

### outputFields

| field            | type     | nullable | lifecycle persistence |
| ---------------- | -------- | -------- | --------------------- |
| `fqdn`           | string   | no       | generated             |
| `certificateArn` | string   | yes      | generated             |
| `nameservers`    | string[] | yes      | generated             |

### Declared capabilities

`wildcard`, `auto-tls`, `sni`, `http3`, `alpn-acme`, `redirects`.

## `worker@v1`

upload された `js-bundle` artifact で動く serverless JS function。 `web-service@v1` と異なり、 `artifact.kind` は exactly `js-bundle` で `artifact.hash` が必須 (外部 `uri` なし)。

### Spec summary

```ts
interface WorkerSpec {
  readonly artifact: Artifact; // kind: "js-bundle", hash required
  readonly compatibilityDate: string; // e.g. "2025-01-01"
  readonly compatibilityFlags?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly routes?: readonly string[];
}
```

### outputFields

| field        | type   | nullable | lifecycle persistence |
| ------------ | ------ | -------- | --------------------- |
| `url`        | string | no       | generated             |
| `scriptName` | string | no       | generated             |
| `version`    | string | yes      | generated             |

### Declared capabilities

`scale-to-zero`, `websocket`, `long-request`, `geo-routing`.

## Catalog extension

新 shape の追加、 `outputFields` reserved-name 集合の拡張、 新 reserved capability prefix の導入は、 すべて同じ `CONVENTIONS.md` §6 RFC を通る。 既存 shape への新 provider 追加は標準 non-RFC path で、 新クラウド対応の正しい道具。

## Catalog scope と plugin extension

Kernel curated catalog は v1 で 5 shape (`object-store@v1` / `web-service@v1` / `database-postgres@v1` / `custom-domain@v1` / `worker@v1`) に閉じる。 新 shape の追加は `CONVENTIONS.md` §6 RFC で coordinate される。

Workflow / cron / lifecycle hook 等の shape は current v1 catalog / plugin extension surface に含めない。 `cron-job@v1` / `workflow-job@v1` は reserved vocabulary であり、 current kernel は通常の `resources[]` として受け付けない。 Git / webhook / build / schedule / deployment hook は `takosumi-git` 等の installer/helper surface の責務。 詳細な placement は [Extending the Shape Model](/extending) と [Workflow Placement Rationale](/reference/architecture/workflow-extension-design) を参照。

## Cross-references

- [Access Modes](/reference/access-modes) — consumer に target を expose する shape output 向けの closed v1 access mode enum (`read` / `read-write` / `admin` / `invoke-only` / `observe-only`)、 grant 生成 export の `safeDefaultAccess` contract。
- [Closed Enums](/reference/closed-enums) — shape output を制約する完全な v1 closed enum index (object lifecycle class、mutation constraint、link mutation)。
- [Connector Contract](/reference/connector-contract) — `connector:<id>` identity と shape output が連携する artifact 受け渡し境界。
- `CONVENTIONS.md` §6 RFC (takosumi repo root) — shape catalog、 reserved outputField、 reserved capability prefix の RFC プロセス。
- [Workflow Placement Rationale](/reference/architecture/workflow-extension-design) — workflow / trigger / hook / execute-step を kernel から外し上位 product に寄せる設計 rationale。
- [Extending the Shape Model](/extending) — provider / template / new-shape extension flow。

## 関連ページ

- [Provider Plugins](/reference/providers)
- [Access Modes](/reference/access-modes)
- [Closed Enums](/reference/closed-enums)
