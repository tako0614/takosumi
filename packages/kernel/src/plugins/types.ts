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
  createAdapters(
    context: KernelPluginCreateAdaptersContext,
  ): KernelPluginAdapterOverrides;
}

export interface KernelPluginRegistry {
  list(): readonly TakosPaaSKernelPlugin[];
  get(id: string): TakosPaaSKernelPlugin | undefined;
}
