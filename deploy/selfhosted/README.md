# Self-Hosted Takosumi Plugin

This directory contains operator-facing deployment notes for the self-hosted
profile. The plugin code does not import production backends into the Takosumi
kernel; operators inject concrete clients through the plugin client registry.

## Injected Client References

`operator.takos.selfhosted` accepts lower-level client references under its
`selfhosted` config object:

- `sqlClient`: Postgres-like SQL client for storage and queue documents.
- `objectClient`: filesystem, S3, or MinIO-compatible object client.
- `sourceClient`: source snapshot reader for local uploads or filesystem trees.
- `commandRunner`: Docker or Podman command runner.
- `routerWriter`: Caddyfile or Traefik dynamic config writer.
- `secretClient`: local encrypted or Vault-style secret client.
- `kmsClient`: Vault Transit or other KMS client.

Production and staging still fail closed for any kernel port not supplied by
these self-hosted clients or a normal adapter injection.

## Minimal Config Shape

```json
{
  "operator.takos.selfhosted": {
    "clients": {
      "auth": "selfhosted-auth",
      "coordination": "selfhosted-coordination",
      "notifications": "selfhosted-notifications",
      "operatorConfig": "selfhosted-operator-config",
      "observability": "selfhosted-observability",
      "runtimeAgent": "selfhosted-runtime-agent",
      "actor": "selfhosted-auth"
    },
    "selfhosted": {
      "sqlClient": "postgres",
      "objectClient": "minio-artifacts",
      "sourceClient": "filesystem-source",
      "commandRunner": "podman-runner",
      "containerEngine": "podman",
      "routerWriter": "caddy-writer",
      "routerKind": "caddy",
      "routerPath": "/etc/caddy/Caddyfile.d/takos.caddy",
      "secretClient": "vault-kv",
      "kmsClient": "vault-transit",
      "artifactBucket": "takos-artifacts"
    }
  }
}
```
