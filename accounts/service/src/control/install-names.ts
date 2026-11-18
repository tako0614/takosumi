import type { InstallConfig } from "takosumi-contract/install-configs";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";

const GENERATED_NAME = /^app-[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** `https://github.com/o/my_App.git` → `my-app`; never empty. */
export function repositorySourceName(url: string): string {
  const last = url
    .replace(/[?#].*$/u, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "")
    .split(/[/:]/u)
    .filter((part) => part.length > 0)
    .at(-1) ?? "";
  const slug = last
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 63)
    .replace(/-$/u, "");
  return slug || "app";
}

/** A DNS-compatible name that does not reveal or depend on the repository. */
export function newInstallName(): string {
  return `app-${crypto.randomUUID()}`;
}

/** Stable fallback for an explicit or historical name that has been taken. */
export async function alternateInstallName(workspaceId: string, planId: string): Promise<string> {
  const hash = (await stableJsonDigest(["takosumi/install-name", workspaceId, planId])).slice(7, 39);
  // UUIDv8 with the RFC variant and a namespace-bound SHA-256 payload.
  const variant = ((Number.parseInt(hash[16]!, 16) & 3) | 8).toString(16);
  return `app-${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Display metadata is independent from the technical name and its uniqueness. */
export function installDisplayName(
  name: string,
  config: InstallConfig | undefined,
  sourceUrl = config?.sourceSelector?.url,
): { readonly en: string; readonly ja: string } | undefined {
  if (config?.store) return config.store.name;
  if (GENERATED_NAME.test(name) && sourceUrl) {
    const label = repositorySourceName(sourceUrl);
    return { en: label, ja: label };
  }
  return undefined;
}
