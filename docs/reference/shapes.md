# Shape Catalog

> Stability: stable Audience: integrator See also:
> [Provider Plugins](/reference/providers),
> [Access Modes](/reference/access-modes),
> [Closed Enums](/reference/closed-enums)

A **Shape** is the v1 abstract resource type that a manifest declares and a
[provider plugin](/reference/providers) materializes. Each shape pins three
things: an input `Spec` schema, a fixed `outputFields` set, and a capability
vocabulary the provider must advertise to be selectable.

Shapes are owned by the Takosumi catalog. Adding a new shape is a breaking
change to the ecosystem and requires a `CONVENTIONS.md` §6 RFC. New cloud
support is delivered by adding **providers** for an existing shape, not by
forking shapes.

Source: `packages/contract/src/shape.ts` (the contract and registry),
`packages/plugins/src/shapes/<shape>.ts` (the bundled five).

## Capability extension guide

Capabilities are **open strings**. The catalog does **not** lock the set into a
closed enum; instead, the v1 rule is open string + reserved prefix:

| Prefix       | Owner                                              |
| ------------ | -------------------------------------------------- |
| `takos.*`    | Takos product surface                              |
| `system.*`   | Takosumi kernel / runtime-agent / observation tier |
| `operator.*` | Operator-defined deployment-local capabilities     |

A provider may declare any kebab-case identifier in `capabilities`. A manifest
may reference any kebab-case identifier in `requires`. Selection verifies subset
membership only. The closed `*Capability` union types exported alongside each
bundled shape are convenience for compile-time checks, not a contract — the
runtime treats `capabilities` as `readonly string[]`.

Adding a new reserved prefix, or adding identifiers under `takos.*` /
`system.*`, requires the §6 RFC. `operator.*` is free for the operator to use
within a single deployment.

## outputFields reserved names

Five field names are **reserved** across the catalog so that consumer manifests
can rely on stable semantics regardless of which provider runs:

| reserved name | meaning                                                         |
| ------------- | --------------------------------------------------------------- |
| `url`         | scheme-bearing public URL (`https://...`)                       |
| `endpoint`    | scheme-bearing service / API endpoint URL                       |
| `status`      | reserved for shape-level health surfaces; not used by v1 shapes |
| `id`          | provider-scope identifier                                       |
| `version`     | provider-scope version / revision identifier                    |

A new shape that exposes a field with one of these names must use the reserved
meaning. Adding a new reserved name follows the §6 RFC.

## Catalog

| Shape id            | version | summary                                                             |
| ------------------- | ------- | ------------------------------------------------------------------- |
| `object-store`      | `v1`    | Bucket-style object storage; provider-portable across S3-class APIs |
| `web-service`       | `v1`    | Long-running HTTP service backed by an OCI image or equivalent      |
| `database-postgres` | `v1`    | Managed PostgreSQL instance (wire-protocol portable)                |
| `custom-domain`     | `v1`    | DNS + TLS-terminated public domain                                  |
| `worker`            | `v1`    | Serverless JS function backed by a `js-bundle` artifact             |

The notation in the lifecycle persistence column below uses the v1 object
lifecycle classes: managed / generated / external / operator / imported. For the
bundled shapes, every output field is **generated** — the provider writes the
value during apply and the kernel persists it in the resolved output map for
`${ref:...}` consumption.

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

`name` is required and non-empty. All other fields are optional; provider
defaults apply when unset.

### outputFields

| field          | type   | nullable | lifecycle persistence |
| -------------- | ------ | -------- | --------------------- |
| `bucket`       | string | no       | generated             |
| `endpoint`     | string | no       | generated             |
| `region`       | string | no       | generated             |
| `accessKeyRef` | string | no       | generated             |
| `secretKeyRef` | string | no       | generated             |

### Declared capabilities (catalog vocabulary)

`versioning`, `presigned-urls`, `server-side-encryption`, `public-access`,
`event-notifications`, `lifecycle-rules`, `multipart-upload`.

## `web-service@v1`

Long-running HTTP service driven by an OCI image (or other artifact a provider
accepts).

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

Either `image` or `artifact` must be set. `bindings` accepts `${ref:...}`
expressions resolved against other resources' outputs; `env` is plain literal.

### outputFields

| field          | type   | nullable | lifecycle persistence |
| -------------- | ------ | -------- | --------------------- |
| `url`          | string | no       | generated             |
| `internalHost` | string | no       | generated             |
| `internalPort` | number | no       | generated             |

### Declared capabilities

`always-on`, `scale-to-zero`, `websocket`, `long-request`, `sticky-session`,
`geo-routing`, `crons`, `private-networking`.

## `database-postgres@v1`

Managed PostgreSQL with wire-protocol portability.

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

`pitr`, `read-replicas`, `high-availability`, `backups`, `ssl-required`, `ipv6`,
`extensions`.

## `custom-domain@v1`

DNS record plus TLS termination for a public domain. The common pattern is
`target: "${ref:<webservice>.url}"` to pin the domain to a `web-service@v1`
output.

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

Serverless JS function backed by an uploaded `js-bundle` artifact. Unlike
`web-service@v1`, `artifact.kind` must be exactly `js-bundle` and
`artifact.hash` is required (no external `uri`).

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

`scale-to-zero`, `websocket`, `long-request`, `geo-routing`, `crons`.

## Catalog extension

Adding a new shape, expanding the `outputFields` reserved-name set, or
introducing a new reserved capability prefix all go through the same
`CONVENTIONS.md` §6 RFC. Adding a new provider for an existing shape is the
standard non-RFC path and is the right tool for new cloud support.

## Catalog scope と plugin extension

Kernel curated catalog は v1 で 5 shape (`object-store@v1` / `web-service@v1` /
`database-postgres@v1` / `custom-domain@v1` / `worker@v1`) に閉じます。 新 shape
の追加は `CONVENTIONS.md` §6 RFC で coordinate されます。

Workflow / cron / lifecycle hook 等の shape は curated catalog に含めず、third
party plugin が独自 shape として提供します — 例えば `cron-job@v1` /
`workflow-job@v1` / `pre-apply-hook@v1` / `post-activate-hook@v1`。 これらは
予約済み kernel-side primitive である [Triggers](/reference/triggers) /
[Execute-Step Operation](/reference/execute-step-operation) /
[Declarable Hooks](/reference/declarable-hooks) と vocabulary を揃えつつ、現行
kernel では通常の plugin-provided `resources[]` shape として deploy されます。
詳細な extension 手順は [Extending the Shape Model](/extending) と
[Workflow Extension Design](/reference/architecture/workflow-extension-design)
を参照。

## Cross-references

- [Access Modes](/reference/access-modes) — closed v1 access mode enum (`read` /
  `read-write` / `admin` / `invoke-only` / `observe-only`) for shape outputs
  that expose targets to consumers, and the `safeDefaultAccess` contract on
  grant-producing exports.
- [Closed Enums](/reference/closed-enums) — full v1 closed enum index (object
  lifecycle classes, mutation constraints, link mutations) that shape outputs
  are constrained by.
- [Connector Contract](/reference/connector-contract) — `connector:<id>`
  identity と shape outputs が連携する artifact 受け渡し境界。
- `CONVENTIONS.md` §6 RFC (at the takosumi repo root) — shape catalog, reserved
  outputField, and reserved capability-prefix RFC process.
- [Triggers](/reference/triggers) — schedule / external-event / manual fire の
  予約済み registry vocabulary。
- [Execute-Step Operation](/reference/execute-step-operation) — single-step
  bundle execution の予約済み primitive。
- [Declarable Hooks](/reference/declarable-hooks) — lifecycle hook bus that
  `pre-apply-hook@v1` / `post-activate-hook@v1` shapes will attach to once the
  route/store implementation lands.
- [Workflow Extension Design](/reference/architecture/workflow-extension-design)
  — plugin-first rationale for keeping workflow surfaces out of the curated
  catalog.
- [Extending the Shape Model](/extending) — provider / template / new-shape
  extension flow.
