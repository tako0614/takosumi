# Takos AWS Provider Runbook

This directory documents the AWS operator shape for `operator.takos.aws`. The
plugin package does not create AWS SDK clients or read credentials from the
kernel. Operators either inject concrete adapter instances directly or run an
operator-owned HTTP gateway and use `AwsHttpGatewayClient`.

## Required Runtime Shape

- Storage: inject a transactional Takos `StorageDriver`; the generic HTTP
  gateway client cannot carry callback-based storage transactions.
- Object storage: S3-compatible client behind `AwsObjectStorageClient`.
- Queue: SQS-compatible client behind `AwsQueueClient`.
- KMS and secrets: KMS/Secrets Manager clients behind the typed interfaces.
- Provider/router/observability/runtime-agent: operator gateway or direct
  clients that satisfy the exported AWS interfaces.

## Gateway Smoke

```sh
TAKOS_PAAS_PLUGIN_LIVE_PROVIDER=aws \
TAKOS_PAAS_PLUGIN_AWS_GATEWAY_URL=https://operator-gateway.example/aws \
TAKOS_PAAS_PLUGIN_AWS_GATEWAY_BEARER_TOKEN=replace-me \
deno task live-smoke
```

The live smoke calls the provider operation list endpoint only. Full production
boot still requires a `KernelPluginClientRegistry` with every selected port.
