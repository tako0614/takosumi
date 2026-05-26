# Installer API (5 endpoints) {#installer-api}

The public Takosumi Installer API has five Installation-centered endpoints. The objects are manifest, Installation, and Deployment, and the endpoints follow that lifecycle.

```text
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

Dry-run results are returned in the response. Apply results are recorded as Deployment records.

These five routes are the Takosumi public Installer API. If an operator distribution exposes account management APIs or facades on the same host or URL prefix, those APIs are versioned as operator-provided contracts.

## Write API And Read APIs {#write-api-and-read-surfaces}

The Installer API is the portable write lifecycle. It handles preview, Installation creation, deploy, and rollback, and returns `Installation` and `Deployment` objects as write results. List, get, and poll routes are not part of the five-endpoint core contract.

Workflows that need Deployment history use an operator-provided read API. Examples include dashboard support tooling, CLI read models, rollback target selectors, async apply polling, and audit review views.

The read API may be a Cloud account management API, an operator-managed read API, or dashboard support tooling. Route inventory, pagination, authentication, and redaction rules belong to the operator's configuration.

Read APIs are compatibility/read-model views around the write lifecycle. They do not add core Installer API endpoints.

## Authentication {#authentication}

| Credential       | Header                          | Scope                        |
| ---------------- | ------------------------------- | ---------------------------- |
| Installer bearer | `Authorization: Bearer <token>` | the five Installer endpoints |

The operator issues scoped credentials for actors. Space scope and capability scope are represented in token claims.

## `POST /v1/installations/dry-run` {#post-v1-installations-dry-run}

Validates the manifest and returns planned changes without creating an Installation.

### Request

```json
{
  "spaceId": "space_personal",
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "v1.2.3"
  }
}
```

| Field           | Required    | Meaning                                                |
| --------------- | ----------- | ------------------------------------------------------ |
| `spaceId`       | yes         | Target Space.                                          |
| `source.kind`   | yes         | `git`, `prepared`, or dev/operator-local `local`.      |
| `source.url`    | yes         | Git URL, prepared archive URL, or `local` source path. |
| `source.ref`    | conditional | Required for `git`; branch, tag, or commit.            |
| `source.digest` | conditional | Required for `prepared`; archive payload digest guard. |

`git` and `prepared` are remote source kinds. Remote operators, CLIs, and build services pass one of those two kinds. `local` is for dev/operator-local profiles where the kernel process can directly read the path in `source.url`.

Remote `source.url` values use HTTPS. `http://localhost` and `http://127.0.0.1` are only for single-host loopback development. A digest is integrity evidence; it does not replace the HTTPS transport requirement. File paths and `file://` locators are represented with `source.kind: "local"`, not with remote source.

Source descriptors are closed by kind:

- `git`: `url` and `ref` are required. `ref` is a branch, tag, or commit. `digest` is invalid.
- `prepared`: `url` and `digest` are required. `digest` is the archive payload guard computed by the build service or caller. `ref` and `commit` are invalid.
- `local`: `url` is a kernel-local path. `ref`, `commit`, and `digest` are invalid.

`source.kind: "prepared"` is the handoff from CI or a build service. The `source.url` points to an archive payload containing `.takosumi.yml`.

Portable Installer API v1 defines:

- archive URL, declared digest, and resolved digest
- archive-root `.takosumi.yml`
- size caps and path-safety requirements

Portable v1 prepared source payloads are uncompressed POSIX tar archives. Operator-local profiles may accept other encodings, but those are outside portable v1 compatibility.

The kernel computes `sha256:<hex>` over the fetched payload bytes, checks the portable tar parser and archive safety policy, then reads the manifest. If the computed digest does not match caller-supplied `source.digest`, the response is `409 failed_precondition`. Build recipe, cache metadata, and provenance remain build-service records.

Prepared source examples in this API reference show only the Installer API request shape. Build service endpoints, storage layout, recipe format, cache keys, and provenance format belong to build service or operator docs.

`git` and `prepared` resolve an immutable source identity before apply. For `git`, that identity is the resolved commit. For `prepared`, it is the archive payload digest computed by the kernel. Manifest file paths are source-root-relative paths inside that resolved source. `local` reads a kernel-local tree at request time and has no portable source byte digest on the wire.

### Response

The `outputs`-related examples in this page use catalog-shaped output data an operator might create after adopting official gateway and service-binding kind definitions. Core records non-secret output data; kind definition semantics are defined by the catalog and operator.

```json
{
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "v1.2.3",
    "commit": "abc123"
  },
  "manifestDigest": "sha256:...",
  "manifest": {
    "apiVersion": "v1",
    "metadata": {
      "id": "com.example.notes",
      "name": "Example Notes"
    },
    "components": {
      "web": {
        "kind": "worker",
        "spec": { "entrypoint": "src/worker.ts" },
        "publish": {
          "http": { "as": "http-endpoint" }
        }
      },
      "db": {
        "kind": "postgres",
        "spec": { "version": "16", "size": "small" }
      },
      "public": {
        "kind": "gateway",
        "listen": {
          "app": { "from": "web.http", "as": "upstream" }
        },
        "publish": {
          "public": { "as": "http-endpoint" }
        },
        "spec": {
          "listeners": {
            "public": {
              "protocol": "https",
              "host": "notes.example.com",
              "tls": "auto"
            }
          },
          "routes": [
            { "listener": "public", "path": "/", "to": "app" }
          ]
        }
      }
    }
  },
  "changes": [
    { "op": "create", "component": "web", "kind": "worker" },
    { "op": "create", "component": "db", "kind": "postgres" },
    { "op": "create", "component": "public", "kind": "gateway" }
  ],
  "expected": {
    "commit": "abc123",
    "manifestDigest": "sha256:..."
  }
}
```

Core dry-run response is `changes[]` plus an `expected` guard. Cost estimates, billing quotes, approval prompts, and account management policy messages are operator distribution responses around this Installer API call.

`changes[]` is component-level preview. Public `ChangeEntry.op` values are:

| Field       | Required | Meaning                                                          |
| ----------- | -------- | ---------------------------------------------------------------- |
| `op`        | yes      | `create`, `update`, `delete`, or `noop`.                         |
| `component` | yes      | Manifest component name.                                         |
| `kind`      | yes      | Submitted kind for create/update/noop; previous kind for delete. |
| `reason`    | no       | Short operator explanation.                                      |

`noop` may be used when the compared plan matches an existing current Deployment component. No plan entity is created; it is only preview inside the dry-run response. Operators that expose resolved kind definition URI or selected implementation binding store those values in extension fields and Deployment records.

`expected` is a guard for the resolved source kind. `manifestDigest` is always required. Git source adds `expected.commit`; prepared source adds `expected.sourceDigest`. Deploy dry-run for an existing Installation also adds `expected.currentDeploymentId` as the reviewed base pointer. Inapplicable fields return `400 invalid_argument`; well-formed guards that do not match the resolved source or current pointer return `409 failed_precondition`.

Passing dry-run `expected` directly to the next apply rejects input that differs from the reviewed source. Deploy apply also checks `expected.currentDeploymentId`, so another Deployment becoming current after dry-run is rejected with 409. This reviewed-source/base guard prevents time-of-check/time-of-use drift.

`expected.currentDeploymentId` is `string | null`. If deploy dry-run targets an Installation without a current pointer, it returns `null`, and apply proceeds only while the pointer is still `null`.

Prepared source dry-run returns the same value in resolved `source.digest` and `expected.sourceDigest`. Prepared source has no git commit, so `expected.commit` is absent.

Local source dry-run returns only `expected.manifestDigest`. That guards the `.takosumi.yml` bytes, not the entire source tree. Use `git` or `prepared` when apply must guard runtime file bytes.

```json
{
  "source": {
    "kind": "prepared",
    "url": "https://source.example/prepared/notes.tar",
    "digest": "sha256:..."
  },
  "manifestDigest": "sha256:...",
  "changes": [],
  "expected": {
    "manifestDigest": "sha256:...",
    "sourceDigest": "sha256:..."
  }
}
```

## `POST /v1/installations` {#post-v1-installations}

Runs the first apply for an Installation and records the first Deployment. In operator configurations with account management, account/Space/ownership ledger creation belongs to the operator facade; this route handles manifest/source verification and Deployment apply.

### Request

```json
{
  "spaceId": "space_personal",
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "v1.2.3"
  },
  "expected": {
    "commit": "abc123",
    "manifestDigest": "sha256:..."
  }
}
```

If `expected` is omitted, apply fetches source, computes digests, and runs the attempt against that attempt's resolved source. That mode is for direct single-shot callers. Dry-run-to-apply flows and retrying automation send the `expected` guard from dry-run. If the source changed, the response is `409 failed_precondition`.

`expected` is a reviewed-source guard, not a public idempotency key.

If a caller times out before receiving the apply HTTP response, it should check the operator's documented read API for current Deployment and Deployment history before retrying. Resending the same source may return an already-closed Deployment or start a new attempt, depending on operator retry policy. A different source from the reviewed one is always rejected with 409.

Prepared source apply requires request `source.digest`. Dry-run `expected.sourceDigest` is the reviewed-source guard and does not replace `source.digest`. The kernel checks fetched payload digest against `source.digest` and, if `expected.sourceDigest` is present, against that guard as well.

```json
{
  "spaceId": "space_personal",
  "source": {
    "kind": "prepared",
    "url": "https://source.example/prepared/notes.tar",
    "digest": "sha256:..."
  },
  "expected": {
    "manifestDigest": "sha256:...",
    "sourceDigest": "sha256:..."
  }
}
```

### Response

```json
{
  "installation": {
    "id": "inst_01HM9N7XK4QY8RT2P5JZF6V3W9",
    "spaceId": "space_personal",
    "appId": "com.example.notes",
    "currentDeploymentId": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA",
    "status": "ready",
    "createdAt": 1716000000000
  },
  "deployment": {
    "id": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA",
    "installationId": "inst_01HM9N7XK4QY8RT2P5JZF6V3W9",
    "source": {
      "kind": "git",
      "url": "https://github.com/example/notes",
      "ref": "v1.2.3",
      "commit": "abc123"
    },
    "manifestDigest": "sha256:...",
    "status": "succeeded",
    "outputs": {
      "components": {
        "public": {
          "public": {
            "contract": "http-endpoint",
            "endpoints": [
              {
                "url": "https://notes.example.com",
                "scheme": "https",
                "host": "notes.example.com",
                "listener": "public",
                "visibility": "public",
                "primary": true,
                "routes": [{ "pathPrefix": "/", "to": "app" }]
              }
            ]
          }
        },
        "db": {
          "connection": {
            "contract": "service-binding",
            "configRef": "config://deployment/db/connection",
            "secretRefs": ["secret://runtime/db/password"]
          }
        }
      }
    },
    "createdAt": 1716000000000
  }
}
```

`outputs.components[componentName][publicationName]` is the public/non-secret output data for a manifest `publish` entry in that Deployment. Public Installer responses return catalog-defined published output as JSON objects. Output field meaning belongs to the selected catalog/operator configuration, and operator-facing ledgers may store separate apply records.

Public `outputs` contain only non-secret runtime/public projections. Raw credentials, tokens, private keys, passwords, cookies, provider secrets, and payment-backend credentials are not placed in Deployment outputs or export bundles. Required sensitive values are represented as `configRef`, `secretRef`, or operator-provided configuration. Exporter-specific rejection and redaction behavior belongs to operator/exporter docs.

`Deployment.status: "succeeded"` means the synchronous apply/activation work needed to make the Deployment current has completed. Health observation can update operator observation state later. Activate is an internal phase of install/deploy/rollback; there is no separate public activate endpoint. Rollback does not rewrite historical records. It moves the current pointer back to a previous Deployment.

`Installation.currentDeploymentId` can point only to a `succeeded` Deployment. `running` and `failed` Deployments may remain as history but are not current runtime authority.

## `POST /v1/installations/{id}/deployments/dry-run` {#post-v1-installations-id-deployments-dry-run}

Returns the diff for applying new source to an existing Installation. It does not create a Deployment.

### Request

```json
{
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "v1.2.4"
  }
}
```

If `source` is omitted, the operator reuses the resolved source identity recorded on the current Deployment. For git source, the recorded `commit` is the authority. For prepared source, the recorded archive payload digest is the authority. `local` current Deployments cannot be reused this way because they have no portable resolved source byte identity. `ref` is display/intent metadata; it is not re-resolved to the latest branch or tag position. To deploy a new ref, provide `source`.

### Response

The response shape matches `POST /v1/installations/dry-run`. `changes[]` can also include `op: update` and `op: delete`.

```json
{
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "v1.2.4",
    "commit": "abc456"
  },
  "manifestDigest": "sha256:...",
  "changes": [
    { "op": "update", "component": "api", "kind": "web-service" },
    { "op": "create", "component": "cache", "kind": "object-store" },
    { "op": "delete", "component": "legacy-worker", "kind": "worker" }
  ],
  "expected": {
    "commit": "abc456",
    "manifestDigest": "sha256:...",
    "currentDeploymentId": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA"
  }
}
```

## `POST /v1/installations/{id}/deployments` {#post-v1-installations-id-deployments}

Applies a new Deployment to an existing Installation. It verifies resolved source and can update, create, or delete resources. Build/prepare work happens before this call in a build service or CI.

### Request

```json
{
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "v1.2.4"
  },
  "expected": {
    "commit": "abc456",
    "manifestDigest": "sha256:...",
    "currentDeploymentId": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA"
  }
}
```

Prepared source still requires `source.digest`. Dry-run `expected.sourceDigest` is passed as a reviewed-source guard.

If `source` is omitted, apply reuses the current Deployment's resolved source identity like deploy dry-run. This is not branch/tag refresh; it is re-applying the recorded source. `local` source cannot be omitted. If the git commit or prepared archive payload cannot be fetched again, the request fails with `failed_precondition`; the installer does not silently fall back to the current branch or tag position.

`expected.currentDeploymentId` guards the current pointer reviewed by dry-run. If the request value does not match `Installation.currentDeploymentId` at apply start, the response is `409 failed_precondition` before resource creation/update.

### Response

```json
{
  "deployment": {
    "id": "dep_01HM9N7XK4QY8RT2P5JZF6V3WB",
    "installationId": "inst_01HM9N7XK4QY8RT2P5JZF6V3W9",
    "source": {
      "kind": "git",
      "url": "https://github.com/example/notes",
      "ref": "v1.2.4",
      "commit": "abc456"
    },
    "manifestDigest": "sha256:...",
    "status": "succeeded",
    "outputs": {},
    "createdAt": 1716100000000
  }
}
```

## `POST /v1/installations/{id}/rollback` {#post-v1-installations-id-rollback}

Moves the current pointer back to a previous Deployment. It does not mutate historical Deployment records and does not create a new Deployment. It updates `Installation.currentDeploymentId` to the target Deployment and reactivates that Deployment's public/non-secret outputs as current.

### Request

```json
{
  "deploymentId": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA"
}
```

### Response

```json
{
  "installation": {
    "id": "inst_01HM9N7XK4QY8RT2P5JZF6V3W9",
    "spaceId": "space_personal",
    "appId": "com.example.notes",
    "currentDeploymentId": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA",
    "status": "ready",
    "createdAt": 1716090000000
  },
  "deployment": {
    "id": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA",
    "installationId": "inst_01HM9N7XK4QY8RT2P5JZF6V3W9",
    "source": {
      "kind": "git",
      "url": "https://github.com/example/notes",
      "ref": "v1.2.3",
      "commit": "abc123"
    },
    "manifestDigest": "sha256:...",
    "status": "succeeded",
    "outputs": {},
    "createdAt": 1716090000000
  },
  "rollback": {
    "rolledBackFrom": "dep_01HM9N7XK4QY8RT2P5JZF6V3WB",
    "rolledBackTo": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA"
  }
}
```

The `rollback` object is response metadata for this call. Durable audit/event format belongs to the operator's read API or account management event API.

Rollback selects a target Deployment using that Deployment's source pin, `manifestDigest`, public/non-secret outputs, and Deployment record needed for reactivation. It does not refetch source or rebuild.

If the Deployment record needed to reactivate the target is unavailable, the response is `409 failed_precondition` before resource creation.

Rollback target requirements:

- the target Deployment belongs to the same Installation
- the target Deployment status is `succeeded`
- the target Deployment's source identity, `manifestDigest`, public/non-secret outputs, and Deployment record needed for reactivation are available under the retention policy

Rollback success is atomic at the core record level. The response succeeds only after `Installation.currentDeploymentId` points to the target Deployment and the target's public/non-secret outputs are current outputs.

If validation, Deployment record availability, serialization, or reactivation checks fail, the endpoint returns an error and leaves `currentDeploymentId` unchanged. Rollback failure is recorded in the operator's read/event API. No new Deployment is created.

Application data backup and restore belong to operator data-protection workflows. Rollback does not roll back database contents, object-store contents, migrations, or tenant data.

## Entity Fields {#entity-fields}

### `Installation` {#installation}

`Installation.status` is the public Installation lifecycle status. Kernel-local dev responses and public Installer API responses use the same four values. In-flight apply/rollback detail belongs to Deployment status, operation metadata, or account management event payloads; it does not add another public core enum.

| Status       | Meaning                                                             |
| ------------ | ------------------------------------------------------------------- |
| `installing` | First apply is in progress or no current Deployment is established. |
| `ready`      | Current Deployment is valid and `succeeded`.                        |
| `failed`     | Last install/apply attempt failed and there is no ready current.    |
| `suspended`  | Operator policy has paused side-effecting deploy/rollback mutation. |

Dry-run endpoints can still preview while an Installation is `suspended`. Side-effecting deploy and rollback endpoints return `409 failed_precondition` until the operator resumes the Installation. Runtime serving behavior during suspension belongs to the operator's configuration or account management.

Operator account management distributions can model portability lifecycle such as export/import, uninstall, and materialize as separate events, metadata, or account management status. Takosumi Installer API `Installation.status` remains the four-value enum above.

`currentDeploymentId` points to the last `succeeded` Deployment selected as current. Running or failed Deployments may be recorded as history but do not update the pointer. Rollback reselects a previous `succeeded` Deployment.

Provider rollout, activation, domain projection, runtime routing, and operator rollout views are documented in the operator's configuration. The Installer API wire guarantee is that the current pointer points only to `succeeded` Deployments.

```ts
interface Installation {
  readonly id: string;
  readonly spaceId: string;
  readonly appId: string;
  readonly currentDeploymentId: string | null;
  readonly status: "installing" | "ready" | "failed" | "suspended";
  readonly createdAt: number;
}
```

### `Deployment` {#deployment}

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

interface Deployment {
  readonly id: string;
  readonly installationId: string;
  readonly source: {
    readonly kind: "git" | "prepared" | "local";
    readonly url?: string;
    readonly ref?: string;
    readonly commit?: string;
    readonly digest?: string;
  };
  readonly manifestDigest: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly outputs: {
    readonly components?: Record<
      string,
      Record<string, Record<string, JsonValue>>
    >;
    readonly extensions?: Record<string, JsonValue>;
  };
  readonly createdAt: number;
}
```

Public Deployment wire guarantees source identity, `manifestDigest`, status, and public/non-secret `outputs`. Portable summaries can be exposed through documented extension fields. Implementations and operator configurations record resolution details in Deployment records.

## Apply Result Semantics {#apply-result-semantics}

Validation, authentication, permission, source guard, current pointer guard, and policy failures return the error response below before resource creation and before a new public Deployment is created.

Concurrent mutation is serialized per Installation. Operators may wait for an active mutation to finish within the request deadline. If another install, deploy, or rollback prevents a request from starting, the operator returns `409 failed_precondition`, typically with a detail reason such as `mutation-in-progress`. No resource creation/update has started for the rejected request.

After an apply attempt enters the Deployment lifecycle, the result is a Deployment record.

| Deployment status | Meaning                                                        | Current pointer behavior                                    |
| ----------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| `running`         | Operator accepted lifecycle work and continues asynchronously. | Pointer does not move until the Deployment succeeds.        |
| `succeeded`       | Required apply/activation work is done and can be current.     | `Installation.currentDeploymentId` can move to this record. |
| `failed`          | Apply entered lifecycle execution and then failed.             | Pointer remains on the previous succeeded Deployment.       |

If apply returns `running`, the operator's read API lets callers observe the Deployment until it reaches `succeeded` or `failed`. The five core Installer endpoints define the write lifecycle and Deployment format. Operator read APIs define route names, pagination, authentication, and account-facing enrichment.

## Error Response {#error-envelope}

```ts
interface ApiErrorEnvelope {
  readonly error: {
    readonly code:
      | "invalid_argument"
      | "unauthenticated"
      | "permission_denied"
      | "not_found"
      | "failed_precondition"
      | "resource_exhausted"
      | "not_implemented"
      | "internal_error";
    readonly message: string;
    readonly requestId: string;
    readonly details?: unknown;
  };
}
```

| Code                  | HTTP | Common reasons                                                                                                          |
| --------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------- |
| `invalid_argument`    | 400  | See list below.                                                                                                         |
| `unauthenticated`     | 401  | Missing bearer credential.                                                                                              |
| `permission_denied`   | 403  | Actor lacks Space permission or operator policy denies the action.                                                      |
| `not_found`           | 404  | Installation or Deployment is absent.                                                                                   |
| `failed_precondition` | 409  | See list below.                                                                                                         |
| `resource_exhausted`  | 413  | Request body, manifest, or prepared source payload exceeds size limits.                                                 |
| `not_implemented`     | 501  | API endpoint, adopted kind's implementation binding, or operator-defined extension is not implemented by this operator. |
| `internal_error`      | 500  | Unhandled exception.                                                                                                    |

Common `invalid_argument` causes:

- Manifest schema violation
- Malformed source
- Malformed `listen.from` grammar
- Invalid local `listen` reference
- Unsupported field shape
- Cyclic `publish` to `listen`

Common `failed_precondition` causes:

- Source pin mismatch
- Prepared `source.digest` mismatch
- Expected guard mismatch
- Well-formed kind/output type/projection term not adopted or invisible in the Space
- Required platform service absent from current Space state
- Duplicate visible platform service entries
- Active mutation conflict
- Omitted source trying to reuse current local source

This error code set is scoped to the five Installer API endpoints. Operator account management APIs may return their own codes, such as `state_conflict`, even when they share a URL prefix.

## Related Pages {#related-pages}

- [Manifest](./manifest.md)
- [Build Service Boundary](./build-spec.md)
- [Digest Computation](./digest-computation.md)
- [CLI](./cli.md)
