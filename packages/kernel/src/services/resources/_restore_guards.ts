import type {
  ResourceInstance,
  ResourceInstanceId,
} from "../../domains/resources/mod.ts";
import { conflict } from "../../shared/errors.ts";
import type { IsoTimestamp } from "../../shared/time.ts";

export interface RestoreResourceInput {
  readonly id?: string;
  readonly resourceInstanceId: ResourceInstanceId;
  readonly restoreRef: string;
  readonly mode: "snapshot" | "point-in-time" | "provider-native";
  readonly sourceBackupRef?: string;
  readonly sourceProviderResourceId?: string;
  readonly sourceProviderMaterializationId?: string;
  readonly expectedResourceGeneration?: number;
  readonly expectedProvider?: string;
  readonly expectedProviderResourceId?: string;
  readonly expectedProviderMaterializationId?: string;
  readonly checksum?: string;
  readonly completedAt?: IsoTimestamp;
}

export function assertRestoreAllowed(
  resource: ResourceInstance,
  input: RestoreResourceInput,
): void {
  if (resource.lifecycle.status === "deleting") {
    throw conflict("Deleting resources cannot be restored", {
      resourceInstanceId: resource.id,
      lifecycleStatus: resource.lifecycle.status,
    });
  }
  if (resource.lifecycle.status === "deleted") {
    throw conflict("Deleted resources cannot be restored", {
      resourceInstanceId: resource.id,
      lifecycleStatus: resource.lifecycle.status,
    });
  }
  if (resource.origin === "imported-bind-only") {
    throw conflict("Imported bind-only resources cannot be restored", {
      resourceInstanceId: resource.id,
      origin: resource.origin,
    });
  }
  if (resource.origin === "external") {
    throw conflict("External resources cannot be restored by Takos", {
      resourceInstanceId: resource.id,
      origin: resource.origin,
    });
  }
  if (resource.sharingMode === "shared-readonly") {
    throw conflict("Shared readonly resources cannot be restored", {
      resourceInstanceId: resource.id,
      sharingMode: resource.sharingMode,
    });
  }
  if (
    input.expectedResourceGeneration !== undefined &&
    input.expectedResourceGeneration !== resource.lifecycle.generation
  ) {
    throw conflict("Restore target generation changed", {
      resourceInstanceId: resource.id,
      expectedGeneration: input.expectedResourceGeneration,
      actualGeneration: resource.lifecycle.generation,
    });
  }
  if (input.mode !== "provider-native") return;
  if (!input.sourceBackupRef) {
    throw conflict("Provider-native restore requires provider backup ref", {
      resourceInstanceId: resource.id,
    });
  }
  if (!resource.provider || !resource.providerResourceId) {
    throw conflict(
      "Provider-native restore requires managed provider identity",
      {
        resourceInstanceId: resource.id,
        provider: resource.provider,
        providerResourceId: resource.providerResourceId,
      },
    );
  }
  assertExpectedValue("Provider-native restore provider changed", {
    resourceInstanceId: resource.id,
    expected: input.expectedProvider,
    actual: resource.provider,
    detailKey: "provider",
  });
  assertExpectedValue("Provider-native restore target changed", {
    resourceInstanceId: resource.id,
    expected: input.expectedProviderResourceId ??
      input.sourceProviderResourceId,
    actual: resource.providerResourceId,
    detailKey: "providerResourceId",
  });
  assertExpectedValue("Provider-native restore materialization changed", {
    resourceInstanceId: resource.id,
    expected: input.expectedProviderMaterializationId ??
      input.sourceProviderMaterializationId,
    actual: resource.providerMaterializationId,
    detailKey: "providerMaterializationId",
  });
}

function assertExpectedValue(
  message: string,
  input: {
    readonly resourceInstanceId: ResourceInstanceId;
    readonly expected?: string;
    readonly actual?: string;
    readonly detailKey: string;
  },
): void {
  if (input.expected === undefined) return;
  if (input.expected === input.actual) return;
  throw conflict(message, {
    resourceInstanceId: input.resourceInstanceId,
    expected: input.expected,
    actual: input.actual,
    detailKey: input.detailKey,
  });
}
