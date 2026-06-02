/**
 * Legacy kind shape types — Wave N-A reference-only.
 *
 * Wave N-A deleted the curated 4-kind catalog under
 * `spec/contexts/kinds/v1/` along with the hand-written
 * `Shape<Spec, Outputs, Capability>` descriptors at
 * `packages/plugins/src/kinds/*.ts`. The Takosumi service no longer
 * knows about `worker / postgres / object-store / custom-domain` as
 * privileged kinds.
 *
 * The shape-providers tree under `packages/plugins/src/shape-providers/`
 * is **legacy code** that uses the older `ProviderPlugin` contract
 * (= `Provider<Spec, Outputs>` keyed by short-name shape id) — it
 * predates the namespace pub/sub `TakosumiPlugin` model and is retained
 * only for reference distribution backward-compat (= the
 * legacy provider packages under the pre-catalog provider naming model
 * packages still re-export factories from here). To unblock the Wave
 * N-A deletion, this file inlines the previously-imported spec /
 * outputs / capability type names so the shape-provider files keep
 * compiling without depending on the deleted kind shape descriptors.
 *
 * These types reproduce the deleted `*.generated.ts` schemas verbatim
 * — the goal is bytewise-equivalent surfaces for legacy callers, not
 * new API. Future waves will migrate the shape-provider tree to the
 * namespace pub/sub `TakosumiPlugin` contract (or remove it) and these
 * type stubs will go with it.
 *
 * Authority: service ships **no** built-in kinds. Operator-defined
 * kinds are the only authorized path forward.
 */

import type { Artifact } from "takosumi-contract";

// ──────────────────────────────────────────────
// object-store (= ex-`object-store.generated.ts`)
// ──────────────────────────────────────────────

export interface ObjectStoreLifecycle {
  readonly archiveAfterDays?: number;
  readonly expireAfterDays?: number;
}

export interface ObjectStoreSpec {
  readonly name: string;
  readonly lifecycle?: ObjectStoreLifecycle;
  readonly public?: boolean;
  readonly region?: string;
  readonly versioning?: boolean;
}

export interface ObjectStoreOutputs {
  readonly bucket: string;
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyRef: string;
  readonly secretKeyRef: string;
}

export type ObjectStoreCapability =
  | "versioning"
  | "presigned-urls"
  | "server-side-encryption"
  | "public-access"
  | "event-notifications"
  | "lifecycle-rules"
  | "multipart-upload";

// ──────────────────────────────────────────────
// database-postgres (= ex-`database-postgres.generated.ts`)
// ──────────────────────────────────────────────

export interface DatabasePostgresBackups {
  readonly enabled: boolean;
  readonly retentionDays?: number;
}

export interface DatabasePostgresStorage {
  readonly sizeGiB: number;
  readonly type?: "ssd" | "hdd";
}

export type DatabasePostgresSize = "small" | "medium" | "large" | "xlarge";

export interface DatabasePostgresSpec {
  readonly size: DatabasePostgresSize;
  readonly version: string;
  readonly backups?: DatabasePostgresBackups;
  readonly extensions?: readonly string[];
  readonly highAvailability?: boolean;
  readonly storage?: DatabasePostgresStorage;
}

export interface DatabasePostgresOutputs {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly passwordSecretRef: string;
  readonly connectionString: string;
}

export type DatabasePostgresCapability =
  | "pitr"
  | "read-replicas"
  | "high-availability"
  | "backups"
  | "ssl-required"
  | "ipv6"
  | "extensions";

// ──────────────────────────────────────────────
// custom-domain (= ex-`custom-domain.generated.ts`)
// ──────────────────────────────────────────────

export type CustomDomainCertificateKind = "auto" | "managed" | "provided";

export interface CustomDomainCertificate {
  readonly kind: CustomDomainCertificateKind;
  readonly secretRef?: string;
}

export interface CustomDomainRedirect {
  readonly from: string;
  readonly to: string;
  readonly code?: 301 | 302 | 307 | 308;
}

export interface CustomDomainSpec {
  readonly name: string;
  readonly certificate?: CustomDomainCertificate;
  readonly redirects?: readonly CustomDomainRedirect[];
}

export interface CustomDomainOutputs {
  readonly fqdn: string;
  readonly certificateId?: string;
  readonly nameservers?: readonly string[];
}

export type CustomDomainCapability =
  | "wildcard"
  | "auto-tls"
  | "sni"
  | "http3"
  | "alpn-acme"
  | "redirects";

// ──────────────────────────────────────────────
// worker (= ex-`worker.generated.ts`)
// ──────────────────────────────────────────────

export interface WorkerSpec {
  readonly artifact: Artifact;
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface WorkerOutputs {
  readonly url: string;
  readonly id: string;
  readonly version?: string;
}

export type WorkerCapability =
  | "scale-to-zero"
  | "always-on"
  | "websocket"
  | "long-request"
  | "sticky-session"
  | "private-networking"
  | "geo-routing"
  | "crons";

// ──────────────────────────────────────────────
// web-service (= ex-`web-service.ts`, no JSON-LD source even pre-N-A;
// legacy backward-compat shape kept because shape-providers still use
// it).
// ──────────────────────────────────────────────

export type WebServiceCapability =
  | "always-on"
  | "scale-to-zero"
  | "websocket"
  | "long-request"
  | "sticky-session"
  | "geo-routing"
  | "crons"
  | "private-networking";

export interface WebServiceScale {
  readonly min: number;
  readonly max: number;
  readonly idleSeconds?: number;
}

export interface WebServiceHealth {
  readonly path: string;
  readonly intervalSeconds?: number;
  readonly timeoutSeconds?: number;
}

export interface WebServiceResources {
  readonly cpu?: string;
  readonly memory?: string;
}

export interface WebServiceSpec {
  readonly image?: string;
  readonly artifact?: Artifact;
  readonly port: number;
  readonly scale: WebServiceScale;
  readonly env?: Readonly<Record<string, string>>;
  readonly bindings?: Readonly<Record<string, string>>;
  readonly health?: WebServiceHealth;
  readonly resources?: WebServiceResources;
  readonly command?: readonly string[];
  readonly domains?: readonly string[];
}

export interface WebServiceOutputs {
  readonly url: string;
  readonly internalHost: string;
  readonly internalPort: number;
}
