# Quickstart — from git clone to first deploy

::: info Translation status Reference, operator, and extending docs remain in
Japanese. See the original [Quickstart (JA)](/getting-started/quickstart) for
cross-reference. :::

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

Create `manifest.yml` as an explicit compiled Shape manifest. Kernel manifests
use `resources[]` only; top-level `template` and `workflowRef` must be resolved
before the kernel request.

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: hello-worker
resources:
  - shape: worker@v1
    name: web
    provider: "@takos/selfhost-systemd"
    spec:
      artifact:
        kind: js-bundle
        hash: sha256:0123456789abcdef
      compatibilityDate: "2026-05-09"
      routes:
        - hello.local/*
```

```bash
takosumi doctor --manifest ./manifest.yml
takosumi deploy ./manifest.yml
```

`doctor` prints the manifest path, local / remote mode, and token state.

For a remote-kernel dev loop, make the URL/token explicit:

```bash
export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_TOKEN=$(openssl rand -hex 32)
export TAKOSUMI_REMOTE_URL=http://localhost:8788
takosumi server --port 8788 &
# stdout: "embedded runtime-agent listening at http://127.0.0.1:8789"
takosumi doctor --manifest ./manifest.yml
takosumi deploy ./manifest.yml
```

`TAKOSUMI_DEV_MODE=1` is the single dev opt-out flag. It permits plaintext
secrets, an unencrypted DB, and unsafe defaults. Production / staging stays
fail-closed.

In this dev-server mode, the agent and kernel share a process, so cloud
credentials exported into the env reach the agent connectors directly.

---

## 3. Self-hosted deploy (single VM, Docker / systemd)

A single-VM self-hosted deployment is still expressed as expanded `resources[]`
before it reaches the kernel.

`my-app.yml`:

```yaml
apiVersion: "1.0"
kind: Manifest
metadata:
  name: my-app
resources:
  - shape: database-postgres@v1
    name: db
    provider: "@takos/selfhost-postgres"
    spec:
      version: "16"
  - shape: web-service@v1
    name: api
    provider: "@takos/selfhost-docker-compose"
    spec:
      image: ghcr.io/me/api@sha256:0123456789abcdef
      port: 8080
      env:
        DATABASE_URL: ${secret-ref:db.connectionString}
  - shape: custom-domain@v1
    name: api-domain
    provider: "@takos/selfhost-coredns"
    spec:
      domain: api.example.com
      target: ${ref:api.endpoint}
```

Operator side (on the VM):

```bash
export TAKOSUMI_DATABASE_URL=postgresql://localhost/takosumi
export TAKOSUMI_ENCRYPTION_KEY=$(openssl rand -base64 32)
export TAKOSUMI_DEPLOY_TOKEN=$(openssl rand -hex 32)

# Selfhosted connector storage locations (optional, defaults exist)
export TAKOSUMI_SELFHOSTED_OBJECT_STORE_ROOT=/var/lib/takosumi/objects
export TAKOSUMI_SELFHOSTED_SYSTEMD_UNIT_DIR=/etc/systemd/system

takosumi server --port 8788 &
takosumi deploy my-app.yml \
  --remote http://localhost:8788 \
  --token $TAKOSUMI_DEPLOY_TOKEN
```

After the deploy completes (the embedded agent runs the selfhost connectors):

- The web service runs as a docker compose service.
- Postgres comes up via `docker run postgres` (local-docker-postgres connector).
- The assets bucket is created at `/var/lib/takosumi/objects/assets/`.
- The domain is registered in the local coredns zone.

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
export TAKOSUMI_ENCRYPTION_KEY=$(openssl rand -base64 32)
export TAKOSUMI_DEPLOY_TOKEN=$(openssl rand -hex 32)

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
takosumi deploy <manifest>            # apply (manifest path is required)
takosumi destroy <manifest>           # destroy in reverse order
takosumi status [<name>]              # current resource state
takosumi plan <manifest>              # dry-run
takosumi doctor --manifest <path>     # show manifest / mode / token
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

For a `.takosumi/`-based project layout, git push hooks, and a workflow runner
that builds artifacts and submits manifests, use the
[`takosumi-git`](https://github.com/tako0614/takosumi-git) sibling product. This
CLI stays a pure manifest deploy engine and always wants an explicit manifest
path.

---

## 7. Troubleshooting

| Symptom                                                                   | Cause                                                                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Refusing to start takosumi with plaintext secret storage`                | Production mode without `TAKOSUMI_ENCRYPTION_KEY` set                                                                    |
| `Refusing to start takosumi against an unencrypted database`              | Production mode could not confirm DB at-rest encryption (dev can opt out via `TAKOSUMI_DEV_MODE=1`)                      |
| `manifest.resources[] is required` / `manifest expands to zero resources` | No `resources[]`, or trying to apply only `resources: []`                                                                |
| 401 from `/v1/deployments`                                                | `TAKOSUMI_DEPLOY_TOKEN` unset or token mismatch                                                                          |
| `[takosumi-bootstrap] TAKOSUMI_AGENT_URL ... not set`                     | `takosumi server --no-agent` is in use but the external agent URL is not exported, or the embedded agent failed to start |
| `runtime-agent /v1/lifecycle/apply failed: 404 connector_not_found`       | The agent host is missing credentials for that cloud, so the connector is not registered                                 |
| `runtime-agent /v1/lifecycle/apply failed: 401`                           | `TAKOSUMI_AGENT_TOKEN` does not match between agent and kernel                                                           |

Starting in 0.10, every provider id Takosumi ships is namespaced as
`@takos/<cloud>-<service>`. This avoids the last-write-wins collision that
happens when two operator plugins re-register the same bare id.

| ----------------------- | -------------------------------- | | `aws-s3` |
`@takos/aws-s3` | | `aws-fargate` | `@takos/aws-fargate` | | `aws-rds` |
`@takos/aws-rds` | | `route53` | `@takos/aws-route53` | | `gcp-gcs` |
`@takos/gcp-gcs` | | `cloud-run` | `@takos/gcp-cloud-run` | | `cloud-sql` |
`@takos/gcp-cloud-sql` | | `cloud-dns` | `@takos/gcp-cloud-dns` | |
`cloudflare-r2` | `@takos/cloudflare-r2` | | `cloudflare-container` |
`@takos/cloudflare-container` | | `cloudflare-workers` |
`@takos/cloudflare-workers` | | `cloudflare-dns` | `@takos/cloudflare-dns` | |
`azure-container-apps` | `@takos/azure-container-apps` | | `k3s-deployment` |
`@takos/kubernetes-deployment` | | `deno-deploy` | `@takos/deno-deploy` | |
`filesystem` | `@takos/selfhost-filesystem` | | `minio` |
`@takos/selfhost-minio` | | `docker-compose` | `@takos/selfhost-docker-compose`
| | `systemd-unit` | `@takos/selfhost-systemd` | | `local-docker-postgres` |
`@takos/selfhost-postgres` | | `coredns-local` | `@takos/selfhost-coredns` |

The old ids are still accepted in 0.10 / 0.11, but the kernel logs a warning:

```
use "@takos/aws-fargate" — bare ids will be rejected in 0.12.
```

Ids that already start with `@` are never rewritten. 0.12 drops the old-id path
entirely, so rewrite the `provider:` values in your manifests to the new form.

### Artifact storage hygiene

Blobs uploaded via `takosumi artifact push` stay in object storage as
content-addressed entries (`sha256:...`). Operators run a periodic GC to reclaim
artifacts that destroyed deployments used to pin:

```bash
takosumi artifact gc --dry-run    # show what would be deleted
takosumi artifact gc              # actually delete
```

The kernel runs a mark+sweep over the persistent `takosumi_deployments` records
and only deletes blobs that no deployment record references (whether its status
is `applied` or `destroyed`). The operation is idempotent, so running it
repeatedly is harmless.

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

- `TAKOSUMI_DEPLOY_TOKEN` is the full-power token that authorizes write
  operations from the CLI: `takosumi deploy`, `takosumi artifact push`,
  `takosumi artifact gc`, etc.
- Hand `TAKOSUMI_ARTIFACT_FETCH_TOKEN` to the agent host and the agent's
  connectors can fetch blobs via GET / HEAD `/v1/artifacts/:hash`, but POST
  (upload) / DELETE / GC return 401 from the kernel.
- The agent host only needs the fetch token for the artifact endpoint; it does
  not need the deploy token.

When the kernel passes an artifact-store locator to the runtime-agent (combined
with `TAKOSUMI_PUBLIC_BASE_URL`), it prefers the fetch token if one is set (and
falls back to the deploy token for backward compatibility when it is not).

---

## Related docs

- [Manifest spec (JA)](/manifest)
- [Shape catalog (JA)](/reference/shapes)
- [Provider plugins (JA)](/reference/providers)
- [Templates (JA)](/reference/templates)
- [Operator bootstrap (JA)](/operator/bootstrap) (kernel ↔ agent integration
  details)
