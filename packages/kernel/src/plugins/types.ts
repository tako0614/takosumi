import type {
  KernelPluginInitContext,
  TakosumiKernelPluginManifest,
} from "takosumi-contract";
import type { AppAdapters } from "../app_context.ts";

export type KernelPluginAdapterOverrides = Partial<AppAdapters>;

export interface KernelPluginCreateAdaptersContext
  extends KernelPluginInitContext {
  readonly clock: () => Date;
  readonly idGenerator: () => string;
}

export interface TakosPaaSKernelPlugin {
  readonly manifest: TakosumiKernelPluginManifest;
  readonly trustedInstall?: TrustedKernelPluginSelectionMetadata;
  createAdapters(
    context: KernelPluginCreateAdaptersContext,
  ): KernelPluginAdapterOverrides;
}

export interface TrustedKernelPluginSelectionMetadata {
  readonly source: "trusted-signed-manifest";
  readonly keyId: string;
  readonly publisherId: string;
  readonly signatureAlgorithm: string;
}

export interface KernelPluginRegistry {
  list(): readonly TakosPaaSKernelPlugin[];
  get(id: string): TakosPaaSKernelPlugin | undefined;
}
