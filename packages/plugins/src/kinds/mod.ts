/**
 * Bundled component kind catalog. The curated 4 kinds (`worker /
 * postgres / object-store / custom-domain`) are defined under
 * `spec/contexts/kinds/v1/*.jsonld` and surfaced here as runtime
 * `Shape` descriptors for `registerTakosumiKinds()`.
 *
 * `WebServiceKind` is **NOT** part of the curated bundled catalog. It
 * is retained as a backward-compat export for existing provider plugin
 * code paths that still reference the legacy `web-service` shape, but
 * intentionally excluded from `TAKOSUMI_BUNDLED_KINDS` so the runtime
 * catalog matches the JSON-LD source-of-truth.
 *
 * Each curated kind exports a `*Kind` descriptor; the v1 AppSpec
 * installer pipeline materializes components through provider plugins
 * keyed off `Component.kind`.
 *
 * `oidc` is no longer a built-in kernel kind — it moved to Takosumi
 * Accounts (operator account plane) along with the per-Installation
 * OIDC client issuance flow.
 */
import { registerShape, type Shape } from "takosumi-contract";
import { WebServiceKind } from "./web-service.ts";
import { ObjectStoreKind } from "./object-store.ts";
import { DatabasePostgresKind } from "./database-postgres.ts";
import { CustomDomainKind } from "./custom-domain.ts";
import { WorkerKind } from "./worker.ts";

export {
  CustomDomainKind,
  DatabasePostgresKind,
  ObjectStoreKind,
  WebServiceKind,
  WorkerKind,
};

export type {
  CustomDomainCapability,
  CustomDomainCertificate,
  CustomDomainCertificateKind,
  CustomDomainOutputs,
  CustomDomainRedirect,
  CustomDomainSpec,
} from "./custom-domain.ts";
export type {
  DatabasePostgresBackups,
  DatabasePostgresCapability,
  DatabasePostgresOutputs,
  DatabasePostgresSize,
  DatabasePostgresSpec,
  DatabasePostgresStorage,
} from "./database-postgres.ts";
export type {
  ObjectStoreCapability,
  ObjectStoreLifecycle,
  ObjectStoreOutputs,
  ObjectStoreSpec,
} from "./object-store.ts";
export type {
  WebServiceCapability,
  WebServiceHealth,
  WebServiceOutputs,
  WebServiceResources,
  WebServiceScale,
  WebServiceSpec,
} from "./web-service.ts";
export type { WorkerCapability, WorkerOutputs, WorkerSpec } from "./worker.ts";

/**
 * The curated bundled catalog: the 4 kinds backed by JSON-LD in
 * `spec/contexts/kinds/v1/*.jsonld`. `WebServiceKind` is intentionally
 * excluded — it has no JSON-LD source and is only retained as a
 * provider-plugin backward-compat export.
 */
export const TAKOSUMI_BUNDLED_KINDS: readonly Shape[] = [
  ObjectStoreKind as Shape,
  DatabasePostgresKind as Shape,
  CustomDomainKind as Shape,
  WorkerKind as Shape,
];

export function registerTakosumiKinds(): void {
  for (const kind of TAKOSUMI_BUNDLED_KINDS) {
    registerShape(kind);
  }
}
