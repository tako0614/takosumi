/**
 * Service-internal re-exports for the canonical `OperatorImplementation` contract.
 *
 * The contract itself lives in `@takosjp/takosumi/contract/reference/implementation`. This
 * shim keeps existing service imports stable and adds the service-internal
 * `OperatorImplementationRegistry` interface used by `InstallerPipeline`.
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
   */
  findByKindUri(kindUri: string): OperatorImplementation | undefined;
  /**
   * Find an implementation by the exact operator-selected kind reference. Takosumi
   * does not expand short aliases; operators pass the URI or opaque reference
   * they want the implementation registry to resolve.
   */
  findByKindRef(kind: string): OperatorImplementation | undefined;
  /** Lookup by `name`. Returns `undefined` if not registered. */
  getByName(name: string): OperatorImplementation | undefined;
}
