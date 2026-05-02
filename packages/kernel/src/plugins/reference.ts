import {
  TAKOS_PAAS_KERNEL_PLUGIN_API_VERSION,
  type TakosPaaSKernelPluginManifest,
} from "takosumi-contract";
import { LocalActorAdapter } from "../adapters/auth/mod.ts";
import { MemoryCoordinationAdapter } from "../adapters/coordination/mod.ts";
import { NoopTestKms } from "../adapters/kms/mod.ts";
import { MemoryNotificationSink } from "../adapters/notification/mod.ts";
import { MemoryObjectStorage } from "../adapters/object-storage/mod.ts";
import { LocalOperatorConfig } from "../adapters/operator-config/mod.ts";
import { NoopProviderMaterializer } from "../adapters/provider/mod.ts";
import { MemoryQueueAdapter } from "../adapters/queue/mod.ts";
import { InMemoryRouterConfigAdapter } from "../adapters/router/mod.ts";
import { MemoryEncryptedSecretStore } from "../adapters/secret-store/mod.ts";
import { ImmutableManifestSourceAdapter } from "../adapters/source/mod.ts";
import { MemoryStorageDriver } from "../adapters/storage/mod.ts";
import { InMemoryRuntimeAgentRegistry } from "../agents/mod.ts";
import { InMemoryObservabilitySink } from "../services/observability/mod.ts";
import type { TakosPaaSKernelPlugin } from "./types.ts";

export const referenceKernelPluginManifest: TakosPaaSKernelPluginManifest = {
  id: "takos.kernel.reference",
  name: "Takos Kernel Reference Adapters",
  version: "1.0.0",
  kernelApiVersion: TAKOS_PAAS_KERNEL_PLUGIN_API_VERSION,
  capabilities: [
    {
      port: "auth",
      kind: "local",
      externalIo: ["none"],
      description: "Accepts local/test actor headers for kernel tests.",
    },
    {
      port: "coordination",
      kind: "memory",
      externalIo: ["none"],
      description: "Provides in-memory coordination for conformance tests.",
    },
    {
      port: "kms",
      kind: "noop",
      externalIo: ["none"],
      description: "Provides a no-op KMS envelope for kernel tests.",
    },
    {
      port: "notification",
      kind: "memory",
      externalIo: ["none"],
      description: "Records notifications in memory for kernel tests.",
    },
    {
      port: "observability",
      kind: "memory",
      externalIo: ["none"],
      description: "Records observability events in memory.",
    },
    {
      port: "object-storage",
      kind: "memory",
      externalIo: ["none"],
      description: "Stores artifact bytes in memory for kernel tests.",
    },
    {
      port: "operator-config",
      kind: "local",
      externalIo: ["none"],
      description: "Provides local operator configuration for kernel tests.",
    },
    {
      port: "provider",
      kind: "noop",
      externalIo: ["none"],
      description: "Records deterministic no-op provider plans.",
    },
    {
      port: "queue",
      kind: "memory",
      externalIo: ["none"],
      description: "Provides in-memory queue semantics for conformance tests.",
    },
    {
      port: "router-config",
      kind: "memory",
      externalIo: ["none"],
      description: "Stores router config projections in memory.",
    },
    {
      port: "runtime-agent",
      kind: "in-process",
      externalIo: ["none"],
      description: "Declares in-process runtime-agent conformance only.",
    },
    {
      port: "secret-store",
      kind: "memory",
      externalIo: ["none"],
      description: "Provides an in-memory encrypted secret boundary.",
    },
    {
      port: "source",
      kind: "manifest",
      externalIo: ["none"],
      description: "Snapshots inline manifests as immutable source records.",
    },
    {
      port: "storage",
      kind: "memory",
      externalIo: ["none"],
      description: "Provides transactional in-memory kernel stores.",
    },
  ],
};

export function createReferenceKernelPlugin(): TakosPaaSKernelPlugin {
  return {
    manifest: referenceKernelPluginManifest,
    createAdapters(context) {
      const auth = new LocalActorAdapter();
      return {
        auth,
        coordination: new MemoryCoordinationAdapter({
          clock: context.clock,
          idGenerator: context.idGenerator,
        }),
        kms: new NoopTestKms({
          clock: context.clock,
          idGenerator: context.idGenerator,
        }),
        notifications: new MemoryNotificationSink({
          clock: context.clock,
          idGenerator: context.idGenerator,
        }),
        observability: new InMemoryObservabilitySink(),
        objectStorage: new MemoryObjectStorage({ clock: context.clock }),
        operatorConfig: new LocalOperatorConfig({ clock: context.clock }),
        provider: new NoopProviderMaterializer({
          clock: context.clock,
          idGenerator: context.idGenerator,
        }),
        queue: new MemoryQueueAdapter({
          clock: context.clock,
          idGenerator: context.idGenerator,
        }),
        routerConfig: new InMemoryRouterConfigAdapter({
          clock: context.clock,
        }),
        runtimeAgent: new InMemoryRuntimeAgentRegistry({
          clock: context.clock,
          idGenerator: context.idGenerator,
        }),
        secrets: new MemoryEncryptedSecretStore({
          clock: context.clock,
          idGenerator: context.idGenerator,
        }),
        source: new ImmutableManifestSourceAdapter({
          clock: context.clock,
          idGenerator: context.idGenerator,
        }),
        storage: new MemoryStorageDriver(),
      };
    },
  };
}
