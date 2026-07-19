import type {
  FormActivation,
  FormDefinition,
  FormPackage,
  FormRef,
  InstalledFormReference,
  JsonObject,
} from "takosumi-contract";

export type FormDefinitionRecord = FormDefinition;
export type FormPackageRecord = FormPackage;
export type FormActivationRecord = FormActivation;

/** Definition returned only after an injected package verifier accepted it. */
export interface VerifiedFormDefinition {
  readonly formRef: FormRef;
  readonly displayName?: string;
  readonly description?: string;
  readonly operations: FormDefinition["operations"];
  readonly metadata?: JsonObject;
  readonly interfaceDescriptors?: FormDefinition["interfaceDescriptors"];
}

/** Verifier-neutral result for one immutable, data-only package. */
export interface VerifiedFormPackage {
  readonly packageDigest: string;
  readonly definitions: readonly VerifiedFormDefinition[];
}

export interface FormPackageInstallRequest {
  readonly artifactRef: string;
  readonly expectedPackageDigest: string;
  readonly actorId: string;
}

export interface CreateFormActivationRequest {
  readonly id: string;
  readonly identity: InstalledFormReference;
  readonly scope: FormActivation["scope"];
  readonly audience?: FormActivation["audience"];
  readonly policy?: JsonObject;
  readonly eligibleTargetPoolClasses?: readonly string[];
  readonly status?: FormActivation["status"];
  readonly actorId: string;
}

export interface UpdateFormActivationRequest {
  readonly id: string;
  readonly expectedRevision: number;
  readonly audience?: FormActivation["audience"];
  readonly policy?: JsonObject;
  readonly eligibleTargetPoolClasses?: readonly string[];
  readonly status?: FormActivation["status"];
  readonly actorId: string;
}
