# @takos/takosumi-runtime-agent

Executor / data plane for the Takosumi self-host PaaS toolkit. Receives
lifecycle envelopes (apply / destroy / describe / verify) from the kernel over
HTTP and dispatches to the right per-provider connector, which makes the actual
cloud REST API call (SigV4 / OAuth / Cloudflare API token / Azure ARM /
Kubernetes / etc) or local OS call (`docker`, `systemd`, filesystem).

The runtime-agent is the **only place cloud credentials live**. The kernel never
sees them.

## Install

```typescript
// Standalone
import { startEmbeddedAgent } from "@takos/takosumi-runtime-agent/embed";

const handle = startEmbeddedAgent({
  port: 8789,
  // env: Deno.env.toObject(),  // default; agent reads cloud creds from env
});
console.log(`agent listening at ${handle.url}`);
```

```bash
# Or via the Takosumi CLI
takosumi runtime-agent serve --port 8789 --token <shared-with-kernel>
```

## HTTP API

| Method | Path                     | Description                                                                                |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------ |
| `GET`  | `/v1/health`             | health probe                                                                               |
| `GET`  | `/v1/connectors`         | bearer-auth: list registered `(shape, provider)`                                           |
| `POST` | `/v1/lifecycle/apply`    | bearer-auth: apply one resource                                                            |
| `POST` | `/v1/lifecycle/destroy`  | bearer-auth: destroy by handle                                                             |
| `POST` | `/v1/lifecycle/describe` | bearer-auth: query resource state                                                          |
| `POST` | `/v1/lifecycle/verify`   | bearer-auth: read-only credential check per connector (or filtered by `?shape=&provider=`) |

Auth is a single bearer token, shared with the kernel via
`TAKOSUMI_AGENT_TOKEN`.

## Connectors (21)

Bundled (auto-registered when the matching cloud env is present):

| Group      | Connectors                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS        | `@takos/aws-s3`, `@takos/aws-fargate`, `@takos/aws-rds`, `@takos/aws-route53`                                                                                             |
| GCP        | `@takos/gcp-gcs`, `@takos/gcp-cloud-run`, `@takos/gcp-cloud-sql`, `@takos/gcp-cloud-dns`                                                                                  |
| Cloudflare | `@takos/cloudflare-r2`, `@takos/cloudflare-container`, `@takos/cloudflare-workers`, `@takos/cloudflare-dns`                                                               |
| Azure      | `@takos/azure-container-apps`                                                                                                                                             |
| Kubernetes | `@takos/kubernetes-deployment`                                                                                                                                            |
| Deno       | `@takos/deno-deploy`                                                                                                                                                      |
| Self-host  | `@takos/selfhost-filesystem`, `@takos/selfhost-minio`, `@takos/selfhost-docker-compose`, `@takos/selfhost-systemd`, `@takos/selfhost-postgres`, `@takos/selfhost-coredns` |

Each connector implements:

```typescript
interface Connector {
  readonly provider: string;
  readonly shape: string;
  readonly acceptedArtifactKinds: readonly string[];
  apply(req, ctx): Promise<{ handle; outputs }>;
  destroy(req, ctx): Promise<{ ok }>;
  describe(req, ctx): Promise<{ status; outputs? }>;
  verify?(ctx): Promise<{ ok; code?; note? }>;
}
```

## Cloud credentials (per connector)

The agent reads env at startup. Set what you need:

| Connector group | Env vars                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| AWS             | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`                                                |
| GCP             | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_REGION`, `GOOGLE_APPLICATION_CREDENTIALS`                           |
| Cloudflare      | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`                                     |
| Azure           | `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_BEARER_TOKEN`, `AZURE_LOCATION`                   |
| Kubernetes      | `TAKOSUMI_KUBERNETES_API_SERVER_URL`, `TAKOSUMI_KUBERNETES_BEARER_TOKEN`, `TAKOSUMI_KUBERNETES_NAMESPACE` |
| Deno Deploy     | `DENO_DEPLOY_ACCESS_TOKEN`, `DENO_DEPLOY_ORGANIZATION_ID`                                                 |
| Self-host       | `TAKOSUMI_SELFHOSTED_OBJECT_STORE_ROOT`, `TAKOSUMI_SELFHOSTED_SYSTEMD_UNIT_DIR`, etc.                     |

A cloud's connectors are skipped (not registered) when its required env vars are
missing — operator can `takosumi runtime-agent verify` to confirm which
connectors are live.

## Implementation note

All cloud REST calls are made via `fetch()` + `crypto.subtle` (Web Crypto). No
npm SDK packages are pulled in; SigV4 / OAuth bearer / Service-account JWT
signing is internal. This keeps the agent Deno-runtime-pure and the install
surface small.

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel) — control
  plane that talks to this agent
- [`@takos/takosumi-cli`](https://jsr.io/@takos/takosumi-cli) — runs
  `takosumi runtime-agent serve`
- [`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract) —
  defines `LifecycleApplyRequest` etc.
