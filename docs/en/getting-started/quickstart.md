# Quickstart — from git clone to first deploy

> このページでわかること: Write a manifest and run your first deploy (English
> version). See [Quickstart (JA)](/getting-started/quickstart) for the JA
> original.

This document shows the shortest path through Takosumi: **write one manifest and
deploy it to selfhosted / AWS / GCP / Cloudflare / Azure / Kubernetes**.

Takosumi consists of two components:

- **kernel**: manages the HTTP API, the apply pipeline, and the state DB. Takes
  a manifest and orchestrates resource lifecycles, but **never calls cloud SDKs
  directly**.
- **runtime-agent**: the executor that actually talks to cloud REST APIs (SigV4
  / OAuth) and the local OS (`docker`, `systemd`, filesystem). **Credentials
  live only here.**

In dev, a single `takosumi server` command brings both up in one process. In
production, they can run on separate hosts or co-located.

---

## 1. CLI install

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi version
```

---

## 2. Local authoring (zero-config)

Start with CLI local mode. It does not need a kernel server and its state is
ephemeral, so it is best for authoring and smoke tests:

Create `.takosumi.yml` as the AppSpec at the source root. The public installer
API reads this AppSpec, creates an Installation, and records each apply as a
Deployment.

```yaml
apiVersion: v1
metadata:
  id: com.example.hello-worker
  name: hello-worker
components:
  web:
    kind: worker
    build:
      command: "npm run build"
      output: "dist/worker.js"
    spec:
      compatibilityDate: "2026-05-09"
      routes:
        - hello.local/*
```

```bash
takosumi install dry-run --space space_personal --source .
takosumi install --space space_personal --source .
```

For a remote-kernel dev loop, make the URL/token explicit:

```bash
export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_INSTALLER_TOKEN=$(openssl rand -hex 32)
export TAKOSUMI_REMOTE_URL=http://localhost:8788
takosumi server --port 8788 &
# stdout: "embedded runtime-agent listening at http://127.0.0.1:8789"
takosumi install --space space_personal --source .
```

`TAKOSUMI_DEV_MODE=1` is the single dev opt-out flag. It permits plaintext
secrets, an unencrypted DB, and unsafe defaults. Production / staging stays
fail-closed.

In this dev-server mode, the agent and kernel share a process, so cloud
credentials exported into the env reach the agent connectors directly.

---

## 3. Self-hosted deploy (single VM, Docker / systemd)

For a single-VM self-hosted setup (Docker / systemd / filesystem / local
Postgres / coredns), the AppSpec component graph and the operator-side env
checklist are canonical in [Self-host Notes (JA)](/operator/self-host). The EN
quickstart only links here; the JA doc has the most current AppSpec snippet, env
list, and connector behavior.

---

## 4. Cloud deploy (AWS / GCP / Cloudflare / Azure / Kubernetes)

Place cloud credentials in **the env of the agent host**. In dev, the kernel and
agent share a process, so simply export them in the shell that launches
`takosumi server`:

### AWS

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=ap-northeast-1
# optional: export AWS_SESSION_TOKEN=...
# optional Fargate / RDS / Route53 knobs:
# export TAKOSUMI_AWS_FARGATE_CLUSTER=my-cluster
# export TAKOSUMI_AWS_FARGATE_SUBNET_IDS=subnet-aaa,subnet-bbb
```

Connectors: `@takos/aws-fargate` / `@takos/aws-rds` / `@takos/aws-s3` /
`@takos/aws-route53`

### GCP

```bash
export GOOGLE_CLOUD_PROJECT=my-project
export GOOGLE_CLOUD_REGION=asia-northeast1
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

Connectors: `@takos/gcp-cloud-run` / `@takos/gcp-cloud-sql` / `@takos/gcp-gcs` /
`@takos/gcp-cloud-dns`

### Cloudflare

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ZONE_ID=...   # required when using custom-domain
```

Connectors: `@takos/cloudflare-container` / `@takos/cloudflare-r2` /
`@takos/cloudflare-dns`

### Azure

```bash
export AZURE_SUBSCRIPTION_ID=...
export AZURE_RESOURCE_GROUP=my-rg
export AZURE_LOCATION=eastus
export AZURE_BEARER_TOKEN=$(az account get-access-token --query accessToken -o tsv)
```

Connector: `@takos/azure-container-apps`

### Kubernetes (k3s, etc.)

```bash
export TAKOSUMI_KUBERNETES_API_SERVER_URL=https://k8s.example/
export TAKOSUMI_KUBERNETES_BEARER_TOKEN=$(cat /var/run/secrets/.../token)
export TAKOSUMI_KUBERNETES_NAMESPACE=takosumi
```

Connector: `@takos/kubernetes-deployment`

### Bundled provider ids

Every bundled provider id is namespaced as `@takos/<cloud>-<service>`. The
kernel rejects bare provider ids at resolve time and includes the namespaced id
in the error message when it can infer the intended provider.

| Cloud      | Provider ids                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS        | `@takos/aws-s3`, `@takos/aws-fargate`, `@takos/aws-rds`, `@takos/aws-route53`                                                                                             |
| GCP        | `@takos/gcp-gcs`, `@takos/gcp-cloud-run`, `@takos/gcp-cloud-sql`, `@takos/gcp-cloud-dns`                                                                                  |
| Cloudflare | `@takos/cloudflare-r2`, `@takos/cloudflare-container`, `@takos/cloudflare-dns`                                                                                            |
| Azure      | `@takos/azure-container-apps`                                                                                                                                             |
| Kubernetes | `@takos/kubernetes-deployment`                                                                                                                                            |
| Deno       | `@takos/deno-deploy`                                                                                                                                                      |
| Self-host  | `@takos/selfhost-filesystem`, `@takos/selfhost-minio`, `@takos/selfhost-docker-compose`, `@takos/selfhost-systemd`, `@takos/selfhost-postgres`, `@takos/selfhost-coredns` |

---

## 5. Production: split kernel and agent

For multi-host setups or stronger credential isolation, run the agent on a
separate host and have the kernel call it over HTTP:

### Agent host (holds cloud credentials)

```bash
# Set AWS / GCP / Cloudflare / Azure / k8s env
export AWS_ACCESS_KEY_ID=... AWS_REGION=...

takosumi runtime-agent serve --port 8789 --token mytoken
# stdout:
#   takosumi runtime-agent listening at http://127.0.0.1:8789
#     TAKOSUMI_AGENT_URL=http://127.0.0.1:8789
#     TAKOSUMI_AGENT_TOKEN=mytoken
```

`--env-file ./agent.env` loads env from a dotenv file.

### Kernel host (holds no cloud credentials)

```bash
export TAKOSUMI_ENVIRONMENT=production
export TAKOSUMI_DATABASE_URL=postgresql://prod-db.internal/takosumi
export TAKOSUMI_SECRET_STORE_PASSPHRASE=$(openssl rand -base64 32)
export TAKOSUMI_INSTALLER_TOKEN=$(openssl rand -hex 32)

# Connection info for the agent
export TAKOSUMI_AGENT_URL=https://agent.internal:8789
export TAKOSUMI_AGENT_TOKEN=mytoken

# External replication sink for audit logs
export TAKOSUMI_AUDIT_REPLICATION_KIND=s3
export TAKOSUMI_AUDIT_REPLICATION_S3_BUCKET=my-audit-logs
export TAKOSUMI_AUDIT_RETENTION_DAYS=365

takosumi migrate
takosumi server --no-agent --port 8788 &
```

`--no-agent` suppresses the kernel's embedded agent spawn (the agent runs on a
separate host in production, so the embedded one is unnecessary).

### Credential boundary

- The kernel only holds `TAKOSUMI_AGENT_URL` + `TAKOSUMI_AGENT_TOKEN`.
- AWS / GCP / etc. credentials **live only on the agent host**.
- Even if the kernel is compromised, cloud credentials do not leak.
- For multi-tenant setups you can split agents per cloud account.

---

## 6. CLI command reference

```
takosumi install <source>             # create Installation + first Deployment
takosumi install dry-run <source>     # dry-run a new install
takosumi deploy <installation-id>      # apply to an existing Installation
takosumi deploy dry-run <installation-id>
takosumi rollback <installation-id> <deployment-id>
takosumi server [--port 8788]         # start kernel + embedded agent
                [--no-agent]          # suppress embedded agent (production)
                [--agent-port 8789]   # set embedded agent port
takosumi runtime-agent serve          # start standalone agent (multi-host)
                [--port 8789]
                [--token <token>]
                [--env-file <path>]
takosumi migrate                      # DB migrations
takosumi version
```

The public contract is `.takosumi.yml` / Installation / Deployment plus the five
`/v1/installations/*` endpoints. Workflow runners and webhooks live outside the
kernel and pass AppSpec source to installer endpoints.

---

## 7. Troubleshooting

| Symptom                                                             | Cause                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Refusing to start takosumi with plaintext secret storage`          | Production mode without `TAKOSUMI_SECRET_STORE_PASSPHRASE` set                                                           |
| `Refusing to start takosumi against an unencrypted database`        | Production mode could not confirm DB at-rest encryption (dev can opt out via `TAKOSUMI_DEV_MODE=1`)                      |
| AppSpec schema error                                                | `.takosumi.yml` does not match the AppSpec schema                                                                        |
| 401 from `/v1/installations/*`                                      | `TAKOSUMI_INSTALLER_TOKEN` token mismatch                                                                                |
| `[takosumi-bootstrap] TAKOSUMI_AGENT_URL ... not set`               | `takosumi server --no-agent` is in use but the external agent URL is not exported, or the embedded agent failed to start |
| `runtime-agent /v1/lifecycle/apply failed: 404 connector_not_found` | The agent host is missing credentials for that cloud, so the connector is not registered                                 |
| `runtime-agent /v1/lifecycle/apply failed: 401`                     | `TAKOSUMI_AGENT_TOKEN` does not match between agent and kernel                                                           |

### Artifact storage hygiene

Blobs uploaded via `takosumi artifact push` stay in object storage as
content-addressed entries (`sha256:...`). Operators run a periodic GC to reclaim
artifacts that destroyed deployments used to pin:

```bash
takosumi artifact gc --dry-run    # show what would be deleted
takosumi artifact gc              # actually delete
```

The kernel runs a mark+sweep over persisted Deployment artifact references and
only deletes blobs that no Deployment references. The operation is idempotent,
so running it repeatedly is harmless.

### Artifact upload size cap

`POST /v1/artifacts` currently buffers the full multipart body in the kernel
process memory before writing it to object storage, so uploading a 50MB+ JS
bundle or Lambda zip naively can pressure kernel RAM. To guard against this, a
hard cap applies to the body size of a single upload:

| Env / Option                             | Default             | Description                                          |
| ---------------------------------------- | ------------------- | ---------------------------------------------------- |
| `TAKOSUMI_ARTIFACT_MAX_BYTES`            | `52428800` (50 MiB) | Upload byte limit read from env at kernel boot       |
| `RegisterArtifactRoutesOptions.maxBytes` | (same default)      | Programmatic override available for an embedded host |

Requests over the cap are rejected with `413 Payload Too Large`
(`error.code: "resource_exhausted"`). When `Content-Length` already exceeds the
cap, the kernel returns 413 immediately without reading the body, closing the
path that lets a hostile client OOM the kernel by sending an arbitrary body.

> If you need to ship artifacts above 50 MiB (large bundles / zips / OCI
> layers), either raise `TAKOSUMI_ARTIFACT_MAX_BYTES` and provision more RAM, or
> wire an external object-storage backend (R2 / S3 / GCS, etc.) into the
> kernel's `objectStorage` adapter and stream presigned uploads directly to the
> backend. The `ObjectStoragePort` interface stays the same, so swapping
> adapters is enough. Kernel-routed multipart upload is the capped buffered
> path; large artifacts should stream directly into the storage backend.

### Read-only artifact fetch token (agent ↔ kernel scope separation)

For production deploys that split `kernel <-> runtime-agent` across hosts, issue
a separate read-only artifact fetch token so a compromised agent host cannot
upload, delete, or GC artifacts:

```bash
# Kernel host (issue both the deploy token and a read-only fetch token)
export TAKOSUMI_DEPLOY_TOKEN=$(openssl rand -hex 32)
export TAKOSUMI_ARTIFACT_FETCH_TOKEN=$(openssl rand -hex 32)
```

- `TAKOSUMI_DEPLOY_TOKEN` is the artifact write token that authorizes
  `takosumi artifact push`, `takosumi artifact gc`, etc.
- Hand `TAKOSUMI_ARTIFACT_FETCH_TOKEN` to the agent host and the agent's
  connectors can fetch blobs via GET / HEAD `/v1/artifacts/:hash`, but POST
  (upload) / DELETE / GC return 401 from the kernel.
- The agent host only needs the fetch token for the artifact endpoint; it does
  not need the deploy token.

When the kernel passes an artifact-store locator to the runtime-agent (combined
with `TAKOSUMI_PUBLIC_BASE_URL`), it prefers the fetch token if one is set (and
uses the deploy token when no fetch token is configured).

---

## Related docs

- [AppSpec (JA)](../../reference/app-spec.md)
- [Kind catalog (JA)](../../reference/kind-catalog.md#component-kinds)
- [Provider plugins (JA)](../../reference/providers.md)
- [Operator bootstrap (JA)](/operator/bootstrap) (kernel ↔ agent integration
  details)
