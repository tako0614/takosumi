/**
 * Stable list of descriptor IDs the self-hosted provider can materialize.
 * Plugin registry / profile composition reads this list to build the
 * provider-support report consumed by descriptor pinning.
 */
export type SelfHostedProviderDescriptorId =
  | "provider.selfhosted.postgres@v1"
  | "provider.selfhosted.object-storage@v1";

export const SELFHOSTED_PROVIDER_DESCRIPTORS:
  readonly SelfHostedProviderDescriptorId[] = Object.freeze([
    "provider.selfhosted.postgres@v1",
    "provider.selfhosted.object-storage@v1",
  ]);

export interface SelfHostedPostgresDescriptorBinding {
  readonly descriptor: "provider.selfhosted.postgres@v1";
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly passwordSecretRef?: string;
  readonly tlsMode?: "disable" | "require" | "verify-ca" | "verify-full";
}

export interface SelfHostedObjectStorageDescriptorBinding {
  readonly descriptor: "provider.selfhosted.object-storage@v1";
  readonly endpoint: string;
  readonly region?: string;
  readonly bucket: string;
  readonly accessKeyIdSecretRef?: string;
  readonly secretAccessKeySecretRef?: string;
  readonly forcePathStyle?: boolean;
}

export type SelfHostedDescriptorBinding =
  | SelfHostedPostgresDescriptorBinding
  | SelfHostedObjectStorageDescriptorBinding;
