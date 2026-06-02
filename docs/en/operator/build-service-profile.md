# Build Service Example {#operator-build-service-profile}

This page is a non-normative operator configuration example. Takosumi does
not interpret build profiles. An operator build service can read any profile,
produce a prepared source payload, and submit its URL and digest to the
Installer API.

## Example Input Shape

```yaml
apiVersion: v1
metadata:
  id: com.example.notes.build
  name: Example Notes build
nodes:
  web:
    kind: linux-container
    spec:
      image: ghcr.io/example/build-node@sha256:...
      command: bun install --frozen-lockfile && bun run build
      workingDir: .
    dependsOn: []
```

This `kind` is build-service vocabulary. It is not a Takosumi public source
contract.

## Handoff Responsibilities

The build service:

- pins the source checkout
- runs build nodes in dependency order
- creates a prepared source payload
- computes payload digest and optional artifact digest
- records provenance, cache keys, SBOMs, signatures, and approvals as operator records
- calls the Installer API with `source.kind: "prepared"`

Installer apply verifies payload digest, path safety, size caps, and operator
binding selection before resource side effects. Build failures, container image
verification, secret mounts, network policy, and OpenTofu plans are
operator scope.

## Example Handoff

```json
{
  "source": {
    "kind": "prepared",
    "url": "https://build.example/artifacts/example-notes.tar.gz",
    "digest": "sha256:..."
  },
  "bindings": [
    {
      "name": "runtime",
      "service": "runtime.primary"
    }
  ]
}
```

## Related Pages

- [Build Service Boundary](../reference/build-spec.md)
- [Installer API](../reference/installer-api.md)
