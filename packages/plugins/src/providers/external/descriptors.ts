/**
 * Stable list of descriptor IDs the external provider can materialize.
 * Plugin registry / profile composition reads this list to build the
 * provider-support report consumed by descriptor pinning.
 */
export type ExternalProviderDescriptorId =
  | "provider.external.postgres@v1"
  | "provider.external.object-storage@v1";

export const EXTERNAL_PROVIDER_DESCRIPTORS:
  readonly ExternalProviderDescriptorId[] = Object.freeze([
    "provider.external.postgres@v1",
    "provider.external.object-storage@v1",
  ]);

export interface ExternalPostgresDescriptorBinding {
  readonly descriptor: "provider.external.postgres@v1";
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly passwordSecretRef?: string;
  readonly tlsMode?: "disable" | "require" | "verify-ca" | "verify-full";
}

export interface ExternalObjectStorageDescriptorBinding {
  readonly descriptor: "provider.external.object-storage@v1";
  readonly endpoint: string;
  readonly region?: string;
  readonly bucket: string;
  readonly accessKeyIdSecretRef?: string;
  readonly secretAccessKeySecretRef?: string;
  readonly forcePathStyle?: boolean;
}

export type ExternalDescriptorBinding =
  | ExternalPostgresDescriptorBinding
  | ExternalObjectStorageDescriptorBinding;
