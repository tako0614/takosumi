import type { CoreBindingResolutionInput } from "takosumi-contract/reference/compat";
import { sha256Digest } from "../../adapters/source/digest.ts";
import type {
  ResourceBindingRole,
  ResourceInstance,
  SecretBindingRef,
} from "./mod.ts";
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
  return await sha256Digest(new TextEncoder().encode(stableStringify(inputs)));
}

// Binding-resolution structure digests intentionally omit undefined-valued
// fields (e.g. an absent optional `access` ref) so an optional field's
// presence does not change the persisted digest. This differs from the
// canonical `stableStringify` in digest.ts (which keeps undefined keys), so
// the normalization stays local while the hashing routes through the shared
// `sha256Digest` helper.
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
