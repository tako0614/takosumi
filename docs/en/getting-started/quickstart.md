# Quickstart {#quickstart}

This local walkthrough covers manifest validation and the Deployment ledger. Public application endpoints need an operator environment with a gateway or ingress implementation.

## Prerequisites

- [Deno](https://docs.deno.com/runtime/getting_started/installation/) 2.x or later

## 1. Install the CLI

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
takosumi version
```

## 2. Create a Source Root

```bash
mkdir hello-takosumi && cd hello-takosumi
mkdir -p src
```

`src/worker.ts`

```ts
export default {
  fetch() {
    return new Response("hello from takosumi");
  },
};
```

`.takosumi.yml`

```yaml
apiVersion: v1
metadata:
  id: com.example.hello
  name: Hello Takosumi
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
```

## 3. Start the Local Dev Server

Takosumi has a server and a CLI that run separately. During development, start the server in the background and use the CLI from another shell.

In another shell:

```bash
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
TAKOSUMI_DEV_MODE=1 takosumi server --port 8788
```

`TAKOSUMI_INSTALLER_TOKEN` is the API authentication token. For local development, use the fixed value `dev-installer-token`.

Back in the source root:

```bash
cd /path/to/hello-takosumi
export APP_ROOT="$PWD"
export TAKOSUMI_REMOTE_URL=http://localhost:8788
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
```

## 4. Dry Run

```bash
takosumi install dry-run --space space_personal --source "$APP_ROOT"
```

On success, look at `changes[]` (planned diff) and `expected.manifestDigest` (drift guard for the next apply).

```json
{
  "manifestDigest": "sha256:...",
  "changes": [{ "op": "create", "component": "web", "kind": "worker" }],
  "expected": { "manifestDigest": "sha256:..." }
}
```

`changes` lists the components that will be created. `manifestDigest` is a hash that identifies the source. When you apply, this digest is checked to confirm the source has not changed since the dry-run.

## 5. Install

```bash
takosumi install --space space_personal --source "$APP_ROOT"
```

To apply exactly the manifest reviewed by dry-run:

```bash
takosumi install --space space_personal --source "$APP_ROOT" \
  --expected-manifest-digest sha256:<from-dry-run>
```

A successful apply returns an Installation ID and a Deployment id.

```json
{
  "installation": { "id": "inst_...", "status": "ready" },
  "deployment": { "id": "dep_...", "status": "succeeded" }
}
```

This completes the local ledger quickstart. Public app endpoints are only created in operator environments with a gateway or ingress provider.

Next: [Connect Components and HTTP Exposure](./next-steps.md)

- [Concepts](./concepts.md)
- [Manifest](../reference/manifest.md)
- [Operator Overview](../operator/index.md)
