import type { JsonValue } from "takosumi-contract";
import type { Capsule } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { ResolvedCapsuleProviderBinding } from "../connections/mod.ts";

/**
 * Private host port for deterministic, non-secret Capsule module variables.
 *
 * Core supplies only canonical ledger records and already-resolved Provider
 * Bindings. A host implementation must re-read its authority before returning
 * values. Plan persists the returned digest in the private run-input sidecar;
 * Apply supplies it back as expectedDigest so drift is rejected before any
 * host mutation or runner dispatch.
 */

export interface CapsuleModuleVariableMaterialization {
  readonly variables: Readonly<Record<string, JsonValue>>;
  readonly digest: string;
}

export interface CapsuleModuleVariableMaterializerInput {
  /** Plan and Apply admission are read-only; only Apply may mutate Accounts. */
  readonly phase: "plan" | "apply_check" | "apply";
  /**
   * Present for the final pre-digest Plan re-read and every Apply revalidation;
   * the host must reject drift before mutating its Accounts ledger.
   */
  readonly expectedDigest?: string;
  /**
   * Exact four non-secret values captured in the reviewed Plan sidecar.
   * Required during Apply admission and the final pre-dispatch Apply commit.
   */
  readonly plannedVariables?: Readonly<Record<string, JsonValue>>;
  readonly capsule: Capsule;
  readonly installConfig: InstallConfig;
  readonly resolvedProviderBindings: readonly ResolvedCapsuleProviderBinding[];
  /**
   * Narrow non-secret projection after explicit values/provider defaults merge:
   * only the declared source names and additional public metadata. Arbitrary
   * module variables and every credential/secret stay outside this port.
   */
  readonly variables: Readonly<Record<string, JsonValue>>;
}

/**
 * Exact reviewed authority supplied only after provider destroy and the
 * Capsule's terminal ledger transition have committed durably. Retirement is
 * idempotent host cleanup; it must never register or recreate runtime identity.
 */
export type CapsuleModuleVariableRetirementInput = Omit<
  CapsuleModuleVariableMaterializerInput,
  "phase" | "expectedDigest" | "plannedVariables"
> & {
  readonly expectedDigest: string;
  readonly plannedVariables: Readonly<Record<string, JsonValue>>;
};

export interface CapsuleModuleVariableMaterializer {
  materialize(
    input: CapsuleModuleVariableMaterializerInput,
  ): Promise<CapsuleModuleVariableMaterialization | undefined>;
  /**
   * Best-effort terminal cleanup invoked after Core's durable destroy commit.
   * Hosts must re-read current authority and revoke only their exact DB-owned
   * identity. Absence is success; failure cannot roll a destroyed Capsule back.
   */
  retire(input: CapsuleModuleVariableRetirementInput): Promise<void>;
}
