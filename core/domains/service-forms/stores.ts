import type {
  FormPackageLifecycleStatus,
  FormRef,
  Page,
  PageParams,
} from "takosumi-contract";
import type {
  FormActivationRecord,
  FormDefinitionRecord,
  FormPackageRecord,
} from "./records.ts";

export type InstallFormPackageResult =
  | {
      readonly status: "installed" | "already_installed";
      readonly package: FormPackageRecord;
    }
  | {
      readonly status: "conflict";
      readonly reason: "package_digest_conflict" | "form_ref_conflict";
    };

export type CreateFormActivationResult =
  | { readonly status: "created"; readonly activation: FormActivationRecord }
  | { readonly status: "conflict"; readonly activation: FormActivationRecord };

export type UpdateFormActivationResult =
  | { readonly status: "updated"; readonly activation: FormActivationRecord }
  | { readonly status: "not_found" }
  | { readonly status: "conflict"; readonly activation: FormActivationRecord };

export type UpdateFormPackageStatusResult =
  | { readonly status: "updated"; readonly package: FormPackageRecord }
  | { readonly status: "not_found" }
  | {
      readonly status: "invalid_transition";
      readonly package: FormPackageRecord;
    };

export interface FormRegistryStore {
  installPackage(
    packageRecord: FormPackageRecord,
    definitions: readonly FormDefinitionRecord[],
  ): Promise<InstallFormPackageResult>;
  getPackage(packageDigest: string): Promise<FormPackageRecord | undefined>;
  /**
   * Reads a bounded set of immutable package records in caller order.
   * Duplicate digests remain duplicated while unknown digests are omitted.
   * Durable adapters implement this as one physical query so a Form page does
   * not become an N+1 package read.
   */
  getPackages(
    packageDigests: readonly string[],
  ): Promise<readonly FormPackageRecord[]>;
  listPackages(params: PageParams): Promise<Page<FormPackageRecord>>;
  updatePackageStatus(
    packageDigest: string,
    status: FormPackageLifecycleStatus,
    updatedAt: string,
  ): Promise<UpdateFormPackageStatusResult>;
  getDefinition(formRef: FormRef): Promise<FormDefinitionRecord | undefined>;
  listDefinitions(params: PageParams): Promise<Page<FormDefinitionRecord>>;
  createActivation(
    activation: FormActivationRecord,
  ): Promise<CreateFormActivationResult>;
  getActivation(id: string): Promise<FormActivationRecord | undefined>;
  /**
   * Reads activation evidence for a bounded set of exact FormRefs in one
   * durable query. Results are ordered by updatedAt/id and capped at the same
   * 10,000-record fail-closed discovery ceiling as the legacy page walk.
   */
  getActivationsForForms(
    formRefs: readonly FormRef[],
  ): Promise<readonly FormActivationRecord[]>;
  listActivations(params: PageParams): Promise<Page<FormActivationRecord>>;
  updateActivation(
    activation: FormActivationRecord,
    expectedRevision: number,
  ): Promise<UpdateFormActivationResult>;
}

export interface FormPackageArtifactReader {
  read(artifactRef: string): Promise<Uint8Array>;
}

/**
 * Injected package-format authority. Core provides opaque bytes and an exact
 * expected digest; the verifier must reject digest mismatch, executable
 * content, invalid signatures, ambiguous definitions, and invalid schemas.
 */
export interface FormPackageVerifier {
  readonly id: string;
  verify(
    bytes: Uint8Array,
    expectedPackageDigest: string,
  ): Promise<import("./records.ts").VerifiedFormPackage>;
}
