import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";
import {
  GCP_CLOUD_RUN_DESCRIPTOR,
  GcpCloudRunProviderMaterializer,
  type GcpCloudRunProviderOptions,
} from "./cloud_run.ts";
import {
  GCP_CLOUD_SQL_DESCRIPTOR,
  GcpCloudSqlProviderMaterializer,
  type GcpCloudSqlProviderOptions,
} from "./cloud_sql.ts";
import {
  GCP_GCS_DESCRIPTOR,
  GcpGcsProviderMaterializer,
  type GcpGcsProviderOptions,
} from "./gcs.ts";
import {
  GCP_PUBSUB_DESCRIPTOR,
  GcpPubSubProviderMaterializer,
  type GcpPubSubProviderOptions,
} from "./pubsub.ts";
import {
  GCP_KMS_DESCRIPTOR,
  GcpKmsProviderMaterializer,
  type GcpKmsProviderOptions,
} from "./kms.ts";
import {
  GCP_SECRET_MANAGER_DESCRIPTOR,
  GcpSecretManagerProviderMaterializer,
  type GcpSecretManagerProviderOptions,
} from "./secret_manager.ts";

/** Descriptor identifiers shipped by the GCP provider profile. */
export const GCP_PROVIDER_DESCRIPTORS = [
  GCP_CLOUD_RUN_DESCRIPTOR,
  GCP_CLOUD_SQL_DESCRIPTOR,
  GCP_GCS_DESCRIPTOR,
  GCP_PUBSUB_DESCRIPTOR,
  GCP_KMS_DESCRIPTOR,
  GCP_SECRET_MANAGER_DESCRIPTOR,
] as const;

export type GcpProviderDescriptor = (typeof GCP_PROVIDER_DESCRIPTORS)[number];

/**
 * Bundle of provider materializer options. Each entry is optional so operators
 * can wire only the GCP services they actually deploy. The composite
 * materializer routes a desired-state to the descriptor selected via the
 * top-level `defaultDescriptor` (or a runtime-attached descriptor hint).
 */
export interface GcpProviderBundleOptions {
  readonly defaultDescriptor?: GcpProviderDescriptor;
  readonly cloudRun?: GcpCloudRunProviderOptions;
  readonly cloudSql?: GcpCloudSqlProviderOptions;
  readonly gcs?: GcpGcsProviderOptions;
  readonly pubsub?: GcpPubSubProviderOptions;
  readonly kms?: GcpKmsProviderOptions;
  readonly secretManager?: GcpSecretManagerProviderOptions;
}

export interface GcpProviderBundle {
  readonly cloudRun?: GcpCloudRunProviderMaterializer;
  readonly cloudSql?: GcpCloudSqlProviderMaterializer;
  readonly gcs?: GcpGcsProviderMaterializer;
  readonly pubsub?: GcpPubSubProviderMaterializer;
  readonly kms?: GcpKmsProviderMaterializer;
  readonly secretManager?: GcpSecretManagerProviderMaterializer;
}

export function createGcpProviderBundle(
  options: GcpProviderBundleOptions,
): GcpProviderBundle {
  return {
    cloudRun: options.cloudRun
      ? new GcpCloudRunProviderMaterializer(options.cloudRun)
      : undefined,
    cloudSql: options.cloudSql
      ? new GcpCloudSqlProviderMaterializer(options.cloudSql)
      : undefined,
    gcs: options.gcs ? new GcpGcsProviderMaterializer(options.gcs) : undefined,
    pubsub: options.pubsub
      ? new GcpPubSubProviderMaterializer(options.pubsub)
      : undefined,
    kms: options.kms ? new GcpKmsProviderMaterializer(options.kms) : undefined,
    secretManager: options.secretManager
      ? new GcpSecretManagerProviderMaterializer(options.secretManager)
      : undefined,
  };
}

/**
 * Composite GCP materializer dispatching to the descriptor-specific
 * materializer. The descriptor is read from
 * `desiredState.workloads[0].labels["takos.paas/provider-descriptor"]` when
 * available, falling back to `options.defaultDescriptor`. The composite
 * surfaces the union of recorded operations from each registered child.
 */
export class GcpCompositeProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #bundle: GcpProviderBundle;
  readonly #defaultDescriptor: GcpProviderDescriptor;

  constructor(options: GcpProviderBundleOptions) {
    if (!options.defaultDescriptor) {
      throw new Error(
        "GcpCompositeProviderMaterializer requires options.defaultDescriptor",
      );
    }
    this.#bundle = createGcpProviderBundle(options);
    this.#defaultDescriptor = options.defaultDescriptor;
  }

  materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    const descriptor = this.#descriptorFor(desiredState);
    const materializer = this.#materializerFor(descriptor);
    if (!materializer) {
      throw new Error(
        `GCP composite materializer has no registration for descriptor ${descriptor}`,
      );
    }
    return materializer.materialize(desiredState);
  }

  async listRecordedOperations(): Promise<
    readonly provider.ProviderOperation[]
  > {
    const operations: provider.ProviderOperation[] = [];
    for (const child of this.#children()) {
      operations.push(...(await child.listRecordedOperations()));
    }
    return operations;
  }

  async clearRecordedOperations(): Promise<void> {
    for (const child of this.#children()) {
      await child.clearRecordedOperations();
    }
  }

  #descriptorFor(desiredState: RuntimeDesiredState): GcpProviderDescriptor {
    const workload = desiredState.workloads[0];
    const hint = workload && hintFromWorkload(workload);
    if (hint && isGcpDescriptor(hint)) return hint;
    return this.#defaultDescriptor;
  }

  #materializerFor(
    descriptor: GcpProviderDescriptor,
  ): provider.ProviderMaterializer | undefined {
    switch (descriptor) {
      case GCP_CLOUD_RUN_DESCRIPTOR:
        return this.#bundle.cloudRun;
      case GCP_CLOUD_SQL_DESCRIPTOR:
        return this.#bundle.cloudSql;
      case GCP_GCS_DESCRIPTOR:
        return this.#bundle.gcs;
      case GCP_PUBSUB_DESCRIPTOR:
        return this.#bundle.pubsub;
      case GCP_KMS_DESCRIPTOR:
        return this.#bundle.kms;
      case GCP_SECRET_MANAGER_DESCRIPTOR:
        return this.#bundle.secretManager;
    }
  }

  #children(): readonly provider.ProviderMaterializer[] {
    const candidates: ReadonlyArray<provider.ProviderMaterializer | undefined> =
      [
        this.#bundle.cloudRun,
        this.#bundle.cloudSql,
        this.#bundle.gcs,
        this.#bundle.pubsub,
        this.#bundle.kms,
        this.#bundle.secretManager,
      ];
    return candidates.filter((child): child is provider.ProviderMaterializer =>
      child !== undefined
    );
  }
}

function hintFromWorkload(
  workload: RuntimeDesiredState["workloads"][number],
): string | undefined {
  const candidate = workload as unknown as {
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  return candidate.labels?.["takos.paas/provider-descriptor"] ??
    candidate.annotations?.["takos.paas/provider-descriptor"];
}

function isGcpDescriptor(value: string): value is GcpProviderDescriptor {
  return (GCP_PROVIDER_DESCRIPTORS as readonly string[]).includes(value);
}
