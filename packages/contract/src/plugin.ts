import type { JsonObject, JsonValue } from "./types.ts";

export const TAKOSUMI_KERNEL_PLUGIN_API_VERSION = "2026-04-29";

export type KernelPluginPortKind =
  | "auth"
  | "coordination"
  | "kms"
  | "notification"
  | "object-storage"
  | "operator-config"
  | "provider"
  | "queue"
  | "router-config"
  | "secret-store"
  | "source"
  | "storage"
  | "observability"
  | "runtime-agent";

export type KernelPluginIoBoundary =
  | "none"
  | "filesystem"
  | "process"
  | "network"
  | "provider-control-plane";

export interface KernelPluginCapability {
  readonly port: KernelPluginPortKind;
  readonly kind: string;
  readonly externalIo: readonly KernelPluginIoBoundary[];
  readonly description?: string;
}

export interface TakosumiKernelPluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kernelApiVersion: string;
  readonly capabilities: readonly KernelPluginCapability[];
  readonly metadata?: JsonObject;
}

export interface KernelPluginInitContext {
  readonly kernelApiVersion: string;
  readonly environment: string;
  readonly processRole: string;
  readonly selectedPluginIds: Partial<Record<KernelPluginPortKind, string>>;
  readonly operatorConfig?: Record<string, JsonValue>;
  readonly clientRegistry?: KernelPluginClientRegistry;
}

export interface KernelPluginClientRegistry {
  get<T = unknown>(ref: string): T | undefined;
}
