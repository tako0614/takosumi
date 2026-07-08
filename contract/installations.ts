/**
 * Compatibility subpath for older imports.
 *
 * Capsule ledger records live in `./capsules.ts`; InstallConfig lives in
 * `./install-configs.ts`. This file intentionally owns no duplicate schema.
 */

export * from "./install-configs.ts";

/** @deprecated use `Capsule` from `./capsules.ts`. */
export type { Capsule as Installation } from "./capsules.ts";
/** @deprecated use `PublicCapsule` from `./capsules.ts`. */
export type { PublicCapsule as PublicInstallation } from "./capsules.ts";
/** @deprecated use `CapsuleStatus` from `./capsules.ts`. */
export type { CapsuleStatus as InstallationStatus } from "./capsules.ts";

/** @deprecated use the `CapsuleProviderEnvBinding*` names. */
export type {
  CapsuleProviderEnvBinding as InstallationProviderEnvBinding,
  CapsuleProviderEnvBindings as InstallationProviderEnvBindings,
  CapsuleProviderEnvBindingSet as InstallationProviderEnvBindingSet,
} from "./connections.ts";
