import type { CoreBindingResolutionInput } from "takosumi-contract";
import type {
  ResourceBindingRole,
  ResourceInstance,
  SecretBindingRef,
} from "../../domains/resources/mod.ts";
import type {
  SecretRecord,
  SecretStorePort,
} from "../../adapters/secret-store/mod.ts";

export async function resolveSecretVersion(
  store: SecretStorePort,
  binding: SecretBindingRef,
): Promise<{ readonly record?: SecretRecord; readonly unavailable?: string }> {
  if (binding.resolution === "pinned-version") {
    const version = binding.pinnedVersionId;
    if (!version) {
      return {
        unavailable: `Pinned secret ${binding.secretName} has no version`,
      };
    }
    const record = await store.getSecretRecord({
      name: binding.secretName,
      version,
    });
    return record ? { record } : {
      unavailable:
        `Pinned secret version ${version} for ${binding.secretName} is unavailable`,
    };
  }
  const record = await store.latestSecret(binding.secretName);
  return record ? { record } : {
    unavailable:
      `Latest secret version for ${binding.secretName} is unavailable`,
  };
}

export function revokedReason(
  record: SecretRecord | undefined,
): string | undefined {
  if (!record) return undefined;
  const status = record.metadata.status;
  if (status === "revoked") return "status=revoked";
  const revokedAt = record.metadata.revokedAt;
  if (typeof revokedAt === "string") return `revokedAt=${revokedAt}`;
  return undefined;
}

export function compareBindingInput(
  a: CoreBindingResolutionInput,
  b: CoreBindingResolutionInput,
): number {
  return a.bindingName.localeCompare(b.bindingName) ||
    a.sourceAddress.localeCompare(b.sourceAddress);
}

export function defaultBindingRole(
  instance: ResourceInstance,
): ResourceBindingRole {
  if (instance.origin === "imported-bind-only") return "bind-only";
  if (instance.sharingMode === "shared-readonly") return "readonly-consumer";
  return "owner";
}

export async function structureDigest(
  inputs: readonly CoreBindingResolutionInput[],
): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(inputs));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${
    Array.from(new Uint8Array(digest)).map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${
      entries.map(([key, item]) =>
        `${JSON.stringify(key)}:${stableStringify(item)}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
