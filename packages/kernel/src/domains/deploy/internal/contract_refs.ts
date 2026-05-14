// Mapping from authoring-surface compute / resource / output / interface
// type aliases to the canonical contract references that downstream
// pipeline phases consume. Centralising the alias tables here keeps the
// validation phase and the spec-emit phase in sync.

import type { PublicComputeSpec } from "../types.ts";

export function inferComputeType(
  name: string,
  compute: PublicComputeSpec,
): string {
  if (compute.image !== undefined) return "service";
  throw new TypeError(
    `compute.${name} requires type or an image field`,
  );
}

export function runtimeContractRefFor(type: string): string {
  const normalized = type.toLowerCase();
  if (
    normalized === "runtime.oci-container@v1" ||
    normalized === "https://takosumi.com/contracts/runtime/oci-container/v1"
  ) {
    return "runtime.oci-container@v1";
  }
  if (
    normalized === "runtime.js-worker@v1" ||
    normalized === "https://takosumi.com/contracts/runtime/js-worker/v1"
  ) {
    return "runtime.js-worker@v1";
  }
  if (
    normalized === "container" || normalized === "oci-container" ||
    normalized === "service"
  ) {
    return "runtime.oci-container@v1";
  }
  if (normalized === "js-worker" || normalized === "worker") {
    return "runtime.js-worker@v1";
  }
  throw new TypeError(`DescriptorAliasAmbiguous: compute type ${type}`);
}

export function resourceContractRefFor(type: string): string {
  const normalized = type.toLowerCase();
  for (const contract of RESOURCE_CONTRACTS) {
    if (
      normalized === contract.ref ||
      normalized === contract.uri ||
      (contract.aliases as readonly string[]).includes(normalized)
    ) {
      return contract.ref;
    }
  }
  throw new TypeError(`DescriptorAliasAmbiguous: resource type ${type}`);
}

export const RESOURCE_CONTRACTS = [
  {
    ref: "resource.sql.postgres@v1",
    uri: "https://takosumi.com/contracts/resource/sql/postgres/v1",
    aliases: ["postgres", "sql.postgres"],
    defaultAccessMode: "database-url",
  },
  {
    ref: "resource.sql.sqlite-serverless@v1",
    uri: "https://takosumi.com/contracts/resource/sql/sqlite-serverless/v1",
    aliases: ["sql", "sqlite", "sql.sqlite-serverless"],
    defaultAccessMode: "sql-runtime-binding",
  },
  {
    ref: "resource.object-store.s3@v1",
    uri: "https://takosumi.com/contracts/resource/object-store/s3/v1",
    aliases: ["object-store", "s3", "object-store.s3"],
    defaultAccessMode: "object-runtime-binding",
  },
  {
    ref: "resource.key-value@v1",
    uri: "https://takosumi.com/contracts/resource/key-value/v1",
    aliases: ["key-value", "kv"],
    defaultAccessMode: "kv-runtime-binding",
  },
  {
    ref: "resource.queue.at-least-once@v1",
    uri: "https://takosumi.com/contracts/resource/queue/at-least-once/v1",
    aliases: ["queue", "queue.at-least-once"],
    defaultAccessMode: "queue-runtime-binding",
  },
  {
    ref: "resource.secret@v1",
    uri: "https://takosumi.com/contracts/resource/secret/v1",
    aliases: ["secret"],
    defaultAccessMode: "secret-env-binding",
  },
  {
    ref: "resource.vector-index@v1",
    uri: "https://takosumi.com/contracts/resource/vector-index/v1",
    aliases: ["vector-index"],
    defaultAccessMode: "vector-runtime-binding",
  },
  {
    ref: "resource.analytics-engine@v1",
    uri: "https://takosumi.com/contracts/resource/analytics-engine/v1",
    aliases: ["analytics-engine"],
    defaultAccessMode: "analytics-runtime-binding",
  },
  {
    ref: "resource.durable-object@v1",
    uri: "https://takosumi.com/contracts/resource/durable-object/v1",
    aliases: ["durable-object"],
    defaultAccessMode: "durable-object-runtime-binding",
  },
] as const;

export function resourceDefaultAccessModeFor(
  resourceContractRef: string,
): string {
  const contract = RESOURCE_CONTRACTS.find((item) =>
    item.ref === resourceContractRef
  );
  if (!contract) {
    throw new TypeError(
      `DescriptorAliasAmbiguous: resource type ${resourceContractRef}`,
    );
  }
  return contract.defaultAccessMode;
}

export function interfaceContractRefFor(protocol: string | undefined): string {
  const normalized = (protocol ?? "https").toLowerCase();
  if (normalized === "http" || normalized === "https") {
    return "interface.http@v1";
  }
  if (normalized === "tcp") return "interface.tcp@v1";
  if (normalized === "udp") return "interface.udp@v1";
  if (normalized === "queue") return "interface.queue@v1";
  throw new TypeError(`RouterProtocolUnsupported: ${normalized}`);
}

export function outputContractRefFor(type: string): string {
  const normalized = type.toLowerCase();
  if (
    normalized === "output.http-endpoint@v1" ||
    normalized === "https://takosumi.com/contracts/output/http-endpoint/v1"
  ) {
    return "output.http-endpoint@v1";
  }
  if (
    normalized === "output.mcp-server@v1" ||
    normalized === "https://takosumi.com/contracts/output/mcp-server/v1"
  ) {
    return "output.mcp-server@v1";
  }
  if (
    normalized === "output.topic@v1" ||
    normalized === "https://takosumi.com/contracts/output/topic/v1"
  ) {
    return "output.topic@v1";
  }
  throw new TypeError(`DescriptorAliasAmbiguous: output type ${type}`);
}
