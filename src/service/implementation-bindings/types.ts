/**
 * Service-internal re-exports for the canonical `OperatorImplementation` contract.
 *
 * The contract itself lives in `@takosjp/takosumi/contract/reference/implementation`. This
 * shim keeps existing service imports stable and adds the service-internal
 * `OperatorImplementationRegistry` interface used by `DeployControlPipeline`.
 */
export type {
  OperatorImplementation,
  OperatorImplementationApplyContext,
  OperatorImplementationApplyResult,
  OperatorImplementationDeploymentContext,
  OperatorImplementationDestroyContext,
  OperatorImplementationInstallationContext,
} from "takosumi-contract/reference/implementation";
import type { OperatorImplementation } from "takosumi-contract/reference/implementation";

export interface OperatorImplementationRegistry {
  /** All registered implementations, in registration order. */
  list(): readonly OperatorImplementation[];
  /**
   * Find the implementation that advertises `provides[]` containing `kindUri`.
   * Returns `undefined` if no implementation claims the kind. The first registered
   * implementation wins on conflict; the registry refuses conflicting registration
   * at construction time.
   *
   * Takosumi v1 does not expand short aliases: operators pass the URI or opaque
   * reference they want resolved, and lookup is an exact match against
   * `provides[]`.
   */
  findByKindUri(kindUri: string): OperatorImplementation | undefined;
  /** Lookup by `name`. Returns `undefined` if not registered. */
  getByName(name: string): OperatorImplementation | undefined;
}
