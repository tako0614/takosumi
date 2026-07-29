import type { InstalledFormReference } from "./service-forms.ts";
import type { JsonObject } from "./types.ts";

/**
 * Format token of the portable standard-admission evidence document
 * (takoform standardform vocabulary). One flat format field names the
 * document; there is no Kubernetes-style apiVersion/kind envelope.
 */
export const STANDARD_FORM_ADMISSION_FORMAT =
  "takoform.standard-admission@v0" as const;

/** The one portable wire error code negative fixtures must expect. */
export const STANDARD_FORM_INVALID_ARGUMENT_ERROR_CODE =
  "invalid_argument" as const;

/** Package-validation stages of the takoform conformance fixture vocabulary. */
export type StandardFormFixtureStage = "config" | "attributes" | "outputs";

export interface StandardFormPositiveFixture {
  readonly name: string;
  readonly config: JsonObject;
  readonly attributes: JsonObject;
  readonly outputs: JsonObject;
}

export interface StandardFormNegativeFixture {
  readonly name: string;
  readonly stage: StandardFormFixtureStage;
  readonly input: JsonObject;
  /** Stable portable error code; free-form message matching is forbidden. */
  readonly expectedErrorCode: string;
}

export interface StandardFormConformanceProof {
  readonly subject: string;
  readonly runnerVersion: string;
  readonly identity: InstalledFormReference;
  readonly status: "passed";
  readonly positiveFixtures: readonly string[];
  readonly negativeFixtures: readonly string[];
  readonly evidenceDigest: string;
}

/**
 * Signed-package-adjacent, provider-neutral evidence consumed by admission.
 * It is data only and grants no Target, credential, package, or execution
 * authority.
 */
export interface StandardFormAdmissionEvidence {
  readonly format: typeof STANDARD_FORM_ADMISSION_FORMAT;
  readonly identity: InstalledFormReference;
  readonly classification: "portable-standard";
  readonly approvedSchemaDigest: string;
  readonly audit: {
    readonly lifecycle: {
      readonly create: true;
      readonly read: true;
      readonly update: true;
      readonly delete: true;
      readonly import: true;
      readonly observe: true;
      readonly refresh: true;
      readonly drift: true;
    };
    readonly immutability: {
      readonly reviewed: true;
      readonly fields: readonly string[];
    };
    readonly security: {
      readonly secretFreeDesiredState: true;
      readonly credentialBoundaryExternal: true;
      readonly dataOnlyPackage: true;
    };
    readonly interfaces: {
      readonly reviewed: true;
      readonly bindingAuthorityExternal: true;
      readonly secretFreeDocuments: true;
    };
  };
  readonly fixtures: {
    readonly positive: readonly StandardFormPositiveFixture[];
    readonly negative: readonly StandardFormNegativeFixture[];
  };
  readonly conformance: {
    readonly host: StandardFormConformanceProof;
    readonly provider: StandardFormConformanceProof;
  };
}

export interface StandardFormAdmissionResult {
  readonly admitted: boolean;
  readonly errors: readonly string[];
}
