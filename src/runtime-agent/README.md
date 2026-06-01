# @takosjp/takosumi/runtime-agent

Executor / data plane for the Takosumi reference runtime. Receives lifecycle envelopes (apply / destroy / describe / verify) from the kernel over HTTP and dispatches to the right per-provider connector, which makes the actual cloud REST API call (SigV4 / OAuth / Cloudflare API token / Azure ARM / Kubernetes / etc) or local OS call (`docker`, `systemd`, filesystem).

Cloud / OS credentials stay outside the kernel. In the takosumi.com reference topology they typically live in the runtime-agent process; another operator-owned execution host can enforce the same boundary.

## Install

```typescript
// Standalone
import { startEmbeddedAgent } from "@takosjp/takosumi/runtime-agent/embed";
import { buildConnectorRegistry } from "@takosjp/takosumi-plugins/connectors";

const registry = buildConnectorRegistry({
  cloudflare: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    apiToken: process.env.CLOUDFLARE_API_TOKEN!,
    zoneId: process.env.CLOUDFLARE_ZONE_ID,
  },
});

const handle = startEmbeddedAgent({
  port: 8789,
  registry,
});
console.log(`agent listening at ${handle.url}`);
```

```bash
# The CLI starts the generic runtime-agent host. Operator distributions that
# need concrete connectors should provide their own boot wrapper and pass a
# ConnectorRegistry to startEmbeddedAgent(...) or serveRuntimeAgent(...).
takosumi runtime-agent serve --port 8789 --token <shared-with-kernel>
```

## Reference operator-internal HTTP API

| Method | Path                       | Description                                                                         |
| ------ | -------------------------- | ----------------------------------------------------------------------------------- |
| `GET`  | `/v1/health`               | health probe                                                                        |
| `GET`  | `/v1/connectors`           | bearer-auth: list registered connector-local `(shape, provider)` selectors          |
| `POST` | `/v1/lifecycle/apply`      | bearer-auth: apply one resource                                                     |
| `POST` | `/v1/lifecycle/destroy`    | bearer-auth: destroy by handle                                                      |
| `POST` | `/v1/lifecycle/compensate` | bearer-auth: compensate a recorded partial effect during WAL recovery               |
| `POST` | `/v1/lifecycle/describe`   | bearer-auth: query resource state                                                   |
| `POST` | `/v1/lifecycle/verify`     | bearer-auth: read-only credential check per connector (optionally filtered by body) |

Auth is a single bearer token, shared with the kernel via `TAKOSUMI_AGENT_TOKEN`.

## Connector selectors

`@takosjp/takosumi/runtime-agent` ships the lifecycle HTTP server, dispatcher,
`ConnectorRegistry`, and resilience wrapper. Concrete backend connectors live
outside the core package in `takosumi-plugins` as
`@takosjp/takosumi-plugins/connectors`. The values below are connector-local
wire selectors, not npm package names.

| Group                     | Connectors                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AWS                       | `@takos/aws-s3`, `@takos/aws-fargate`, `@takos/aws-rds`, `@takos/aws-route53`                                                                                                        |
| GCP                       | `@takos/gcp-gcs`, `@takos/gcp-cloud-run`, `@takos/gcp-cloud-sql`, `@takos/gcp-cloud-dns`                                                                                             |
| Cloudflare                | `@takos/cloudflare-r2`, `@takos/cloudflare-container`, `@takos/cloudflare-workers`, `@takos/cloudflare-dns`                                                                          |
| Kubernetes                | `@takos/kubernetes-deployment`                                                                                                                                                       |
| Deno                      | `@takos/deno-deploy`                                                                                                                                                                 |
| Local / external adapters | `@takos/filesystem-object-store`, `@takos/minio-object-store`, `@takos/docker-compose-web-service`, `@takos/systemd-web-service`, `@takos/docker-postgres`, `@takos/coredns-gateway` |

Operators can use the reference connector package or provide their own
connectors that implement the same interface:

Each connector implements:

```typescript
interface Connector {
  readonly provider: string;
  readonly shape: string;
  readonly acceptedArtifactKinds: readonly string[];
  apply(req, ctx): Promise<{ handle; outputs }>;
  destroy(req, ctx): Promise<{ ok }>;
  compensate?(req, ctx): Promise<{
    ok;
    note?;
    revokeDebtRequired?;
    detail?;
  }>;
  describe(req, ctx): Promise<{ status; outputs? }>;
  verify?(ctx): Promise<{ ok; code?; note? }>;
}
```

The `shape` and `provider` fields are connector-local wire selectors. The operator adapter derives them from its kind-to-execution binding before sending a lifecycle request.

`LifecycleApplyRequest.spec` is connector-local lifecycle input. It is normally the public kind spec after descriptor validation plus adapter-projected runtime data such as binding-derived env or gateway targets. Connectors should validate a closed field set before calling backend APIs.

Source-backed connectors read files from `LifecycleApplyRequest.preparedSource` through `ctx.source`. DataAsset/artifact handling is an optional operator extension: connectors may use `ctx.fetcher` when their implementation-specific selector expects uploaded or external asset metadata, but DataAsset metadata values are connector-owned metadata rather than Takosumi public Installer API concepts. The compatibility wire may call that value `kind`.

`compensate` is the recovery hook for partially applied effects recorded in the kernel WAL. Connectors that can reverse an effect more precisely than handle-keyed deletion should implement it. When the hook is absent, the dispatcher falls back to `destroy`; if cleanup cannot be completed, the response can set `revokeDebtRequired` so the kernel keeps operator-visible cleanup debt.

## Boot wiring

The generic runtime-agent does not auto-load cloud connectors from env. An
operator-owned boot module reads env or config, constructs a `ConnectorRegistry`,
and passes it to `serveRuntimeAgent(...)` or `startEmbeddedAgent(...)`.

The reference connector package exposes `buildConnectorRegistry(...)` for
common provider families. A typical boot module maps env vars to that function:

| Connector group | Env vars                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| AWS             | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`                                                |
| GCP             | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_REGION`, `GOOGLE_APPLICATION_CREDENTIALS`                           |
| Cloudflare      | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`                                     |
| Azure           | `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_BEARER_TOKEN`, `AZURE_LOCATION`                   |
| Kubernetes      | `TAKOSUMI_KUBERNETES_API_SERVER_URL`, `TAKOSUMI_KUBERNETES_BEARER_TOKEN`, `TAKOSUMI_KUBERNETES_NAMESPACE` |
| Deno Deploy     | `DENO_DEPLOY_ACCESS_TOKEN`, `DENO_DEPLOY_ORGANIZATION_ID`                                                 |
| Local adapters  | `TAKOSUMI_LOCAL_ADAPTER_OBJECT_STORE_ROOT`, `TAKOSUMI_LOCAL_ADAPTER_SYSTEMD_UNIT_DIR`, etc.               |

Operator can call `takosumi runtime-agent list` or `takosumi runtime-agent
verify` against the running agent to confirm which connectors are live.

## Connector resilience

`withConnectorResilience()` wraps registered connectors with bounded resilience. Transient HTTP statuses (`408`, `425`, `429`, `5xx` allowlist) and network errors are retried with exponential backoff. Provider rejections such as `400` / validation errors fail fast.

Operators that can rotate or refresh credentials may pass
`ConnectorResilienceOptions.refreshCredentials`; the wrapper invokes it before
retrying one credential-looking failure such as `HTTP 401` or an expired token
error. The reference connector package's `buildConnectorRegistry(...)` applies
this wrapper by default unless `resilience: false` is supplied.

## Implementation note

The reference connectors make cloud REST calls via `fetch()` + `crypto.subtle`
(Web Crypto). No npm SDK packages are pulled in; SigV4 / OAuth bearer /
Service-account JWT signing is internal to
`@takosjp/takosumi-plugins/connectors`.

## See also

- `@takosjp/takosumi/kernel` — control plane that talks to this agent
- `@takosjp/takosumi/cli` — runs `takosumi runtime-agent serve`
- `@takosjp/takosumi-plugins/connectors` — reference concrete connector package
- `@takosjp/takosumi/contract/reference/runtime-agent-lifecycle` — defines `LifecycleApplyRequest` etc. for the reference lifecycle envelope.

> The public npm package is `@takosjp/takosumi`. The contract is the authority. Contract-compatible publishers can ship their own runtime-agent implementations; current verification covers the reference distribution.
