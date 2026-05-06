# Takos GCP Provider Runbook

This directory documents the GCP operator shape for `operator.takos.gcp`. The
plugin package does not create GCP SDK clients or read credentials from the
kernel. Operators either inject concrete adapter instances directly or run an
operator-owned HTTP gateway and use `GcpHttpGatewayClient`.

## Required Runtime Shape

- Storage: inject a transactional Takos `StorageDriver`; the generic HTTP
  gateway client cannot carry callback-based storage transactions.
- Object storage: GCS-compatible client behind `GcpObjectStorageClient`.
- Queue: Pub/Sub-compatible client behind `GcpQueueClient`.
- KMS and secrets: Cloud KMS/Secret Manager clients behind the typed interfaces.
- Provider/router/observability/runtime-agent: operator gateway or direct
  clients that satisfy the exported GCP interfaces.

## Gateway Smoke

```sh
TAKOSUMI_PLUGIN_LIVE_PROVIDER=gcp \
TAKOSUMI_PLUGIN_GCP_GATEWAY_URL=https://operator-gateway.example/gcp \
TAKOSUMI_PLUGIN_GCP_GATEWAY_BEARER_TOKEN=replace-me \
deno task live-smoke
```

The live smoke calls the provider operation list endpoint only. Full production
boot still requires a `KernelPluginClientRegistry` with every selected port.
