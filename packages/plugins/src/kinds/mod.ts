/**
 * Bundled component kind catalog (`worker / postgres / object-store /
 * custom-domain`).
 *
 * Each kind exports a `*Kind` descriptor; the v1 AppSpec installer
 * pipeline materializes components through provider plugins keyed off
 * `Component.kind`.
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

export const TAKOSUMI_BUNDLED_KINDS: readonly Shape[] = [
  WebServiceKind as Shape,
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
